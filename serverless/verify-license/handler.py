"""
Serverless license verification function.

Deploy to AWS Lambda or Alibaba Cloud Function Compute (FC).
Both platforms deliver events with similar JSON bodies; set FC_COMPAT=true
for Alibaba FC format.

This single function serves two routes on the same Function URL, dispatched
by request path — no API Gateway needed:

  POST /                 licence verification (default route; see handler())
  POST /stripe-webhook   Stripe webhook listener — issues a license key onto
                          a subscription's metadata when checkout completes

Environment variables
---------------------
LICENSE_SIGNING_SECRET  HMAC signing secret (must match Electron app)
MOCK_MODE               'true' → accept any key (CI / demo use only)
PAYMENT_PROVIDER        'stripe' | 'lemonsqueezy' | 'custom' (default)
STRIPE_API_KEY          required when PAYMENT_PROVIDER=stripe
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

Swap provider logic in _check_payment_provider() to change monetisation
without touching any other code.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any

# ── Configuration ─────────────────────────────────────────────────────────────

SIGNING_SECRET  = os.environ.get("LICENSE_SIGNING_SECRET", "ruanjian-dev-signing-secret-v1-change-in-production")
MOCK_MODE       = os.environ.get("MOCK_MODE", "false").lower() == "true"
PROVIDER        = os.environ.get("PAYMENT_PROVIDER", "custom")
EXPIRY_DAYS     = int(os.environ.get("EXPIRY_DAYS", "30"))
ALLOWED_FEATURES = ["training", "synthesis", "separation", "cover"]


# ── Token helpers ─────────────────────────────────────────────────────────────

def _b64url(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).rstrip(b"=").decode()


def _sign(data: str) -> str:
    return hmac.new(SIGNING_SECRET.encode(), data.encode(), hashlib.sha256).hexdigest()


def create_token(user_id: str, plan_id: str, license_key: str) -> str:
    header  = _b64url(json.dumps({"alg": "HS256", "typ": "LICENSE"}))
    payload = _b64url(json.dumps({
        "userId":     user_id,
        "planId":     plan_id,
        "licenseKey": license_key,
        "expiresAt":  int(time.time()) + EXPIRY_DAYS * 86400,
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
    subscription_id = session.get("subscription")
    if not subscription_id:
        # e.g. a one-time payment mode session with no subscription attached
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

    if _request_path(event).rstrip("/").endswith("/stripe-webhook"):
        return _handle_stripe_webhook(event)

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
