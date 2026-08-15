"""
Serverless license verification function.

Deploy to AWS Lambda or Alibaba Cloud Function Compute (FC).
Both platforms deliver events with similar JSON bodies; set FC_COMPAT=true
for Alibaba FC format.

Environment variables
---------------------
LICENSE_SIGNING_SECRET  HMAC signing secret (must match Electron app)
MOCK_MODE               'true' → accept any key (CI / demo use only)
PAYMENT_PROVIDER        'stripe' | 'lemonsqueezy' | 'custom' (default)
STRIPE_API_KEY          required when PAYMENT_PROVIDER=stripe
LEMON_API_KEY           required when PAYMENT_PROVIDER=lemonsqueezy

Swap provider logic in _check_payment_provider() to change monetisation
without touching any other code.
"""
import base64
import hashlib
import hmac
import json
import os
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
    """Verify a Stripe subscription via the customer portal metadata field."""
    import urllib.request  # noqa: PLC0415
    api_key = os.environ["STRIPE_API_KEY"]
    url     = f"https://api.stripe.com/v1/subscriptions?metadata[license_key]={license_key}&status=active"
    req     = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.load(r)
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


# ── Lambda / FC handler ───────────────────────────────────────────────────────

def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type":                 "application/json",
    }


def handler(event: dict, context: object) -> dict:
    """AWS Lambda compatible handler (also works as Alibaba FC with FC_COMPAT=false)."""
    # Handle CORS preflight
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

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
