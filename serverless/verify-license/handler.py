"""
Serverless license verification function.

Deploy to AWS Lambda or Alibaba Cloud Function Compute (FC).
Both platforms deliver events with similar JSON bodies; set FC_COMPAT=true
for Alibaba FC format.

This single function serves several routes on the same Function URL,
dispatched by request path — no API Gateway needed:

  POST /                 licence verification (default route; see handler())
  POST /stripe-webhook   Stripe webhook listener — issues a license key onto
                          a subscription's metadata when checkout completes
                          (legacy manual-key flow), AND — for orders created
                          via /create-order — extends the paying user's
                          license directly (Ticket 28).
  POST /create-order     Ticket 28: create a payment order for one of
                          card | wechat_pay | alipay | douyin_pay and return
                          a URL for the app to open (see PaymentMethod in
                          src/main/license-config.ts).
  GET  /order-status      Ticket 28: poll an order; once paid, returns the
                          signed license token so the app can unlock without
                          restarting.
  GET  /payment-history   Ticket 28: list an anonymous user's past orders.
  POST /douyin-webhook    Ticket 28: Douyin Pay payment-result callback.
  GET  /payment-methods   Ticket 31: list only the payment methods that are
                          actually usable right now (provider credentials
                          configured AND not force-disabled) — the client
                          must never be offered a method that would just
                          fail at checkout. See _available_payment_methods().
  POST /trial/activate    Ticket 33: idempotently create (or fetch) the
                          free trial for a device (3 days — Ticket 42). Never
                          resets an existing trial's start/end.
  GET  /trial/status      Ticket 33: look up a device's trial record.
  GET  /plans             Ticket 34: list the four billing-period plans
                          (monthly/quarterly/semi_annual/annual) with their
                          computed prices/discounts, so the client never has
                          to hardcode amounts. See _build_plans().

Environment variables
---------------------
LICENSE_SIGNING_SECRET  HMAC signing secret (must match Electron app)
MOCK_MODE               'true' → accept any key (CI / demo use only)
PAYMENT_PROVIDER        'stripe' | 'lemonsqueezy' | 'custom' (default)
STRIPE_API_KEY          required when PAYMENT_PROVIDER=stripe, or to accept
                        card / wechat_pay / alipay orders via /create-order
                        (Ticket 28 routes these through Stripe Checkout —
                        WeChat Pay / Alipay must be enabled for the Stripe
                        account first; see Stripe Dashboard → Payment methods)
STRIPE_WEBHOOK_SECRET   required to accept POST /stripe-webhook (Stripe
                        Dashboard → Webhooks → signing secret, "whsec_...")
LEMON_API_KEY           required when PAYMENT_PROVIDER=lemonsqueezy
SES_SENDER_EMAIL        verified SES sender address; emails the newly-issued
                        key to the customer after checkout. Unset → email
                        delivery is skipped (the key still lands in Stripe
                        metadata either way — see _handle_checkout_completed).
                        Uses boto3, which ships preinstalled in the AWS Lambda
                        Python runtime; no requirements.txt needed on AWS.
SES_REGION              defaults to the function's own AWS_REGION
ORDERS_TABLE            DynamoDB table name for payment orders (Ticket 28).
                        /create-order, /order-status, /payment-history, and
                        both webhooks 501 until this is set.
LICENSES_TABLE          DynamoDB table name mapping anonymous userId →
                        current license token (Ticket 28 auto-issuance path;
                        independent of the legacy Stripe-metadata lookup).
PAYMENT_SUCCESS_URL     Stripe Checkout success_url base (Ticket 28); the app
                        never actually loads this page — see order-status
                        polling — but Stripe requires a valid URL.
PAYMENT_CANCEL_URL      Stripe Checkout cancel_url base (Ticket 28).
DOUYIN_APP_ID           Douyin Open Platform app ID (Ticket 28).
DOUYIN_MERCHANT_ID      Douyin Pay merchant ID (抖音支付商户号).
DOUYIN_APP_SECRET       Douyin Pay signing secret — used for both request
                        signing and notification verification. NOTE: confirm
                        the exact signing algorithm (HMAC-SHA256 vs the
                        legacy MD5 scheme) and endpoint paths against the
                        current 抖音开放平台/精选联盟-支付 docs for your
                        merchant type before going live; this template
                        implements the widely-documented ecpay-style scheme.
DOUYIN_NOTIFY_URL       Overrides the auto-derived Douyin callback URL.
DISABLED_PAYMENT_METHODS
                        Ticket 31: comma-separated method ids to force-hide
                        from /payment-methods even if their provider
                        credentials are configured — e.g. "douyin_pay" while
                        the Douyin merchant business-verification is still
                        pending. Example: "douyin_pay,card".
TRIALS_TABLE            Ticket 33: DynamoDB table name for free trial
                        records, keyed by deviceId. /trial/activate and
                        /trial/status 501 until this is set.
TRIAL_DAYS              Ticket 33: trial length in days. Defaults to 3
                        (Ticket 42 — was 7). Existing trial records longer
                        than this are truncated to TRIAL_DAYS from their
                        original trialStart the next time they're read, as
                        long as they haven't already expired — see
                        _apply_trial_duration_cap().
BASE_MONTHLY_PRICE      Ticket 34/36: base monthly subscription price (major
                        currency units, e.g. "99"). Quarterly/semi-annual/
                        annual plans apply a discount on top of this — see
                        _build_plans(). Defaults to "99" (RMB, Ticket 36).
PLAN_CURRENCY           Ticket 34: ISO 4217 currency code (lowercase) for the
                        computed plans, e.g. "usd" or "cny". Defaults to "cny"
                        (Ticket 36).
USD_EXCHANGE_RATE       Ticket 36: fixed CNY→USD rate used only to compute the
                        `priceUSD` display field on GET /plans for the
                        English UI — actual payment is always processed in
                        PLAN_CURRENCY. Defaults to "7.0".

Swap provider logic in _check_payment_provider() to change monetisation
without touching any other code.
"""
import base64
import decimal
import hashlib
import hmac
import json
import os
import re
import sys
import time
from typing import Any

# ── Configuration ─────────────────────────────────────────────────────────────

_DEFAULT_SIGNING_SECRET = "ruanjian-dev-signing-secret-v1-change-in-production"

SIGNING_SECRET  = os.environ.get("LICENSE_SIGNING_SECRET", _DEFAULT_SIGNING_SECRET)
MOCK_MODE       = os.environ.get("MOCK_MODE", "false").lower() == "true"
PROVIDER        = os.environ.get("PAYMENT_PROVIDER", "custom")
EXPIRY_DAYS     = int(os.environ.get("EXPIRY_DAYS", "30"))
TRIAL_DAYS      = int(os.environ.get("TRIAL_DAYS", "3"))  # Ticket 33 (was 7 — Ticket 42)

