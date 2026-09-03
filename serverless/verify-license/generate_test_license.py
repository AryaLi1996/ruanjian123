#!/usr/bin/env python3
"""
Mint a test activation code (a licenseKey) the license service will accept.

There is no route that hands out a key: the only two places a key is born are
the Stripe webhook and `_issue_or_extend_license`, and both want a payment
first. Testing an activation therefore needs a key made out of band — which is
what this script is. It imports handler.py rather than restating any of it, so
a code it prints is one the deployed function agrees with by construction:
the same key format, the same token claims, the same table row.

Two modes, and which one you want depends on what the deployment believes:

  offline (default)
      Prints a key and a token signed with LICENSE_SIGNING_SECRET. Nothing is
      written anywhere. Useful against `MOCK_MODE=true` or the `custom`
      provider, where *any* well-formed key verifies, and useful for pasting
      a token straight into a client that only checks the signature.

  --write
      Also puts the row into LICENSES_TABLE, keyed (userId, appId), the way
      `_issue_or_extend_license` writes it. This is what makes the key real to
      a deployment that looks keys up — the verify route finds the row through
      the licenseKey GSI, sees the appId, and returns the stored expiry rather
      than EXPIRY_DAYS from now. Needs boto3, AWS credentials, and
      LICENSES_TABLE set to the deployed table's name.

Examples
--------
    # A key for the sibling app, signed with the dev secret, nothing written:
    python3 generate_test_license.py --app-id shuyin

    # Five annual keys for this app, written into the deployed table:
    LICENSES_TABLE=ruanjian-license-Licenses \\
      python3 generate_test_license.py --plan annual --count 5 --write

    # A key that has already lapsed, for testing the expired/grace paths:
    python3 generate_test_license.py --days -1

The signing secret and the table name come from the same environment
variables handler.py reads, so a shell configured to talk to a deployment is
already configured for this script.
"""
import argparse
import hashlib
import json
import os
import secrets
import string
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import handler as h  # noqa: E402

DAY = 86400

# Uppercase alphanumerics only, in three hyphenated groups — the shape
# _generate_license_key() uses, and comfortably inside the
# `^[A-Za-z0-9_-]{8,64}$` the verify route enforces. Deliberately a *different*
# prefix from the real one: a test code should be recognisable as one at a
# glance, in a support conversation and in a table scan alike.
DEFAULT_PREFIX = "TEST"
_ALPHABET = string.ascii_uppercase + string.digits


def generate_license_key(prefix: str = DEFAULT_PREFIX) -> str:
    """`PREFIX-XXXX-XXXX-XXXX`, with 60 bits of randomness in the groups.

    Raises ValueError when the prefix would produce a key the service refuses,
    rather than printing a code that fails at the point someone types it in."""
    groups = ("".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(3))
    key = f"{prefix}-" + "-".join(groups) if prefix else "-".join(groups)
    if not h._valid_license_key_format(key):
        raise ValueError(
            f"prefix {prefix!r} makes an invalid license key {key!r} — "
            "keys must match ^[A-Za-z0-9_-]{8,64}$"
        )
    return key


def plan_duration_days(plan_id: str) -> int:
    """The plan's own length. `demo` is not in PLANS — it is the service's
    demo plan id, and its length is DEMO_DAYS — so it is answered separately
    rather than falling back to monthly the way PLANS.get would."""
    if plan_id == h.DEMO_PLAN_ID:
        return h.DEMO_DAYS
    plan = h.PLANS.get(plan_id)
    if plan is None:
        raise ValueError(f"unknown plan {plan_id!r} — one of: {', '.join(known_plans())}")
    return int(plan["durationDays"])


def known_plans() -> list[str]:
    return [*h.PLANS.keys(), h.DEMO_PLAN_ID]


