"""
Ticket 42: unit tests for the trial-duration migration/cap logic in
handler.py, plus the trialDurationDays field it added to the trial
endpoints' responses.

Uses only the stdlib (unittest) — no pytest/boto3 required, matching
handler.py itself, which only imports boto3 lazily inside functions so it
still runs without it (see _ddb_table). Run with:

    cd serverless/verify-license && python3 -m unittest test_handler -v
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import handler as h  # noqa: E402

DAY = 86400


class FakeTrialsTable:
    """Minimal in-memory stand-in for the DynamoDB Table object handler.py
    calls through _trials_table() — just enough of get_item/put_item/
    update_item's shapes for the trial code paths under test, so these tests
    never touch real AWS/boto3."""

    def __init__(self, items=None):
        self.items = dict(items or {})
        self.update_calls: list[dict] = []

    def get_item(self, Key):
        item = self.items.get(Key["deviceId"])
        return {"Item": item} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        device_id = Item["deviceId"]
        if ConditionExpression and device_id in self.items:
            raise Exception("ConditionalCheckFailedException: item already exists")
        self.items[device_id] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None):
        device_id = Key["deviceId"]
        self.update_calls.append({"Key": Key, "Values": dict(ExpressionAttributeValues)})
        if ConditionExpression and device_id not in self.items:
            raise Exception("ConditionalCheckFailedException: item does not exist")
        # Only ever asked to "SET trialEnd = :capped" in the code under test.
        self.items[device_id]["trialEnd"] = ExpressionAttributeValues[":capped"]


class TrialTestCase(unittest.TestCase):
    """Swaps handler._trials_table() for a FakeTrialsTable-backed stub for
    the duration of each test, restoring the original afterward."""

    def setUp(self):
        self._orig_trials_table = h._trials_table
        self.addCleanup(lambda: setattr(h, "_trials_table", self._orig_trials_table))

    def use_table(self, table: FakeTrialsTable) -> FakeTrialsTable:
        h._trials_table = lambda: table
        return table


class ApplyTrialDurationCapTests(TrialTestCase):
    def test_still_active_trial_over_cap_is_truncated_and_persisted(self):
        now = int(time.time())
        table = self.use_table(FakeTrialsTable())
        trial = {
            "deviceId": "dev-still-active",
            # Old 7-day-style trial, 1 day in: still active, over TRIAL_DAYS.
            "trialStart": now - 1 * DAY,
            "trialEnd": now - 1 * DAY + 7 * DAY,
        }

        result = h._apply_trial_duration_cap(trial)

        expected_end = trial["trialStart"] + h.TRIAL_DAYS * DAY
        self.assertEqual(result["trialEnd"], expected_end)
        self.assertLess(now, result["trialEnd"])  # confirms this case is still "active"
        self.assertEqual(len(table.update_calls), 1)
        self.assertEqual(table.update_calls[0]["Key"], {"deviceId": "dev-still-active"})
        self.assertEqual(table.update_calls[0]["Values"][":capped"], expected_end)

    def test_truncation_can_immediately_expire_a_trial(self):
        now = int(time.time())
        table = self.use_table(FakeTrialsTable())
        trial = {
            "deviceId": "dev-now-expired",
            # Old 7-day-style trial, well past where TRIAL_DAYS would end.
            "trialStart": now - (h.TRIAL_DAYS + 2) * DAY,
            "trialEnd": now - (h.TRIAL_DAYS + 2) * DAY + 7 * DAY,
        }
        # Only meaningful while the record still spans more than TRIAL_DAYS.
        self.assertGreater(trial["trialEnd"] - trial["trialStart"], h.TRIAL_DAYS * DAY)

        result = h._apply_trial_duration_cap(trial)

        expected_end = trial["trialStart"] + h.TRIAL_DAYS * DAY
        self.assertEqual(result["trialEnd"], expected_end)
        self.assertGreaterEqual(now, result["trialEnd"])
        self.assertEqual(len(table.update_calls), 1)

    def test_already_expired_trial_is_left_untouched(self):
        now = int(time.time())
        table = self.use_table(FakeTrialsTable())
        trial = {
            "deviceId": "dev-already-lapsed",
            "trialStart": now - 10 * DAY,
            "trialEnd": now - 3 * DAY,  # already expired under its own stored value
        }

        result = h._apply_trial_duration_cap(trial)

        self.assertEqual(result, trial)
        self.assertEqual(table.update_calls, [])

    def test_record_already_within_cap_is_a_noop(self):
        now = int(time.time())
        table = self.use_table(FakeTrialsTable())
        trial = {
            "deviceId": "dev-within-cap",
            "trialStart": now - 1 * DAY,
            "trialEnd": now - 1 * DAY + h.TRIAL_DAYS * DAY,
        }

        result = h._apply_trial_duration_cap(trial)

        self.assertEqual(result, trial)
        self.assertEqual(table.update_calls, [])

    def test_shorter_than_cap_trial_is_never_extended(self):
        now = int(time.time())
        table = self.use_table(FakeTrialsTable())
        trial = {
            "deviceId": "dev-shorter",
            "trialStart": now - 1 * DAY,
            "trialEnd": now,  # a 1-day trial, shorter than TRIAL_DAYS
        }

        result = h._apply_trial_duration_cap(trial)

        self.assertEqual(result["trialEnd"], trial["trialEnd"])
        self.assertEqual(table.update_calls, [])

    def test_idempotent_second_call_is_a_noop(self):
        now = int(time.time())
        table = self.use_table(FakeTrialsTable())
        trial = {
            "deviceId": "dev-idempotent",
            "trialStart": now - 1 * DAY,
            "trialEnd": now - 1 * DAY + 7 * DAY,
        }

        first = h._apply_trial_duration_cap(trial)
        second = h._apply_trial_duration_cap(first)

        self.assertEqual(second, first)
        self.assertEqual(len(table.update_calls), 1)  # only the first call wrote anything


class GetTrialAppliesCapTests(TrialTestCase):
    def test_get_trial_returns_capped_and_persisted_value(self):
        now = int(time.time())
        device_id = "dev-get-trial"
        start = now - 1 * DAY
        table = self.use_table(FakeTrialsTable({
            device_id: {"deviceId": device_id, "trialStart": start, "trialEnd": start + 7 * DAY},
        }))

        result = h._get_trial(device_id)

        expected_end = start + h.TRIAL_DAYS * DAY
        self.assertEqual(result["trialEnd"], expected_end)
        self.assertEqual(table.items[device_id]["trialEnd"], expected_end)

    def test_get_trial_returns_none_when_absent(self):
        self.use_table(FakeTrialsTable())
        self.assertIsNone(h._get_trial("dev-absent"))


class TrialEndpointResponseTests(TrialTestCase):
    """The trialDurationDays field added to /trial/activate and
    /trial/status responses (Ticket 42) — lets the client cache the
    server's current trial length instead of only trusting its own
    hardcoded config (see LocalTrialRecord.durationDays in
    subscription-monitor.ts)."""

    VALID_DEVICE_ID = "d" * 32  # satisfies _valid_device_id_format (16-128 chars)

    def test_trial_status_includes_duration_days_when_unused(self):
        self.use_table(FakeTrialsTable())
        event = {"queryStringParameters": {"deviceId": self.VALID_DEVICE_ID}}

        body = json.loads(h._handle_trial_status(event)["body"])

        self.assertFalse(body["trialUsed"])
        self.assertEqual(body["trialDurationDays"], h.TRIAL_DAYS)

    def test_trial_status_includes_duration_days_when_used(self):
        now = int(time.time())
        self.use_table(FakeTrialsTable({
            self.VALID_DEVICE_ID: {
                "deviceId": self.VALID_DEVICE_ID, "trialStart": now, "trialEnd": now + h.TRIAL_DAYS * DAY,
                "createdAt": now, "lastSeen": now,
            },
        }))
        event = {"queryStringParameters": {"deviceId": self.VALID_DEVICE_ID}}

        body = json.loads(h._handle_trial_status(event)["body"])

        self.assertTrue(body["trialUsed"])
        self.assertEqual(body["trialDurationDays"], h.TRIAL_DAYS)

    def test_trial_activate_includes_duration_days(self):
        self.use_table(FakeTrialsTable())
        event = {"body": json.dumps({"deviceId": self.VALID_DEVICE_ID})}

        body = json.loads(h._handle_trial_activate(event)["body"])

        self.assertTrue(body["success"])
        self.assertEqual(body["trialDurationDays"], h.TRIAL_DAYS)


if __name__ == "__main__":
    unittest.main()