# This string is public (it ships in the Electron app's source at
# src/main/license-config.ts), so a real deployment still using it means
# anyone can forge a valid license token offline. MOCK_MODE is exempt since
# it's explicitly CI/demo-only and doesn't gate real payments.
if SIGNING_SECRET == _DEFAULT_SIGNING_SECRET and not MOCK_MODE:
    print(
        "SECURITY WARNING: LICENSE_SIGNING_SECRET is not set — this function "
        "is signing tokens with the public template default from handler.py. "
        "License tokens can be forged offline. Set LICENSE_SIGNING_SECRET to "
        "a private value (and update the Electron app's LICENSE_SIGNING_SECRET "
        "to match) before accepting real payments.",
        file=sys.stderr,
    )
ALLOWED_FEATURES = ["training", "synthesis", "separation", "cover"]

# ── Multi-period plans (Ticket 34) ──────────────────────────────────────────
# One configurable base monthly price; quarterly/semi-annual/annual apply a
# market-standard discount on top of `months * base`. This is the source of
# truth for pricing — GET /plans (see _handle_get_plans) exposes it so the
# client never hardcodes amounts (src/main/license-config.ts keeps its own
# copy of this formula only as an offline fallback — keep the two in sync).
def _parse_positive_float(raw: str, env_name: str, default: float) -> float:
    """A malformed numeric env var must not crash the whole function at
    import time — every route (license verify, orders, trials, ...) shares
    this module, so an unhandled ValueError here would 500 all of them, not
    just /plans. Falls back to the default and lets _build_plans() proceed;
    the bad value is still visible in CloudWatch via the stderr warning."""
    try:
        value = float(raw)
        if value <= 0:
            raise ValueError(raw)
        return value
    except ValueError:
        print(f"{env_name}={raw!r} is not a valid positive number; falling back to {default}", file=sys.stderr)
        return default


# Ticket 36: base price switched from USD 9.99 to RMB 99/month; discounts
# switched from 10/20/30% to 5/10/15%. USD_EXCHANGE_RATE only drives the
# priceUSD *display* field below — payment is always taken in PLAN_CURRENCY.
BASE_MONTHLY_PRICE = _parse_positive_float(os.environ.get("BASE_MONTHLY_PRICE", "99"), "BASE_MONTHLY_PRICE", 99.0)
PLAN_CURRENCY      = os.environ.get("PLAN_CURRENCY", "cny").lower()
USD_EXCHANGE_RATE  = _parse_positive_float(os.environ.get("USD_EXCHANGE_RATE", "7.0"), "USD_EXCHANGE_RATE", 7.0)

# (planId, period, durationDays, months, discountPercent)
_PLAN_TIERS: list[tuple[str, str, int, float, int]] = [
    ("monthly",     "month",     30,  1,  0),
    ("quarterly",   "quarter",   90,  3,  5),
    ("semi_annual", "half_year", 180, 6,  10),
    ("annual",      "year",      365, 12, 15),
]


def _round_half_up(value: decimal.Decimal, quantum: decimal.Decimal) -> float:
    return float(value.quantize(quantum, rounding=decimal.ROUND_HALF_UP))


def _plan_price(months: float, discount_percent: int) -> float:
    """Total price for `months` of service at `discount_percent` off the
    per-month base rate (Ticket 34 §1 / Ticket 36 §2). Uses Decimal rather
    than float — float's binary rounding can land a result on the wrong side
    of the rounding boundary (round-half-down instead of the expected
    round-half-up), which for money is a real discrepancy, not a cosmetic
    one. RMB plans round to whole yuan (Ticket 36: "取整到元"); any other
    configured currency keeps 2-decimal (cents) rounding."""
    raw = decimal.Decimal(str(BASE_MONTHLY_PRICE)) * decimal.Decimal(months) * (1 - decimal.Decimal(discount_percent) / 100)
    quantum = decimal.Decimal("1") if PLAN_CURRENCY == "cny" else decimal.Decimal("0.01")
    return _round_half_up(raw, quantum)


def _plan_price_usd(price_major_units: float) -> int:
    """USD-equivalent of an already-rounded PLAN_CURRENCY price, for display
    on the English UI only (Ticket 36 §2/§4) — rounded to the nearest whole
    dollar. Actual payment is still processed in PLAN_CURRENCY; the client
    must never use this for anything but display."""
    raw = decimal.Decimal(str(price_major_units)) / decimal.Decimal(str(USD_EXCHANGE_RATE))
    return int(_round_half_up(raw, decimal.Decimal("1")))


def _build_plans() -> dict[str, dict[str, Any]]:
    plans: dict[str, dict[str, Any]] = {}
    for plan_id, period, duration_days, months, discount in _PLAN_TIERS:
        price = _plan_price(months, discount)
        # Pre-discount reference total (0% off the same `months`), for the
        # client's strikethrough "original price". Computed the same
        # single-rounding-step way as `price`/`priceUSD` rather than left for
        # the client to reconstruct by multiplying the monthly plan's own
        # (already-rounded) unit price by `months` — that would compound two
        # roundings and could drift a dollar or two from the discount% badge
        # for the longer plans (e.g. annual: 12 × round(99/7) = $168, vs the
        # correct round(1188/7) = $170).
        original_price = _plan_price(months, 0)
        plans[plan_id] = {
            "period":           period,
            "durationDays":     duration_days,
            "discountPercent":  discount,
            "price":            price,                          # major units (e.g. yuan) — display/reference
            "priceUSD":         _plan_price_usd(price),          # display-only USD equivalent (Ticket 36)
            "originalPrice":    original_price,                  # pre-discount reference total, same currency as `price`
            "originalPriceUSD": _plan_price_usd(original_price), # display-only USD equivalent of originalPrice
            "amount":           round(price * 100),              # minor units — what payment providers charge
            "currency":         PLAN_CURRENCY,
        }
    return plans


# Keep the formula above in sync with PLANS in src/main/license-config.ts
# (that copy is an offline fallback only — this is the real source of truth).
PLANS: dict[str, dict[str, Any]] = _build_plans()
PAYMENT_METHODS = {"wechat_pay", "alipay", "douyin_pay", "card"}

# Ticket 31: methods force-hidden regardless of provider config — see the
# DISABLED_PAYMENT_METHODS env var doc above.
_DISABLED_PAYMENT_METHODS = {
    m.strip() for m in os.environ.get("DISABLED_PAYMENT_METHODS", "").split(",") if m.strip()
}