def mint(
    app_id: str,
    plan_id: str = "monthly",
    user_id: str | None = None,
    days: int | None = None,
    prefix: str = DEFAULT_PREFIX,
    license_key: str | None = None,
    now: int | None = None,
) -> dict:
    """One test licence: the key, the signed token, and the row that backs it.

    `days` may be negative — an already-expired licence is the only way to
    reach the client's expired and grace-period paths on purpose."""
    if not h._valid_app_id_format(app_id):
        raise ValueError(f"invalid appId {app_id!r} — must match ^[A-Za-z0-9_.-]{{1,64}}$")

    duration = plan_duration_days(plan_id) if days is None else int(days)
    issued_at = int(time.time()) if now is None else int(now)
    expires_at = issued_at + duration * DAY

    key = license_key or generate_license_key(prefix)
    if not h._valid_license_key_format(key):
        raise ValueError(f"invalid license key {key!r} — must match ^[A-Za-z0-9_-]{{8,64}}$")

    # Same derivation the `custom` provider uses in _check_payment_provider,
    # so a key generated here and *not* written to the table still verifies as
    # the same user it would have been written for.
    uid = user_id or f"user_{hashlib.sha256(key.encode()).hexdigest()[:12]}"

    token = h.create_token(uid, plan_id, key, expires_at=expires_at, app_id=app_id, issued_at=issued_at)
    return {
        "licenseKey": key,
        "token": token,
        "appId": app_id,
        "planId": plan_id,
        "userId": uid,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "durationDays": duration,
    }


def license_row(minted: dict) -> dict:
    """The LICENSES_TABLE item, field for field as _issue_or_extend_license
    writes it — anything else would be a row the verify route reads
    differently from a bought one."""
    return {
        **h._license_key(minted["userId"], minted["appId"]),
        "token": minted["token"],
        "planId": minted["planId"],
        "licenseKey": minted["licenseKey"],
        "expiresAt": minted["expiresAt"],
        "updatedAt": minted["issuedAt"],
    }


def write_license(minted: dict) -> None:
    """Put the row into LICENSES_TABLE. Raises RuntimeError when the table is
    not configured or boto3 is missing, rather than reporting a key as live
    when nothing stored it."""
    table = h._licenses_table()
    if table is None:
        raise RuntimeError(
            "LICENSES_TABLE is not set (or boto3 is unavailable), so there is "
            "nowhere to write the licence — set it to the deployed table name, "
            "or drop --write to mint an offline key"
        )
    table.put_item(Item=license_row(minted))


def _format(minted: dict, written: bool) -> str:
    expires = time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(minted["expiresAt"]))
    lapsed = " (already expired)" if minted["expiresAt"] <= time.time() else ""
    return "\n".join([
        f"  license key : {minted['licenseKey']}",
        f"  app id      : {minted['appId']}",
        f"  plan        : {minted['planId']} ({minted['durationDays']}d)",
        f"  user id     : {minted['userId']}",
        f"  expires     : {expires}{lapsed}",
        f"  stored      : {'LICENSES_TABLE' if written else 'nowhere — offline key'}",
        f"  token       : {minted['token']}",
    ])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="generate_test_license.py",
        description="Mint a test activation code the license service will accept.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Codes are for testing. Anything minted here is as good as a "
               "purchase to a deployment signing with the same secret.",
    )
    parser.add_argument("--app-id", default=h.DEFAULT_APP_ID,
                        help=f"which app the licence is scoped to (default: {h.DEFAULT_APP_ID}; "
                             "the sibling watermark-removal app is 'shuyin')")
    parser.add_argument("--plan", default="monthly",
                        help=f"plan id (default: monthly; one of: {', '.join(known_plans())})")
    parser.add_argument("--user-id", default=None,
                        help="the identity to issue to (default: derived from the key, the way "
                             "the `custom` provider derives it)")
    parser.add_argument("--days", type=int, default=None,
                        help="override the plan's length; negative mints an already-expired licence")
    parser.add_argument("--count", type=int, default=1, help="how many codes to mint (default: 1)")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX,
                        help=f"key prefix (default: {DEFAULT_PREFIX})")
    parser.add_argument("--key", default=None,
                        help="use this exact license key instead of generating one (implies --count 1)")
    parser.add_argument("--write", action="store_true",
                        help="also write the row into LICENSES_TABLE, so a deployment that looks "
                             "keys up accepts it")
    parser.add_argument("--json", action="store_true", help="print JSON instead of a summary")
    args = parser.parse_args(argv)

    if args.count < 1:
        parser.error("--count must be at least 1")
    count = 1 if args.key else args.count

    try:
        minted = [
            mint(app_id=args.app_id, plan_id=args.plan, user_id=args.user_id,
                 days=args.days, prefix=args.prefix, license_key=args.key)
            for _ in range(count)
        ]
        if args.write:
            for m in minted:
                write_license(m)
    except (ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"written": args.write, "licenses": minted}, indent=2))
    else:
        for m in minted:
            print(_format(m, args.write))
            print()
        if h.SIGNING_SECRET == h._DEFAULT_SIGNING_SECRET:
            print("note: signed with the public default secret from handler.py — these codes "
                  "only work against a deployment still using it.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
