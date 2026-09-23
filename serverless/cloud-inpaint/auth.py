"""
Who is allowed to spend GPU time here.

The service is reachable from anywhere — it is a Lambda Function URL, and an
unauthenticated one would be a stranger's inpainting service running on our
card. So every job carries a token, and this is the one place that decides
whether a token is good.

The token is *not* minted here. It is minted by the licence service, which is
the thing that already knows who has paid and how much of their allowance is
left, and it is handed to the app inside the same reply that says the export is
allowed (`fill/quota` → `endpoint: { url, token }`). This service only checks
it. That split is deliberate: entitlement is one question, asked in one place,
and this process holds no account state at all.

Shape, matching how the licence service already signs things (HMAC-SHA256 over
a compact payload, see its `handler.py`):

    <base64url(payload_json)>.<base64url(hmac_sha256(secret, base64url(payload_json)))>

    payload = { "app": "shuyin", "sub": "<stable user or device id>",
                "exp": <unix seconds> }

Signed over the *encoded* payload rather than the decoded one, so the two ends
never have to agree on how a dict serialises.

`sub` is carried so a log line can say which account spent the time, and is not
otherwise used: what an account is entitled to was already decided before the
token existed. `exp` is what keeps a leaked token from being worth anything for
long — the licence service issues them per export, minutes not months.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import time


class Unauthorised(Exception):
    """A token that will not be honoured, with a reason fit to return."""


# A little slack for the two machines disagreeing about the time. Small on
# purpose: this widens the window a used-up token stays valid for.
CLOCK_SKEW_SECONDS = 60


def _b64url_decode(text: str) -> bytes:
    # The encoder strips '=' padding; put back however much is missing.
    padded = text + '=' * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode('ascii'))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def signing_secret() -> str:
    """The secret this process verifies with. Absent means refuse everything."""
    return os.environ.get('FILL_SIGNING_SECRET', '')


def expected_app_id() -> str:
    """Which app's tokens this deployment answers to, or '' for any."""
    return os.environ.get('FILL_APP_ID', '')


def sign(payload: dict, secret: str) -> str:
    """
    Mint a token.

    Here so the tests have something to verify against, and because the licence
    service beside this one mints the real ones — `_mint_fill_token` in
    `serverless/verify-license/handler.py`, which this is the specification for.
    `test_fill_token_matches_the_inpaint_service` there checks the two agree.
    Nothing in the running service calls it.
    """
    body = _b64url_encode(json.dumps(payload, separators=(',', ':'),
                                     sort_keys=True).encode('utf-8'))
    mac = hmac.new(secret.encode('utf-8'), body.encode('ascii'), hashlib.sha256)
    return f'{body}.{_b64url_encode(mac.digest())}'


def verify(token: str, now: float | None = None) -> dict:
    """
    The token's payload, or `Unauthorised` saying what was wrong with it.

    Every failure is a refusal; none of them is a fallback. The client's answer
    to a refusal is to fill the frames on the user's own machine, which still
    finishes the export — so there is no case where guessing in the caller's
    favour buys anything, and several where it spends money.
    """
    secret = signing_secret()
    if not secret:
        # A deployment that was handed no secret cannot tell a good token from
        # a forged one, so it honours neither. Failing shut matters more here
        # than a clear error: the alternative is an open GPU.
        raise Unauthorised('this deployment has no signing secret configured')

    body, _, signature = token.partition('.')
    if not body or not signature:
        raise Unauthorised('malformed token')

    expected = hmac.new(secret.encode('utf-8'), body.encode('ascii'),
                        hashlib.sha256).digest()
    try:
        given = _b64url_decode(signature)
    except (binascii.Error, ValueError) as exc:
        raise Unauthorised('malformed token') from exc
    # Constant-time: a comparison that returns early tells an attacker how much
    # of a guessed signature was right, one byte at a time.
    if not hmac.compare_digest(expected, given):
        raise Unauthorised('bad signature')

    try:
        payload = json.loads(_b64url_decode(body))
    except (binascii.Error, ValueError) as exc:
        raise Unauthorised('malformed token') from exc
    if not isinstance(payload, dict):
        raise Unauthorised('malformed token')

    # Checked only after the signature, so an unsigned payload can never steer
    # what this function does.
    expiry = payload.get('exp')
    if not isinstance(expiry, (int, float)):
        raise Unauthorised('token does not say when it expires')
    if (now if now is not None else time.time()) > expiry + CLOCK_SKEW_SECONDS:
        raise Unauthorised('token has expired')

    wanted = expected_app_id()
    if wanted and payload.get('app') != wanted:
        raise Unauthorised('token is for a different app')

    return payload


def bearer(header: str | None) -> str:
    """The token out of an Authorization header, or a refusal."""
    if not header:
        raise Unauthorised('no Authorization header')
    scheme, _, value = header.partition(' ')
    if scheme.lower() != 'bearer' or not value.strip():
        raise Unauthorised('Authorization header is not a bearer token')
    return value.strip()