def _available_payment_methods() -> list[str]:
    """Payment method ids that are actually usable right now, so the client
    never has to render (or the user never has to hit) a method that would
    just fail at checkout. A method is available only when its provider
    credentials are configured AND it isn't force-disabled.

    card / wechat_pay / alipay all go through Stripe Checkout (see
    _create_stripe_order) so they share one credential — STRIPE_API_KEY —
    but note that doesn't guarantee WeChat Pay / Alipay are individually
    enabled on the Stripe account; if a specific one isn't, disable it via
    DISABLED_PAYMENT_METHODS until it's turned on in the Stripe Dashboard.
    douyin_pay needs its own three Douyin credentials (Ticket 28 background:
    Douyin Pay may require additional business verification)."""
    methods: list[str] = []
    if os.environ.get("STRIPE_API_KEY"):
        methods.extend(["card", "wechat_pay", "alipay"])
    if os.environ.get("DOUYIN_APP_ID") and os.environ.get("DOUYIN_MERCHANT_ID") and os.environ.get("DOUYIN_APP_SECRET"):
        methods.append("douyin_pay")
    return [m for m in methods if m in PAYMENT_METHODS and m not in _DISABLED_PAYMENT_METHODS]


# Ticket 31: display metadata for /payment-methods, owned here instead of
# duplicated in the Electron client's i18n/badge maps (src/renderer/src/
# i18n.ts's subscription.method.*, SubscriptionView.tsx's METHOD_BADGE) —
# this is now the source of truth for the *picker*. The client keeps its own
# copies too, but only as a display fallback and for rendering historical
# orders whose method may no longer be in the currently-available set (a
# past Douyin order must still show a readable label after Douyin gets
# disabled). "color" is omitted for card on purpose — the client renders
# that one in the app's current theme accent color instead of a fixed hex.
_METHOD_META: dict[str, dict[str, Any]] = {
    "wechat_pay": {"name": {"zh-CN": "微信支付", "en-US": "WeChat Pay"}, "icon": "微", "color": "#07c160"},
    "alipay":     {"name": {"zh-CN": "支付宝",   "en-US": "Alipay"},     "icon": "支", "color": "#1677ff"},
    "douyin_pay": {"name": {"zh-CN": "抖音支付", "en-US": "Douyin Pay"}, "icon": "抖", "color": "#000000"},
    "card":       {"name": {"zh-CN": "银行卡",   "en-US": "Bank Card"},  "icon": "💳"},
}
_DEFAULT_LANG = "zh-CN"


def _localized_method(method_id: str, lang: str) -> dict[str, Any]:
    meta  = _METHOD_META.get(method_id, {})
    names = meta.get("name", {})
    return {
        "id":      method_id,
        "enabled": True,
        "name":    names.get(lang) or names.get(_DEFAULT_LANG) or method_id,
        "icon":    meta.get("icon", ""),
        "color":   meta.get("color"),  # absent (None) → client falls back to var(--accent)
    }


# ── Token helpers ─────────────────────────────────────────────────────────────

def _b64url(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).rstrip(b"=").decode()


def _sign(data: str) -> str:
    return hmac.new(SIGNING_SECRET.encode(), data.encode(), hashlib.sha256).hexdigest()


def create_token(user_id: str, plan_id: str, license_key: str, expires_at: int | None = None) -> str:
    """expires_at: Unix seconds. Defaults to now + EXPIRY_DAYS (legacy verify-key flow);
    the Ticket 28 order flow passes an explicit value so renewals correctly
    extend from the *current* expiry rather than always restarting the clock."""
    header  = _b64url(json.dumps({"alg": "HS256", "typ": "LICENSE"}))
    payload = _b64url(json.dumps({
        "userId":     user_id,
        "planId":     plan_id,
        "licenseKey": license_key,
        "expiresAt":  expires_at if expires_at is not None else int(time.time()) + EXPIRY_DAYS * 86400,
        "issuedAt":   int(time.time()),
        "features":   ALLOWED_FEATURES,
    }))
    sig = _sign(f"{header}.{payload}")
    return f"{header}.{payload}.{sig}"


# ── License key formatting / safety ─────────────────────────────────────────────
# License keys reach this function as untrusted, attacker-controlled HTTP input
# (anyone can POST to the Function URL), and _check_stripe() below interpolates
# the key into a Stripe *search query string* — so it must be validated before
# ever being used, not just escaped.

_LICENSE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _valid_license_key_format(license_key: str) -> bool:
    return bool(_LICENSE_KEY_RE.match(license_key))


# Ticket 33: device ids are either a SHA-256 hex digest (64 chars) or a
# fallback UUID (36 chars, hyphenated) generated client-side — see
# src/main/device-id.ts. Same untrusted-input reasoning as license keys
# above: this reaches DynamoDB key operations, so validate before use.
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def _valid_device_id_format(device_id: str) -> bool:
    return bool(_DEVICE_ID_RE.match(device_id))


