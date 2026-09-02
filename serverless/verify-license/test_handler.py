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


# ── Demo licence route (/demo/activate, /demo/status) ──────────────────────
# The demo used to be minted by the Electron client itself and limited only by
# a file in its own data directory. These cover the properties that move gained
# by putting issuance behind the service instead: one demo per (app, device),
# a re-ask inside the window that recovers the same licence rather than
# extending it, and a spent demo that stays spent.

class FakeDemosTable:
    """In-memory stand-in for the DemosTable Table object, matching the
    get_item/put_item shapes _create_demo_if_absent/_get_demo use."""

    def __init__(self, items=None):
        self.items = dict(items or {})

    def get_item(self, Key):
        item = self.items.get(Key["demoKey"])
        return {"Item": item} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        key = Item["demoKey"]
        if ConditionExpression and key in self.items:
            raise Exception("ConditionalCheckFailedException: item already exists")
        self.items[key] = dict(Item)


class DemoTestCase(unittest.TestCase):
    def setUp(self):
        orig = h._demos_table
        self.addCleanup(lambda: setattr(h, "_demos_table", orig))

    def use_table(self, table=None):
        table = table if table is not None else FakeDemosTable()
        h._demos_table = lambda: table
        return table

    @staticmethod
    def activate(app_id="shuyin", device_id="a" * 64):
        body = {"deviceId": device_id}
        if app_id is not None:
            body["appId"] = app_id
        return h._handle_demo_activate({"body": json.dumps(body)})

    @staticmethod
    def payload_of(token):
        import base64
        body = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


class DemoActivateTests(DemoTestCase):
    def test_first_activation_issues_a_verifiable_demo_token(self):
        self.use_table()
        now = int(time.time())

        resp = self.activate()
        self.assertEqual(resp["statusCode"], 200)
        body = json.loads(resp["body"])
        self.assertTrue(body["success"])
        self.assertEqual(body["appId"], "shuyin")
        self.assertEqual(body["planId"], h.DEMO_PLAN_ID)
        self.assertEqual(body["demoDurationDays"], h.DEMO_DAYS)
        self.assertAlmostEqual(body["expiresAt"], now + h.DEMO_DAYS * DAY, delta=5)

        header, payload, sig = body["token"].split(".")
        self.assertEqual(sig, h._sign(f"{header}.{payload}"))
        claims = self.payload_of(body["token"])
        self.assertEqual(claims["planId"], h.DEMO_PLAN_ID)
        self.assertEqual(claims["appId"], "shuyin")
        self.assertEqual(claims["expiresAt"], body["expiresAt"])

    def test_second_activation_returns_the_same_window_not_a_new_one(self):
        table = self.use_table()
        first = json.loads(self.activate()["body"])
        # Pretend a week passed and the client lost its token.
        table.items[h._demo_key("shuyin", "a" * 64)]["issuedAt"] -= 7 * DAY
        table.items[h._demo_key("shuyin", "a" * 64)]["expiresAt"] -= 7 * DAY

        second = json.loads(self.activate()["body"])
        self.assertTrue(second["success"])
        self.assertEqual(second["expiresAt"], first["expiresAt"] - 7 * DAY)
        self.assertEqual(self.payload_of(second["token"])["expiresAt"], second["expiresAt"])

    def test_a_demo_whose_window_has_passed_is_refused_as_used(self):
        table = self.use_table()
        self.activate()
        record = table.items[h._demo_key("shuyin", "a" * 64)]
        record["issuedAt"] -= (h.DEMO_DAYS + 1) * DAY
        record["expiresAt"] -= (h.DEMO_DAYS + 1) * DAY

        resp = self.activate()
        self.assertEqual(resp["statusCode"], 409)
        body = json.loads(resp["body"])
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "demo_already_used")
        self.assertNotIn("token", body)

    def test_the_same_device_gets_one_demo_per_app(self):
        self.use_table()
        shuyin = json.loads(self.activate(app_id="shuyin")["body"])
        sibling = json.loads(self.activate(app_id="smoothvoice")["body"])
        self.assertTrue(shuyin["success"])
        self.assertTrue(sibling["success"])
        self.assertNotEqual(
            self.payload_of(shuyin["token"])["userId"],
            self.payload_of(sibling["token"])["userId"],
        )

    def test_a_body_without_an_app_id_falls_back_to_the_default(self):
        self.use_table()
        body = json.loads(self.activate(app_id=None)["body"])
        self.assertEqual(body["appId"], h.DEFAULT_APP_ID)

    def test_a_missing_or_malformed_device_id_is_refused(self):
        self.use_table()
        for device_id in ("", "short", "bad/chars" * 4):
            resp = h._handle_demo_activate({"body": json.dumps({"deviceId": device_id})})
            self.assertEqual(resp["statusCode"], 400, device_id)

    def test_an_app_id_carrying_the_key_separator_is_refused(self):
        # "a#b" + "c" must not be able to collide with "a" + "b#c".
        self.use_table()
        resp = self.activate(app_id="shu#yin")
        self.assertEqual(resp["statusCode"], 400)

    def test_the_route_501s_until_the_table_is_configured(self):
        h._demos_table = lambda: None
        self.assertEqual(self.activate()["statusCode"], 501)
        self.assertEqual(h._handle_demo_status({"body": "{}"})["statusCode"], 501)


class DemoStatusTests(DemoTestCase):
    def status(self, app_id="shuyin", device_id="a" * 64):
        return json.loads(h._handle_demo_status(
            {"body": json.dumps({"appId": app_id, "deviceId": device_id})}
        )["body"])

    def test_unused_device_reports_nothing_taken(self):
        self.use_table()
        body = self.status()
        self.assertFalse(body["used"])
        self.assertFalse(body["expired"])
        self.assertIsNone(body["expiresAt"])
        self.assertEqual(body["demoDurationDays"], h.DEMO_DAYS)

    def test_status_reports_an_active_demo_without_handing_back_a_token(self):
        self.use_table()
        activated = json.loads(self.activate()["body"])
        body = self.status()
        self.assertTrue(body["used"])
        self.assertFalse(body["expired"])
        self.assertEqual(body["expiresAt"], activated["expiresAt"])
        self.assertNotIn("token", body)

    def test_status_reports_a_lapsed_demo_as_expired(self):
        table = self.use_table()
        self.activate()
        table.items[h._demo_key("shuyin", "a" * 64)]["expiresAt"] = int(time.time()) - 1
        self.assertTrue(self.status()["expired"])

    def test_status_reads_the_query_string_on_a_get(self):
        self.use_table()
        self.activate()
        resp = h._handle_demo_status({
            "requestContext": {"http": {"method": "GET"}},
            "queryStringParameters": {"appId": "shuyin", "deviceId": "a" * 64},
        })
        self.assertTrue(json.loads(resp["body"])["used"])


class CreateTokenAppIdTests(unittest.TestCase):
    def test_app_id_is_omitted_entirely_when_not_given(self):
        # A client that checks the field reads a token without one as "not
        # scoped elsewhere", so adding the key unconditionally would change
        # how every already-issued token reads.
        token = h.create_token("user-1", "monthly", "KEY12345")
        self.assertNotIn("appId", DemoTestCase.payload_of(token))

    def test_issued_at_can_be_pinned_to_the_original_issuance(self):
        then = int(time.time()) - 3 * DAY
        token = h.create_token("user-1", "demo", "KEY12345", issued_at=then)
        self.assertEqual(DemoTestCase.payload_of(token)["issuedAt"], then)


if __name__ == "__main__":
    unittest.main()
