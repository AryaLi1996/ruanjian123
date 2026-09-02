#!/usr/bin/env python3
"""
Ticket 72 backfill: copy the pre-appId trial and licence rows into the tables
that carry an appId dimension.

Why a copy and not an alter: DynamoDB cannot change a table's key schema in
place, and the whole point of this ticket is that (deviceId) becomes
(deviceId, appId) and (userId) becomes (userId, appId). So there are new
tables, and the rows have to be moved into them.

Why this is a *backfill* and not a cutover: handler.py reads the legacy table
on a miss and adopts what it finds under DEFAULT_APP_ID (see
_adopt_legacy_trial / _adopt_legacy_license). That means the deploy is safe
whether this script has run or not — nobody gets a second trial in the gap,
and nobody's purchase disappears. What running it buys is that the legacy
tables stop being load-bearing, so they can be deleted and the read-through
removed.

Every row is stamped with the same appId, and the default is deliberately not
guessable from the data: the old tables had no app dimension because there was
only one app, and that app is what --app-id names.

Idempotent. A row already present in the destination is left exactly as it is
— never overwritten — so a re-run after a partial pass finishes the job and a
re-run after a complete one is a no-op. That also means a row the *service*
has already adopted (a user who launched between deploy and backfill) wins
over the copy here, which is the right way round: it is the newer truth.

Usage:

    # See what it would do, touching nothing (the default):
    python3 migrate_app_id.py \\
        --trials-from ruanjian-license-TrialsTable-ABC \\
        --trials-to   ruanjian-license-TrialsV2Table-XYZ \\
        --licenses-from ruanjian-license-LicensesTable-ABC \\
        --licenses-to   ruanjian-license-LicensesV2Table-XYZ

    # Then, with --apply, actually write:
    python3 migrate_app_id.py ... --apply

Table names come from the stack outputs:

    aws cloudformation describe-stacks --stack-name ruanjian-license \\
      --query "Stacks[0].Outputs" --output table
"""
from __future__ import annotations

import argparse
import sys
import time
from typing import Any, Iterator

DEFAULT_APP_ID = "smoothvoice"


def _table(name: str):  # noqa: ANN201
    import boto3  # noqa: PLC0415
    return boto3.resource("dynamodb").Table(name)


def _scan_all(table, page_size: int = 500) -> Iterator[dict[str, Any]]:
    """Every row, paged. A scan is the right tool exactly once — this is a
    one-off over a table with no access pattern that would suit a query."""
    kwargs: dict[str, Any] = {"Limit": page_size}
    while True:
        resp = table.scan(**kwargs)
        yield from resp.get("Items", [])
        key = resp.get("LastEvaluatedKey")
        if not key:
            return
        kwargs["ExclusiveStartKey"] = key


def _copy(src_name: str, dst_name: str, key_field: str, app_id: str, apply: bool) -> tuple[int, int]:
    """Returns (copied, skipped). `key_field` is the source table's whole key
    — deviceId for trials, userId for licences — which becomes the partition
    key of the destination, with appId as its sort key."""
    src, dst = _table(src_name), _table(dst_name)
    copied = skipped = 0

    for item in _scan_all(src):
        key_value = item.get(key_field)
        if not key_value:
            print(f"  ! row with no {key_field}, skipped: {item!r}", file=sys.stderr)
            skipped += 1
            continue

        row = {**item, key_field: key_value, "appId": app_id, "migratedAt": int(time.time())}
        if not apply:
            print(f"  would copy {key_field}={key_value} → appId={app_id}")
            copied += 1
            continue

        try:
            # The condition is the whole idempotency story: a destination row
            # that already exists — from an earlier pass, or adopted by the
            # service since — is newer than this copy and is left alone.
            dst.put_item(
                Item=row,
                ConditionExpression=f"attribute_not_exists({key_field})",
            )
            copied += 1
        except Exception as exc:  # noqa: BLE001
            if "ConditionalCheckFailed" in str(exc):
                skipped += 1
                continue
            raise

    return copied, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trials-from", help="legacy TrialsTable name")
    ap.add_argument("--trials-to", help="TrialsV2Table name")
    ap.add_argument("--licenses-from", help="legacy LicensesTable name")
    ap.add_argument("--licenses-to", help="LicensesV2Table name")
    ap.add_argument("--app-id", default=DEFAULT_APP_ID,
                    help=f"appId to stamp on every migrated row (default: {DEFAULT_APP_ID})")
    ap.add_argument("--apply", action="store_true",
                    help="actually write. Without it this is a dry run and touches nothing.")
    args = ap.parse_args()

    if not (args.trials_from or args.licenses_from):
        ap.error("nothing to do: pass --trials-from and/or --licenses-from")
    if bool(args.trials_from) != bool(args.trials_to):
        ap.error("--trials-from and --trials-to go together")
    if bool(args.licenses_from) != bool(args.licenses_to):
        ap.error("--licenses-from and --licenses-to go together")

    mode = "APPLY" if args.apply else "DRY RUN (nothing is written)"
    print(f"Ticket 72 backfill — {mode}, stamping appId={args.app_id}\n")

    total_copied = total_skipped = 0
    for label, src, dst, key_field in (
        ("trials", args.trials_from, args.trials_to, "deviceId"),
        ("licenses", args.licenses_from, args.licenses_to, "userId"),
    ):
        if not src:
            continue
        print(f"{label}: {src} → {dst}")
        copied, skipped = _copy(src, dst, key_field, args.app_id, args.apply)
        print(f"  {copied} copied, {skipped} already present or unusable\n")
        total_copied += copied
        total_skipped += skipped

    print(f"Done: {total_copied} copied, {total_skipped} skipped.")
    if not args.apply:
        print("\nThis was a dry run. Re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