def _escape_search_value(value: str) -> str:
    """Escape a value for Stripe's search query language (single-quoted string)."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


# ── Provider verification (swap this block for a different provider) ──────────

def _check_payment_provider(license_key: str) -> dict[str, Any] | None:
    """
    Returns subscription info dict or None if the key is invalid/unpaid.
    Replace the body of this function to switch payment providers.
    """
    if MOCK_MODE:
        return {"userId": f"mock_{license_key[:8]}", "planId": "monthly", "active": True}

    if PROVIDER == "stripe":
        return _check_stripe(license_key)
    if PROVIDER == "lemonsqueezy":
        return _check_lemonsqueezy(license_key)
    # custom / fallback: treat all non-empty keys as valid for template purposes
    if license_key and len(license_key) >= 8:
        return {"userId": f"user_{hashlib.sha256(license_key.encode()).hexdigest()[:12]}",
                "planId": "monthly", "active": True}
    return None


def _check_stripe(license_key: str) -> dict | None:
    """
    Look up an active Stripe subscription carrying this license key in its
    metadata, via the Stripe Search API — the *only* Stripe endpoint that
    supports querying by custom metadata. (The plain List Subscriptions
    endpoint only filters by customer/price/status, not metadata; querying
    it with a metadata[...] param silently ignores the filter.)

    Requires metadata.license_key to already be set on the subscription,
    which happens automatically via the checkout.session.completed webhook
    — see _handle_checkout_completed() below.
    """
    if not _valid_license_key_format(license_key):
        return None

    import urllib.error, urllib.parse, urllib.request  # noqa: PLC0415
    api_key = os.environ["STRIPE_API_KEY"]
    query   = f"status:'active' AND metadata['license_key']:'{_escape_search_value(license_key)}'"
    url     = f"https://api.stripe.com/v1/subscriptions/search?query={urllib.parse.quote(query)}"
    req     = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.load(r)
    except urllib.error.HTTPError as exc:
        # 4xx → malformed/unknown key, not a server problem: treat as "not found"
        if exc.code < 500:
            return None
        raise

    if data.get("data"):
        sub = data["data"][0]
        return {"userId": sub["customer"], "planId": "monthly", "active": True}
    return None


def _check_lemonsqueezy(license_key: str) -> dict | None:
    """Validate a Lemon Squeezy license via the activation endpoint."""
    import urllib.request, urllib.parse  # noqa: PLC0415
    api_key  = os.environ["LEMON_API_KEY"]
    body     = urllib.parse.urlencode({"license_key": license_key}).encode()
    req      = urllib.request.Request(
        "https://api.lemonsqueezy.com/v1/licenses/validate",
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.load(r)
    if data.get("valid"):
        meta = data.get("meta", {})
        return {"userId": meta.get("store_id", "ls_user"), "planId": "monthly", "active": True}
    return None


# ── Order / license store (Ticket 28) ───────────────────────────────────────────
# A lightweight DynamoDB-backed store. Stateless/pay-per-use like the rest of
# this function — no fixed infrastructure. Every endpoint in this section
# degrades to a clear 501 (not a crash) when its table env var is unset, the
# same pattern SES_SENDER_EMAIL already uses above.

def _ddb_table(name: str):  # noqa: ANN201
    """Returns a boto3 DynamoDB Table resource, or None if unconfigured/unavailable."""
    if not name:
        return None
    try:
        import boto3  # noqa: PLC0415
    except ImportError:
        return None
    return boto3.resource("dynamodb").Table(name)


def _orders_table():  # noqa: ANN201
    return _ddb_table(os.environ.get("ORDERS_TABLE", ""))


def _licenses_table():  # noqa: ANN201
    return _ddb_table(os.environ.get("LICENSES_TABLE", ""))


def _not_configured(what: str) -> dict:
    return {"statusCode": 501, "headers": _cors_headers(),
            "body": json.dumps({"error": f"{what} is not configured on the server"})}


def _new_order_id() -> str:
    import secrets  # noqa: PLC0415
    return "ord_" + secrets.token_hex(12)


def _from_decimal(value: Any) -> Any:
    """Recursively converts DynamoDB's Decimal (what the boto3 *resource* API
    returns for every Number attribute) back to a plain int/float.

    Every read from ORDERS_TABLE/LICENSES_TABLE must be passed through this
    before the result is either (a) JSON-serialized — json.dumps() raises
    TypeError on a bare Decimal — or (b) used in arithmetic that feeds back
    into a new record, e.g. _issue_or_extend_license() extending expiresAt.
    Converting at the read boundary (here) means every caller downstream
    just sees ordinary numbers, instead of every call site needing its own
    Decimal-aware json.dumps(default=...).
    """
    if isinstance(value, decimal.Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _from_decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_from_decimal(v) for v in value]
    return value


def _put_order(order: dict[str, Any]) -> None:
    table = _orders_table()
    if table is None:
        return
    # Orders are only ever created once per orderId (we generate it), so a
    # plain put is fine here; the *transition* to paid below is what needs
    # the idempotency guard, since providers retry webhooks.
    table.put_item(Item=order)


def _get_order(order_id: str) -> dict[str, Any] | None:
    table = _orders_table()
    if table is None:
        return None
    resp = table.get_item(Key={"orderId": order_id})
    return _from_decimal(resp.get("Item"))


def _mark_order_paid(order_id: str, provider_txn_id: str) -> dict[str, Any] | None:
    """Idempotent: only the first call for a given order actually transitions
    it (and therefore extends the license) — later retries of the same
    provider webhook see the ConditionalCheckFailed and are treated as a
    no-op, satisfying Ticket 28 §5's idempotency requirement.

    Returns the updated order Attributes only when *this* call performed the
    transition; returns None both when the table is unconfigured and when
    the order was already paid (by an earlier call, possibly a concurrent
    one). Callers must treat None as "do not re-run license issuance" — the
    two None cases are handled identically by every current caller, so
    collapsing them here is safe, and it's what actually makes the
    idempotency guarantee hold: returning the already-paid order here (as
    this used to) reads as truthy to callers doing `if updated: issue(...)`,
    which extends the license a second time for one payment.
    """
    table = _orders_table()
    if table is None:
        return None
    try:
        resp = table.update_item(
            Key={"orderId": order_id},
            UpdateExpression="SET #s = :paid, paidAt = :now, providerTxnId = :txn",
            ConditionExpression="attribute_exists(orderId) AND #s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":paid": "paid", ":pending": "pending",
                ":now": int(time.time()), ":txn": provider_txn_id,
            },
            ReturnValues="ALL_NEW",
        )
        return _from_decimal(resp.get("Attributes"))
    except Exception as exc:  # noqa: BLE001
        # botocore raises ClientError with response['Error']['Code'] ==
        # 'ConditionalCheckFailedException' — meaning "already processed by
        # another call", not an error worth surfacing. The code only shows
        # up in str(exc), not the exception's class name, so check the
        # message.
        if "ConditionalCheckFailed" in str(exc):
            return None
        raise


def _settle_paid_order(order: dict[str, Any], provider_txn_id: str) -> None:
    """Transitions a pending order to paid and extends the user's license —
    the one sequence every payment-provider webhook needs to run, exactly
    once, on the first delivery of its "payment succeeded" event. Shared by
    every webhook handler so this idempotency-sensitive logic (and any
    future fix to it) lives in one place instead of being copy-pasted per
    provider."""
    if order["status"] != "pending":
        return
    updated = _mark_order_paid(order["orderId"], provider_txn_id)
    if updated:
        _issue_or_extend_license(order["userId"], order["planId"])


def _query_orders_by_user(user_id: str, limit: int = 50) -> list[dict[str, Any]]:
    table = _orders_table()
    if table is None:
        return []
    resp = table.query(
        IndexName="userId-createdAt-index",
        KeyConditionExpression="userId = :u",
        ExpressionAttributeValues={":u": user_id},
        ScanIndexForward=False,
        Limit=limit,
    )
    return [_from_decimal(item) for item in resp.get("Items", [])]


def _get_license_row(user_id: str) -> dict[str, Any] | None:
    table = _licenses_table()
    if table is None:
        return None
    resp = table.get_item(Key={"userId": user_id})
    return _from_decimal(resp.get("Item"))


def _issue_or_extend_license(user_id: str, plan_id: str) -> tuple[str, int]:
    """Extends from the user's current expiry if it's still in the future
    (renewal before lapse stacks, matching Ticket 28 §4), otherwise starts
    fresh from now. Returns (token, expiresAt)."""
    plan = PLANS.get(plan_id, PLANS["monthly"])
    now  = int(time.time())

    existing   = _get_license_row(user_id)
    base       = existing["expiresAt"] if existing and existing.get("expiresAt", 0) > now else now
    expires_at = base + plan["durationDays"] * 86400

    license_key = _generate_license_key()
    token = create_token(user_id, plan_id, license_key, expires_at=expires_at)

    table = _licenses_table()
    if table is not None:
        table.put_item(Item={
            "userId": user_id, "token": token, "planId": plan_id,
            "licenseKey": license_key, "expiresAt": expires_at, "updatedAt": now,
        })
    return token, expires_at


# ── Trial store (Ticket 33) ─────────────────────────────────────────────────
# Deliberately separate from _orders_table()/_licenses_table() above: a trial
# has no payment and no signed license token, and its idempotency contract is
# simpler — "first activation wins, every later call just reads it back" —
# so it gets its own tiny table and its own conditional-put guard rather than
# reusing _mark_order_paid's pending→paid transition.

def _trials_table():  # noqa: ANN201
    return _ddb_table(os.environ.get("TRIALS_TABLE", ""))


def _apply_trial_duration_cap(trial: dict[str, Any]) -> dict[str, Any]:
    """Ticket 42 migration: a trial record created back when TRIAL_DAYS was 7
    (or any value longer than the current TRIAL_DAYS) must not keep granting
    the old, longer duration just because it predates the config change. If
    the record is still active (hasn't already lapsed under its *stored*
    trialEnd) and spans more than TRIAL_DAYS from its original trialStart,
    truncate trialEnd down to trialStart + TRIAL_DAYS. A trial that's already
    expired is left alone — it reads as expired either way, so there's
    nothing to correct. Idempotent: a record already within the cap is
    returned unchanged and no write happens."""
    now       = int(time.time())
    capped_end = trial["trialStart"] + TRIAL_DAYS * 86400
    if trial["trialEnd"] <= capped_end or now >= trial["trialEnd"]:
        return trial

    table = _trials_table()
    if table is not None:
        try:
            table.update_item(
                Key={"deviceId": trial["deviceId"]},
                UpdateExpression="SET trialEnd = :capped",
                ExpressionAttributeValues={":capped": capped_end},
            )
        except Exception:  # noqa: BLE001
            # Best-effort — still return the corrected value to the caller
            # this request even if the write didn't stick; the next read
            # will retry the correction.
            pass
    return {**trial, "trialEnd": capped_end}


def _get_trial(device_id: str) -> dict[str, Any] | None:
    table = _trials_table()
    if table is None:
        return None
    resp  = table.get_item(Key={"deviceId": device_id})
    trial = _from_decimal(resp.get("Item"))
    if trial is None:
        return None
    return _apply_trial_duration_cap(trial)


def _create_trial_if_absent(device_id: str) -> dict[str, Any]:
    """Idempotent activation: the first caller for a deviceId creates the
    trial record; every later call (including a legitimate re-sync from the
    client, or an uninstall/reinstall recomputing the same hardware-derived
    id — see src/main/device-id.ts) sees the ConditionalCheckFailed branch
    and gets back the *original* trialStart/trialEnd unchanged, matching
    Ticket 33 §2's "do not reset the trial" requirement and §5's abuse
    prevention. Raises if TRIALS_TABLE isn't configured — callers must check
    _trials_table() first, same convention as _mark_order_paid/_orders_table."""
    table = _trials_table()
    now        = int(time.time())
    trial_end  = now + TRIAL_DAYS * 86400
    item = {
        "deviceId": device_id, "trialStart": now, "trialEnd": trial_end,
        "createdAt": now, "lastSeen": now,
    }
    try:
        table.put_item(Item=item, ConditionExpression="attribute_not_exists(deviceId)")
        return item
    except Exception as exc:  # noqa: BLE001
        # Same botocore quirk as _mark_order_paid: ConditionalCheckFailedException
        # only shows up in str(exc), not the exception class.
        if "ConditionalCheckFailed" in str(exc):
            existing = _get_trial(device_id)
            if existing:
                return existing
        raise


def _touch_trial_last_seen(device_id: str) -> None:
    """Best-effort bookkeeping only — never lets a write hiccup fail /trial/status."""
    table = _trials_table()
    if table is None:
        return
    try:
        table.update_item(
            Key={"deviceId": device_id},
            UpdateExpression="SET lastSeen = :now",
            ExpressionAttributeValues={":now": int(time.time())},
        )
    except Exception:  # noqa: BLE001
        pass


# ── /trial/activate, /trial/status handlers (Ticket 33) ────────────────────

def _handle_trial_activate(event: dict) -> dict:
    if _trials_table() is None:
        return _not_configured("TRIALS_TABLE")
    try:
        body      = json.loads(event.get("body") or "{}")
        device_id = str(body.get("deviceId", "")).strip()
    except json.JSONDecodeError:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "invalid body"})}

    if not device_id or not _valid_device_id_format(device_id):
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "deviceId required"})}

    trial = _create_trial_if_absent(device_id)
    return {
        "statusCode": 200, "headers": _cors_headers(),
        "body": json.dumps({
            "success": True, "trialStart": trial["trialStart"], "trialEnd": trial["trialEnd"],
        }),
    }


def _handle_trial_status(event: dict) -> dict:
    if _trials_table() is None:
        return _not_configured("TRIALS_TABLE")
    device_id = _query_params(event).get("deviceId", "").strip()
    if not device_id or not _valid_device_id_format(device_id):
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "deviceId required"})}

    trial = _get_trial(device_id)
    if not trial:
        return {
            "statusCode": 200, "headers": _cors_headers(),
            "body": json.dumps({"trialUsed": False, "trialStart": None, "trialEnd": None, "expired": False}),
        }

    _touch_trial_last_seen(device_id)
    return {
        "statusCode": 200, "headers": _cors_headers(),
        "body": json.dumps({
            "trialUsed": True, "trialStart": trial["trialStart"], "trialEnd": trial["trialEnd"],
            "expired": int(time.time()) > trial["trialEnd"],
        }),
    }


# ── Order creation: routes each method to its payment provider ─────────────────

def _create_stripe_order(order_id: str, user_id: str, plan_id: str, method: str) -> dict[str, Any]:
    """card / wechat_pay / alipay all go through one Stripe Checkout Session
    (one-time payment, not a Stripe *subscription* — our own license token is
    the source of truth for expiry, see _issue_or_extend_license). Stripe's
    hosted Checkout page renders the WeChat Pay QR / Alipay redirect itself,
    so we never have to parse or re-render provider-specific payment data."""
    import urllib.request  # noqa: PLC0415
    from urllib.parse import urlencode  # noqa: PLC0415

    api_key = os.environ.get("STRIPE_API_KEY")
    if not api_key:
        raise RuntimeError("STRIPE_API_KEY not configured")

    plan = PLANS[plan_id]
    success_base = os.environ.get("PAYMENT_SUCCESS_URL", "https://ruanjian.app/payment/success")
    cancel_base  = os.environ.get("PAYMENT_CANCEL_URL",  "https://ruanjian.app/payment/cancel")

    fields: dict[str, str] = {
        "mode":                 "payment",
        "success_url":          f"{success_base}?order_id={order_id}",
        "cancel_url":           f"{cancel_base}?order_id={order_id}",
        "client_reference_id":  order_id,
        "payment_method_types[0]": method,  # 'card' | 'wechat_pay' | 'alipay'
        "line_items[0][price_data][currency]":                 plan["currency"],
        "line_items[0][price_data][unit_amount]":               str(plan["amount"]),
        "line_items[0][price_data][product_data][name]":        f"Ruanjian {plan_id} subscription",
        "line_items[0][quantity]":                               "1",
        "metadata[orderId]": order_id,
        "metadata[userId]":  user_id,
        "metadata[planId]":  plan_id,
    }
    if method == "wechat_pay":
        # Required for WeChat Pay on Checkout Sessions — tells Stripe this is
        # a browser (not native app) context so it renders the QR variant.
        fields["payment_method_options[wechat_pay][client]"] = "web"

    body = urlencode(fields).encode()
    req  = urllib.request.Request(
        "https://api.stripe.com/v1/checkout/sessions", data=body, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        session = json.load(r)

    # Card/Alipay: send the user to the system browser. WeChat Pay: embed in
    # an in-app window so the QR shows inline (see main/index.ts payment:open-embedded).
    present_as = "embedded" if method == "wechat_pay" else "external"
    return {"providerOrderId": session["id"], "url": session["url"], "presentAs": present_as}


def _douyin_signature(params: dict[str, str], secret: str) -> str:
    """抖音开放平台 ecpay-style signing: sort params (excluding 'sign' and any
    empty values) by key, join as f"{key}={value}" with '&', append the
    secret, HMAC-SHA256, hex digest. Some Douyin merchant integrations use a
    legacy MD5 variant instead — confirm which one your merchant type uses
    in the current 抖音支付 docs before relying on this in production."""
    items = sorted((k, v) for k, v in params.items() if k != "sign" and v not in (None, ""))
    signed_str = "&".join(f"{k}={v}" for k, v in items)
    return hmac.new(secret.encode(), signed_str.encode(), hashlib.sha256).hexdigest()


def _create_douyin_order(order_id: str, user_id: str, plan_id: str) -> dict[str, Any]:
    """Creates a Douyin Pay H5 order. Desktop web has no Douyin app to deep-link
    into, so — like WeChat Pay above — the returned page is shown in an
    embedded window; Douyin's own H5 checkout page renders a scan-to-pay QR
    when it detects a non-mobile user agent. NOTE: verify the exact endpoint
    path/params for your merchant type (抖音开放平台 vs 抖音电商开放平台)
    before going live — this implements the commonly-documented ecpay
    create_order shape."""
    import urllib.request  # noqa: PLC0415

    app_id      = os.environ.get("DOUYIN_APP_ID")
    merchant_id = os.environ.get("DOUYIN_MERCHANT_ID")
    secret      = os.environ.get("DOUYIN_APP_SECRET")
    if not (app_id and merchant_id and secret):
        raise RuntimeError("DOUYIN_APP_ID / DOUYIN_MERCHANT_ID / DOUYIN_APP_SECRET not configured")

    plan        = PLANS[plan_id]
    notify_url  = os.environ.get("DOUYIN_NOTIFY_URL") or _self_url("douyin-webhook")

    params: dict[str, str] = {
        "app_id":       app_id,
        "merchant_id":  merchant_id,
        "out_order_no": order_id,
        "total_amount": str(plan["amount"]),
        "currency":     plan["currency"].upper(),
        "subject":      f"Ruanjian {plan_id} subscription",
        "notify_url":   notify_url,
        "timestamp":    str(int(time.time())),
    }
    params["sign"] = _douyin_signature(params, secret)

    req = urllib.request.Request(
        "https://developer.toutiao.com/api/apps/ecpay/v1/create_order",
        data=json.dumps(params).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.load(r)

    if str(data.get("err_no", data.get("errno", 0))) != "0":
        raise RuntimeError(f"Douyin order creation failed: {data}")

    pay_url = data.get("data", {}).get("pay_url") or data.get("pay_url", "")
    return {"providerOrderId": data.get("order_id", order_id), "url": pay_url, "presentAs": "embedded"}


def _self_url(path: str) -> str:
    base = os.environ.get("LICENSE_URL", "").rstrip("/")
    return f"{base}/{path}" if base else path


# ── /payment-methods handler (Ticket 31) ────────────────────────────────────

def _handle_payment_methods(event: dict) -> dict:
    """Returns only enabled methods, each carrying its own localized name +
    icon/color, so the client never has to receive one that isn't actually
    usable (nothing to grey out) and doesn't need a hardcoded id → label/icon
    map to render the picker. `lang` should match the app's current i18n
    language (e.g. 'zh-CN' | 'en-US'); defaults to _DEFAULT_LANG."""
    lang    = _query_params(event).get("lang", _DEFAULT_LANG)
    methods = [_localized_method(m, lang) for m in _available_payment_methods()]
    return {"statusCode": 200, "headers": _cors_headers(), "body": json.dumps({"methods": methods})}


# ── /plans handler (Ticket 34) ──────────────────────────────────────────────

def _handle_get_plans(event: dict) -> dict:
    """Returns all four billing-period plans with server-computed prices, so
    the client renders its plan cards without hardcoding any amount. See
    _build_plans() — BASE_MONTHLY_PRICE/PLAN_CURRENCY/USD_EXCHANGE_RATE env
    vars control it. `priceUSD` (Ticket 36) is a display-only USD equivalent
    for the English UI — actual payment is always taken in `currency`."""
    plans = [
        {
            "id":               plan_id,
            "period":           p["period"],
            "durationDays":     p["durationDays"],
            "discountPercent":  p["discountPercent"],
            "price":            p["price"],
            "priceUSD":         p["priceUSD"],
            "originalPrice":    p["originalPrice"],
            "originalPriceUSD": p["originalPriceUSD"],
            "currency":         p["currency"],
        }
        for plan_id, p in PLANS.items()
    ]
    return {
        "statusCode": 200, "headers": _cors_headers(),
        "body": json.dumps({
            "plans": plans,
            "baseMonthlyPrice": BASE_MONTHLY_PRICE,
            "usdExchangeRate": USD_EXCHANGE_RATE,
        }),
    }


# ── /create-order, /order-status, /payment-history handlers ────────────────────

def _handle_create_order(event: dict) -> dict:
    if _orders_table() is None:
        return _not_configured("ORDERS_TABLE")
    try:
        body     = json.loads(event.get("body") or "{}")
        plan_id  = str(body.get("planId", ""))
        method   = str(body.get("method", ""))
        user_id  = str(body.get("userId", "")).strip()
    except json.JSONDecodeError:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "invalid body"})}

    if plan_id not in PLANS:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "unknown planId"})}
    if method not in PAYMENT_METHODS:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "unknown method"})}
    # Ticket 31: reject up front (clean 400) rather than letting a disabled/
    # unconfigured method fall through to _create_stripe_order/_create_douyin_order
    # and surface as an opaque 502 provider error — /payment-methods should
    # already have kept the client from offering this method at all.
    if method not in _available_payment_methods():
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "payment method not available"})}
    if not user_id or len(user_id) > 128:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "userId required"})}

    order_id = _new_order_id()
    plan     = PLANS[plan_id]

    try:
        if method == "douyin_pay":
            provider = _create_douyin_order(order_id, user_id, plan_id)
        else:
            provider = _create_stripe_order(order_id, user_id, plan_id, method)
    except Exception as exc:  # noqa: BLE001
        return {"statusCode": 502, "headers": _cors_headers(),
                "body": json.dumps({"error": f"payment provider error: {exc}"})}

    order = {
        "orderId": order_id, "userId": user_id, "planId": plan_id, "method": method,
        "status": "pending", "amount": plan["amount"], "currency": plan["currency"],
        "createdAt": int(time.time()), "providerOrderId": provider["providerOrderId"],
    }
    _put_order(order)

    return {
        "statusCode": 200, "headers": _cors_headers(),
        "body": json.dumps({
            "orderId": order_id, "planId": plan_id, "method": method, "status": "pending",
            "amount": plan["amount"], "currency": plan["currency"], "createdAt": order["createdAt"],
            "presentAs": provider["presentAs"], "redirectUrl": provider["url"],
        }),
    }


def _handle_order_status(event: dict) -> dict:
    if _orders_table() is None:
        return _not_configured("ORDERS_TABLE")
    qs       = _query_params(event)
    order_id = qs.get("orderId", "")
    user_id  = qs.get("userId", "")
    if not order_id or not user_id:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "orderId and userId required"})}

    order = _get_order(order_id)
    if not order or order.get("userId") != user_id:
        return {"statusCode": 404, "headers": _cors_headers(), "body": json.dumps({"error": "order not found"})}

    resp: dict[str, Any] = {
        "status": order["status"],
        "order": {
            "orderId": order["orderId"], "planId": order["planId"], "method": order["method"],
            "status": order["status"], "amount": order["amount"], "currency": order["currency"],
            "createdAt": order["createdAt"],
        },
    }
    if order["status"] == "paid":
        row = _get_license_row(user_id)
        if row:
            resp["token"] = row["token"]
    return {"statusCode": 200, "headers": _cors_headers(), "body": json.dumps(resp)}


def _handle_payment_history(event: dict) -> dict:
    if _orders_table() is None:
        return _not_configured("ORDERS_TABLE")
    user_id = _query_params(event).get("userId", "")
    if not user_id:
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "userId required"})}

    orders = _query_orders_by_user(user_id)
    history = [{
        "orderId": o["orderId"], "planId": o["planId"], "method": o["method"], "status": o["status"],
        "amount": o["amount"], "currency": o["currency"], "createdAt": o["createdAt"],
        **({"paidAt": o["paidAt"]} if o.get("paidAt") else {}),
    } for o in orders]
    return {"statusCode": 200, "headers": _cors_headers(), "body": json.dumps({"orders": history})}


def _handle_douyin_webhook(event: dict) -> dict:
    secret = os.environ.get("DOUYIN_APP_SECRET")
    if not secret or _orders_table() is None:
        return _not_configured("DOUYIN_APP_SECRET / ORDERS_TABLE")

    try:
        payload = json.loads(_raw_body(event) or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "invalid payload"})}

    expected = _douyin_signature(payload, secret)
    if not hmac.compare_digest(expected, str(payload.get("sign", ""))):
        return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "invalid signature"})}

    # Replay protection, mirroring _verify_stripe_signature's tolerance_sec
    # check below: 'timestamp' is part of the signed params (see
    # _douyin_signature / _create_douyin_order), so it can't be altered
    # without invalidating 'sign' — but without this check, a captured
    # valid (signature, body) pair could otherwise be replayed indefinitely.
    # Only enforced when the field is present: NOTE — confirm the callback
    # payload's actual timestamp field name against the current 抖音支付 docs
    # for your merchant type; until that's confirmed, a payload that omits
    # it skips this check rather than rejecting every real callback.
    if "timestamp" in payload:
        try:
            if abs(time.time() - int(payload["timestamp"])) > 300:
                return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "stale webhook"})}
        except (TypeError, ValueError):
            return {"statusCode": 400, "headers": _cors_headers(), "body": json.dumps({"error": "invalid timestamp"})}

    order_id = str(payload.get("out_order_no", ""))
    txn_id   = str(payload.get("order_id", order_id))
    order    = _get_order(order_id)
    if not order:
        return {"statusCode": 404, "headers": _cors_headers(), "body": json.dumps({"error": "order not found"})}

    _settle_paid_order(order, txn_id)

    # Douyin expects a specific ack body/shape — adjust to match the current
    # 抖音支付 callback contract for your merchant type.
    return {"statusCode": 200, "headers": _cors_headers(), "body": json.dumps({"err_no": 0, "err_tips": "success"})}


def _query_params(event: dict) -> dict[str, str]:
    """Works for both Function URL (payload format 2.0) and API Gateway REST events."""
    qs = event.get("queryStringParameters")
    return dict(qs) if qs else {}


# ── Stripe webhook: license key issuance ────────────────────────────────────────
# _check_stripe() above can only find a subscription by license_key if that key
# already exists in the subscription's metadata. Nothing sets it there except
# this webhook — Stripe Checkout has no field for the customer to invent their
# own key, so the key is generated here, once, right after payment succeeds.

def _generate_license_key() -> str:
    import secrets, string  # noqa: PLC0415
    alphabet = string.ascii_uppercase + string.digits
    groups   = ("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))
    return "RUANJIAN-" + "-".join(groups)


def _set_subscription_license_key(subscription_id: str, license_key: str) -> None:
    """Write metadata.license_key onto a Stripe subscription (POST = partial update)."""
    import urllib.parse, urllib.request  # noqa: PLC0415
    api_key = os.environ["STRIPE_API_KEY"]
    body    = urllib.parse.urlencode({"metadata[license_key]": license_key}).encode()
    req     = urllib.request.Request(
        f"https://api.stripe.com/v1/subscriptions/{urllib.parse.quote(subscription_id)}",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        json.load(r)


def _send_license_key_email(to_email: str, license_key: str) -> bool:
    """
    Email the newly-issued key via SES. Returns False (never raises) when
    delivery is unavailable — unset SES_SENDER_EMAIL, no boto3 (e.g. running
    on Alibaba FC, which this repo also targets), or an SES error — so a
    delivery hiccup never fails the webhook or loses the key: it's already
    durably stored in Stripe metadata, the source of truth, before this runs.
    """
    sender = os.environ.get("SES_SENDER_EMAIL")
    if not sender or not to_email:
        return False

    try:
        import boto3  # noqa: PLC0415
        from botocore.exceptions import BotoCoreError, ClientError  # noqa: PLC0415
    except ImportError:
        return False

    region = os.environ.get("SES_REGION") or os.environ.get("AWS_REGION", "us-east-1")
    body = (
        "Thanks for subscribing to Ruanjian!\n\n"
        f"Your license key: {license_key}\n\n"
        "Enter it in the app under Subscription -> Activate License to unlock your plan.\n"
    )
    try:
        boto3.client("ses", region_name=region).send_email(
            Source=sender,
            Destination={"ToAddresses": [to_email]},
            Message={
                "Subject": {"Data": "Your Ruanjian license key"},
                "Body":    {"Text": {"Data": body}},
            },
        )
        return True
    except (BotoCoreError, ClientError):
        return False


def _handle_checkout_completed(session: dict[str, Any]) -> dict[str, Any]:
    metadata = session.get("metadata") or {}
    order_id = metadata.get("orderId")

    # Ticket 28 order flow: one-time Checkout Session created by
    # /create-order (see _create_stripe_order). Extends the paying user's
    # license directly — no manual key entry, no Stripe *subscription* object.
    if order_id:
        if _orders_table() is None:
            return {"handled": False, "reason": "ORDERS_TABLE not configured"}
        order = _get_order(order_id)
        if not order:
            return {"handled": False, "reason": f"unknown orderId {order_id}"}
        _settle_paid_order(order, session.get("id", order_id))
        return {"handled": True, "orderId": order_id}

    # Legacy flow: static Payment Link in *subscription* mode, no orderId
    # metadata — issue a license key the customer enters manually.
    subscription_id = session.get("subscription")
    if not subscription_id:
        return {"handled": False, "reason": "no subscription on session"}

    license_key = _generate_license_key()
    _set_subscription_license_key(subscription_id, license_key)

    customer_email = (session.get("customer_details") or {}).get("email")
    email_sent = _send_license_key_email(customer_email, license_key) if customer_email else False
    return {"handled": True, "emailSent": email_sent}


def _verify_stripe_signature(payload: bytes, sig_header: str, secret: str, tolerance_sec: int = 300) -> bool:
    """Validate a Stripe-Signature header per Stripe's documented HMAC scheme."""
    try:
        parts     = dict(item.split("=", 1) for item in sig_header.split(","))
        timestamp = parts["t"]
        v1        = parts["v1"]
    except (KeyError, ValueError):
        return False

    signed_payload = f"{timestamp}.".encode() + payload
    expected        = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1):
        return False

    try:
        if abs(time.time() - int(timestamp)) > tolerance_sec:  # reject replayed webhooks
            return False
    except ValueError:
        return False
    return True


def _handle_stripe_webhook(event: dict) -> dict:
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET")
    if not secret:
        return {"statusCode": 500, "headers": _cors_headers(),
                "body": json.dumps({"error": "STRIPE_WEBHOOK_SECRET not configured"})}

    raw = _raw_body(event)
    sig = _get_header(event, "Stripe-Signature")
    if not sig or not _verify_stripe_signature(raw, sig, secret):
        return {"statusCode": 400, "headers": _cors_headers(),
                "body": json.dumps({"error": "invalid signature"})}

    try:
        stripe_event = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"statusCode": 400, "headers": _cors_headers(),
                "body": json.dumps({"error": "invalid payload"})}

    result: dict[str, Any] = {"received": True}
    if stripe_event.get("type") == "checkout.session.completed":
        try:
            result.update(_handle_checkout_completed(stripe_event.get("data", {}).get("object", {})))
        except Exception as exc:  # noqa: BLE001
            # 200 (not 500) → Stripe retries a failing webhook for up to 3 days;
            # a transient Stripe API error on our side shouldn't trigger a retry
            # storm. Log and acknowledge instead; the customer can be re-issued
            # a key manually if this ever actually fires.
            result = {"received": True, "handled": False, "error": str(exc)}

    return {"statusCode": 200, "headers": _cors_headers(), "body": json.dumps(result)}


# ── Lambda / FC handler ───────────────────────────────────────────────────────

def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
        "Content-Type":                 "application/json",
    }


def _get_header(event: dict, name: str) -> str | None:
    """Case-insensitive header lookup (Function URL headers arrive lowercased)."""
    headers = event.get("headers") or {}
    name_l  = name.lower()
    for k, v in headers.items():
        if k.lower() == name_l:
            return v
    return None


def _raw_body(event: dict) -> bytes:
    """Exact bytes as sent by the caller — required for Stripe signature verification."""
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        return base64.b64decode(body)
    return body.encode("utf-8") if isinstance(body, str) else body


def _request_path(event: dict) -> str:
    if "rawPath" in event:                                    # Function URL, payload format 2.0
        return event["rawPath"]
    http_ctx = (event.get("requestContext") or {}).get("http") or {}
    if "path" in http_ctx:
        return http_ctx["path"]
    return event.get("path", "/")                              # API Gateway REST / Alibaba FC


def handler(event: dict, context: object) -> dict:
    """AWS Lambda compatible handler (also works as Alibaba FC with FC_COMPAT=false)."""
    # Handle CORS preflight
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

    path = _request_path(event).rstrip("/")
    if path.endswith("/stripe-webhook"):
        return _handle_stripe_webhook(event)
    if path.endswith("/douyin-webhook"):
        return _handle_douyin_webhook(event)
    if path.endswith("/create-order"):
        return _handle_create_order(event)
    if path.endswith("/order-status"):
        return _handle_order_status(event)
    if path.endswith("/payment-history"):
        return _handle_payment_history(event)
    if path.endswith("/payment-methods"):
        return _handle_payment_methods(event)
    if path.endswith("/trial/activate"):
        return _handle_trial_activate(event)
    if path.endswith("/trial/status"):
        return _handle_trial_status(event)
    if path.endswith("/plans"):
        return _handle_get_plans(event)

    try:
        raw_body    = event.get("body") or "{}"
        body        = json.loads(raw_body) if isinstance(raw_body, str) else raw_body
        license_key = str(body.get("licenseKey", "")).strip()

        if not license_key:
            return {"statusCode": 400, "headers": _cors_headers(),
                    "body": json.dumps({"valid": False, "error": "licenseKey required"})}

        info = _check_payment_provider(license_key)
        if not info:
            return {"statusCode": 402, "headers": _cors_headers(),
                    "body": json.dumps({"valid": False, "error": "License key not found or subscription inactive"})}

        token = create_token(info["userId"], info["planId"], license_key)
        return {
            "statusCode": 200,
            "headers":    _cors_headers(),
            "body":       json.dumps({"valid": True, "token": token,
                                      "expiresIn": EXPIRY_DAYS * 86400}),
        }

    except Exception as exc:  # noqa: BLE001
        return {"statusCode": 500, "headers": _cors_headers(),
                "body": json.dumps({"valid": False, "error": str(exc)})}
