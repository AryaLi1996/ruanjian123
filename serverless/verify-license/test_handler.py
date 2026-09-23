"""
Ticket 42: unit tests for the trial-duration migration/cap logic in
handler.py, plus the trialDurationDays field it added to the trial
endpoints' responses.

Uses only the stdlib (unittest) — no pytest/boto3 required, matching
handler.py itself, which only imports boto3 lazily inside functions so it
still runs without it (see _ddb_table). Run with:

    cd serverless/verify-license && python3 -m unittest test_handler -v
"""
import base64
import json
import os
import sys
import time
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import handler as h  # noqa: E402

DAY = 86400


def trial_key(device_id, app_id=None):
    """The composite key Ticket 72 gave TrialsTable — (deviceId, appId) — as
    the tuple these in-memory fakes index by."""
    return (device_id, app_id if app_id is not None else h.DEFAULT_APP_ID)


class FakeTrialsTable:
    """Minimal in-memory stand-in for the DynamoDB Table object handler.py
    calls through _trials_table() — just enough of get_item/put_item/
    update_item's shapes for the trial code paths under test, so these tests
    never touch real AWS/boto3.

    Indexed by the (deviceId, appId) tuple, matching the real table's key
    schema since Ticket 72; pass items keyed with trial_key()."""

    def __init__(self, items=None):
        self.items = dict(items or {})
        self.update_calls: list[dict] = []

    @staticmethod
    def _key(d):
        return trial_key(d["deviceId"], d.get("appId"))

    def get_item(self, Key):
        item = self.items.get(self._key(Key))
        return {"Item": item} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        key = self._key(Item)
        if ConditionExpression and key in self.items:
            raise Exception("ConditionalCheckFailedException: item already exists")
        self.items[key] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ConditionExpression=None):
        key = self._key(Key)
        self.update_calls.append({"Key": Key, "Values": dict(ExpressionAttributeValues)})
        if ConditionExpression and key not in self.items:
            raise Exception("ConditionalCheckFailedException: item does not exist")
        # Only ever asked to "SET trialEnd = :capped" in the code under test.
        self.items[key]["trialEnd"] = ExpressionAttributeValues[":capped"]


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
        self.assertEqual(
            table.update_calls[0]["Key"],
            {"deviceId": "dev-still-active", "appId": h.DEFAULT_APP_ID},
        )
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
            trial_key(device_id): {
                "deviceId": device_id, "appId": h.DEFAULT_APP_ID,
                "trialStart": start, "trialEnd": start + 7 * DAY,
            },
        }))

        result = h._get_trial(h.DEFAULT_APP_ID, device_id)

        expected_end = start + h.TRIAL_DAYS * DAY
        self.assertEqual(result["trialEnd"], expected_end)
        self.assertEqual(table.items[trial_key(device_id)]["trialEnd"], expected_end)

    def test_get_trial_returns_none_when_absent(self):
        self.use_table(FakeTrialsTable())
        self.assertIsNone(h._get_trial(h.DEFAULT_APP_ID, "dev-absent"))


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
            trial_key(self.VALID_DEVICE_ID): {
                "deviceId": self.VALID_DEVICE_ID, "appId": h.DEFAULT_APP_ID,
                "trialStart": now, "trialEnd": now + h.TRIAL_DAYS * DAY,
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


# ── Ticket 72: appId isolation for trials, licences and orders ─────────────
# The trial used to be keyed by deviceId alone, so the same machine running
# SootheVoice and 舒音 shared one three-day trial: whichever app was opened
# second found it already spent. The licence row was keyed by userId alone,
# with the same consequence one table along — a purchase in one app extended
# the other's expiry. These cover the isolation, and cover just as carefully
# that isolating it did not hand anybody a *second* trial.

class FakeLicensesTable:
    """In-memory stand-in for LicensesV2Table: (userId, appId) key plus the
    licenseKey-index GSI the verify route queries."""

    def __init__(self, items=None):
        self.items = dict(items or {})

    @staticmethod
    def _key(d):
        return (d["userId"], d.get("appId", h.DEFAULT_APP_ID))

    def get_item(self, Key):
        item = self.items.get(self._key(Key))
        return {"Item": item} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        key = self._key(Item)
        if ConditionExpression and key in self.items:
            raise Exception("ConditionalCheckFailedException: item already exists")
        self.items[key] = dict(Item)

    def query(self, IndexName, KeyConditionExpression, ExpressionAttributeValues, Limit=None):
        wanted = ExpressionAttributeValues[":k"]
        hits = [v for v in self.items.values() if v.get("licenseKey") == wanted]
        return {"Items": hits[:Limit] if Limit else hits}


class AppIdTestCase(unittest.TestCase):
    """Swaps every store handler.py reaches for an in-memory fake, and puts
    them back afterward."""

    SHUYIN = "shuyin"
    DEVICE = "d" * 32

    def setUp(self):
        for name in ("_trials_table", "_licenses_table"):
            orig = getattr(h, name)
            self.addCleanup(lambda n=name, o=orig: setattr(h, n, o))
        # Configured and empty. Since Ticket 74 these are the only stores
        # there are: a miss here is simply a miss.
        self.trials = FakeTrialsTable()
        self.licenses = FakeLicensesTable()
        h._trials_table = lambda: self.trials
        h._licenses_table = lambda: self.licenses

    def activate(self, app_id=None, device_id=None):
        body = {"deviceId": device_id or self.DEVICE}
        if app_id is not None:
            body["appId"] = app_id
        return json.loads(h._handle_trial_activate({"body": json.dumps(body)})["body"])

    def status(self, app_id=None, device_id=None):
        params = {"deviceId": device_id or self.DEVICE}
        if app_id is not None:
            params["appId"] = app_id
        return json.loads(h._handle_trial_status({"queryStringParameters": params})["body"])


class TrialAppIdIsolationTests(AppIdTestCase):
    def test_one_device_gets_a_separate_trial_in_each_app(self):
        # The bug this ticket exists for: before, the second app to ask found
        # the trial already spent.
        first = self.activate(h.DEFAULT_APP_ID)
        self.assertTrue(first["success"])
        self.assertEqual(first["appId"], h.DEFAULT_APP_ID)

        # Move the first app's trial into the past so a shared record would
        # read as expired rather than merely "already started".
        row = self.trials.items[trial_key(self.DEVICE, h.DEFAULT_APP_ID)]
        row["trialStart"] -= 30 * DAY
        row["trialEnd"] -= 30 * DAY

        second = self.activate(self.SHUYIN)
        self.assertTrue(second["success"])
        self.assertEqual(second["appId"], self.SHUYIN)
        self.assertGreater(second["trialEnd"], int(time.time()))
        self.assertNotEqual(second["trialStart"], row["trialStart"])

        # And each app still sees only its own.
        self.assertTrue(self.status(h.DEFAULT_APP_ID)["expired"])
        self.assertFalse(self.status(self.SHUYIN)["expired"])

    def test_re_activating_the_same_app_does_not_restart_the_trial(self):
        first = self.activate(self.SHUYIN)
        second = self.activate(self.SHUYIN)
        self.assertEqual(second["trialStart"], first["trialStart"])
        self.assertEqual(second["trialEnd"], first["trialEnd"])

    def test_a_request_naming_no_app_falls_back_to_the_default(self):
        body = self.activate(app_id=None)
        self.assertEqual(body["appId"], h.DEFAULT_APP_ID)
        self.assertIn(trial_key(self.DEVICE, h.DEFAULT_APP_ID), self.trials.items)

    def test_status_reports_which_app_it_answered_for(self):
        self.activate(self.SHUYIN)
        self.assertEqual(self.status(self.SHUYIN)["appId"], self.SHUYIN)
        self.assertTrue(self.status(self.SHUYIN)["trialUsed"])
        self.assertFalse(self.status(h.DEFAULT_APP_ID)["trialUsed"])

    def test_a_malformed_app_id_is_refused_on_both_trial_routes(self):
        for app_id in ("has space", "sh#uyin", "x" * 65):
            self.assertEqual(
                h._handle_trial_activate(
                    {"body": json.dumps({"deviceId": self.DEVICE, "appId": app_id})}
                )["statusCode"], 400, app_id)
            self.assertEqual(
                h._handle_trial_status(
                    {"queryStringParameters": {"deviceId": self.DEVICE, "appId": app_id}}
                )["statusCode"], 400, app_id)


class PostLegacyReadTests(AppIdTestCase):
    """Ticket 74 removed the read-through into the pre-appId tables. These
    pin what the two reads it ran through do now: consult the V2 table and
    nothing else, so a miss is a miss rather than a lookup somewhere older."""

    def test_a_trial_miss_is_a_miss_and_activation_starts_a_fresh_window(self):
        self.assertIsNone(h._get_trial(h.DEFAULT_APP_ID, self.DEVICE))
        body = self.activate(h.DEFAULT_APP_ID)
        self.assertGreater(body["trialEnd"], int(time.time()))
        # Written where the V2 key schema says, and with no migration stamp:
        # nothing was adopted from anywhere.
        row = self.trials.items[trial_key(self.DEVICE, h.DEFAULT_APP_ID)]
        self.assertEqual(row["appId"], h.DEFAULT_APP_ID)
        self.assertNotIn("migratedAt", row)

    def test_a_licence_reads_back_only_for_the_app_it_was_issued_in(self):
        h._issue_or_extend_license("user-1", "monthly", h.DEFAULT_APP_ID)
        self.assertIsNotNone(h._get_license_row("user-1", h.DEFAULT_APP_ID))
        self.assertIsNone(h._get_license_row("user-1", self.SHUYIN))
        self.assertIsNone(h._get_license_row("user-2", h.DEFAULT_APP_ID))


class LicenseAppIdIsolationTests(AppIdTestCase):
    def issue(self, app_id, plan_id="monthly", user_id="user-1"):
        return h._issue_or_extend_license(user_id, plan_id, app_id)

    @staticmethod
    def claims(token):
        import base64
        body = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))

    def test_a_purchase_in_one_app_does_not_extend_the_other(self):
        _, first_end = self.issue(h.DEFAULT_APP_ID)
        _, other_end = self.issue(self.SHUYIN)
        # Both start from now, neither stacks onto the other.
        self.assertAlmostEqual(first_end, other_end, delta=5)

        # A renewal in the *same* app does stack, as it always has.
        _, renewed = self.issue(h.DEFAULT_APP_ID)
        self.assertGreater(renewed, first_end)
        # And it left the sibling's expiry exactly where it was.
        self.assertEqual(
            self.licenses.items[("user-1", self.SHUYIN)]["expiresAt"], other_end,
        )

    def test_the_issued_token_names_its_app(self):
        token, _ = self.issue(self.SHUYIN)
        self.assertEqual(self.claims(token)["appId"], self.SHUYIN)

    def test_verify_refuses_a_key_issued_for_another_app(self):
        token, _ = self.issue(self.SHUYIN)
        key = self.licenses.items[("user-1", self.SHUYIN)]["licenseKey"]

        resp = h.handler({"body": json.dumps({"licenseKey": key, "appId": h.DEFAULT_APP_ID})}, None)

        self.assertEqual(resp["statusCode"], 403)
        body = json.loads(resp["body"])
        self.assertFalse(body["valid"])
        self.assertEqual(body["code"], "app_id_mismatch")
        self.assertNotIn("token", body)
        # Every shape the clients recognise a mismatch by: the code, the
        # owning appId, and "appId" in the message. A refusal one of them
        # cannot spot reads as "try again" for something retrying will never
        # fix — see isAppMismatch() in the Electron clients.
        self.assertEqual(body["appId"], self.SHUYIN)
        self.assertIn("appId", body["error"])

    def test_verify_accepts_the_key_in_the_app_it_was_issued_for(self):
        _, expires_at = self.issue(self.SHUYIN)
        key = self.licenses.items[("user-1", self.SHUYIN)]["licenseKey"]

        resp = h.handler({"body": json.dumps({"licenseKey": key, "appId": self.SHUYIN})}, None)

        self.assertEqual(resp["statusCode"], 200)
        body = json.loads(resp["body"])
        self.assertTrue(body["valid"])
        self.assertEqual(body["appId"], self.SHUYIN)
        # Re-verifying returns the expiry the purchase bought — it must not
        # quietly push it out by EXPIRY_DAYS every time the client refreshes.
        self.assertEqual(self.claims(body["token"])["expiresAt"], expires_at)

    def test_a_key_this_service_never_issued_still_verifies_as_before(self):
        # Legacy Stripe-metadata keys and every `custom`-provider key have no
        # row, so they are unknown rather than foreign.
        resp = h.handler({"body": json.dumps({"licenseKey": "NOTOURSKEY123", "appId": self.SHUYIN})}, None)
        body = json.loads(resp["body"])
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(body["valid"])
        self.assertEqual(self.claims(body["token"])["appId"], self.SHUYIN)

    def test_a_settled_order_issues_for_the_app_it_was_bought_in(self):
        orig = h._mark_order_paid
        self.addCleanup(lambda: setattr(h, "_mark_order_paid", orig))
        h._mark_order_paid = lambda order_id, txn: {"orderId": order_id, "status": "paid"}

        h._settle_paid_order(
            {"orderId": "o1", "userId": "user-1", "planId": "monthly",
             "appId": self.SHUYIN, "status": "pending"},
            "txn-1",
        )
        self.assertIn(("user-1", self.SHUYIN), self.licenses.items)
        self.assertNotIn(("user-1", h.DEFAULT_APP_ID), self.licenses.items)

    def test_an_order_written_before_this_ticket_settles_for_the_default_app(self):
        orig = h._mark_order_paid
        self.addCleanup(lambda: setattr(h, "_mark_order_paid", orig))
        h._mark_order_paid = lambda order_id, txn: {"orderId": order_id, "status": "paid"}

        h._settle_paid_order(
            {"orderId": "o2", "userId": "user-2", "planId": "monthly", "status": "pending"},
            "txn-2",
        )
        self.assertIn(("user-2", h.DEFAULT_APP_ID), self.licenses.items)


if __name__ == "__main__":
    unittest.main()


# ── Cloud fill metering (fill/quota, fill/consume) ───────────────────────────
# What these are for: the routes decide whether an export may spend GPU time on
# the inpaint service in serverless/cloud-inpaint, and count what it spent. Two
# things about that are worth a test more than the happy path is — that the
# count cannot be talked downwards or upwards by the client, and that the token
# this function mints is one that service will actually honour. A disagreement
# on the second is invisible here and looks, from the app, exactly like the
# service being down.

class FakeFillUsageTable:
    """
    In-memory stand-in for FillUsageTable, keyed (userKey, period).

    `update_item` implements only the one expression _fill_add sends — ADD on a
    counter, SET on the rest — because that is the only one this code produces,
    and a fake that accepted more would be claiming coverage it does not have.
    """

    def __init__(self, items=None):
        self.items = dict(items or {})

    @staticmethod
    def _key(d):
        return (d["userKey"], d["period"])

    def get_item(self, Key):
        item = self.items.get(self._key(Key))
        return {"Item": item} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ReturnValues=None):
        key = self._key(Key)
        item = self.items.setdefault(key, {"userKey": key[0], "period": key[1], "used": 0})
        item["used"] = int(item.get("used", 0)) + int(ExpressionAttributeValues[":units"])
        item["appId"] = ExpressionAttributeValues[":app"]
        item["updatedAt"] = ExpressionAttributeValues[":now"]
        item["expiresAt"] = ExpressionAttributeValues[":ttl"]
        return {"Attributes": {"used": item["used"]}}


class FillTestCase(unittest.TestCase):
    """
    A deployment with the feature switched on, an account holding a live
    licence, and an empty usage table.
    """

    APP = "shuyin"
    USER = "user-1"
    DEVICE = "d" * 64

    def setUp(self):
        for name in ("FILL_ENDPOINT_URL", "FILL_SIGNING_SECRET", "FILL_FREE_UNITS",
                     "FILL_OVERAGE_PRICE", "FILL_OVERAGE_ALLOWED",
                     "FILL_TOKEN_TTL_SECONDS"):
            original = getattr(h, name)
            self.addCleanup(lambda n=name, v=original: setattr(h, n, v))
        h.FILL_ENDPOINT_URL = "https://fill.example.com/inpaint"
        h.FILL_SIGNING_SECRET = "s" * 40
        h.FILL_FREE_UNITS = 100
        h.FILL_OVERAGE_PRICE = "¥0.30"
        h.FILL_OVERAGE_ALLOWED = False
        h.FILL_TOKEN_TTL_SECONDS = 900

        orig_table = h._fill_usage_table
        self.addCleanup(lambda: setattr(h, "_fill_usage_table", orig_table))
        self.table = FakeFillUsageTable()
        h._fill_usage_table = lambda: self.table

        orig_row = h._get_license_row
        self.addCleanup(lambda: setattr(h, "_get_license_row", orig_row))
        self.licensed(True)

    def licensed(self, yes: bool, expires_in: int = 30 * DAY):
        h._get_license_row = (
            (lambda user_id, app_id: {"expiresAt": int(time.time()) + expires_in})
            if yes else (lambda user_id, app_id: None))

    def quota(self, **over):
        body = {"appId": self.APP, "userId": self.USER, "deviceId": self.DEVICE}
        body.update(over)
        return json.loads(h._handle_fill_quota({"body": json.dumps(body)})["body"])

    def consume(self, units=1, **over):
        body = {"appId": self.APP, "userId": self.USER,
                "deviceId": self.DEVICE, "units": units}
        body.update(over)
        return json.loads(h._handle_fill_consume({"body": json.dumps(body)})["body"])


class FillQuotaTests(FillTestCase):
    def test_a_licensed_account_may_use_the_service(self):
        reply = self.quota()
        self.assertTrue(reply["allowed"])
        self.assertEqual(reply["remaining"], 100)
        self.assertEqual(reply["endpoint"]["url"], "https://fill.example.com/inpaint")
        self.assertIsNone(reply["reason"])

    def test_an_account_without_a_licence_may_not(self):
        # Their export still finishes — filled on their own machine, which is
        # what the app does when this says no.
        self.licensed(False)
        reply = self.quota()
        self.assertFalse(reply["allowed"])
        self.assertEqual(reply["reason"], "noLicense")
        self.assertIsNone(reply["endpoint"])

    def test_an_expired_licence_is_not_a_licence(self):
        self.licensed(True, expires_in=-DAY)
        self.assertFalse(self.quota()["allowed"])

    def test_a_device_with_no_user_may_not(self):
        # An allowance belongs to whoever paid. A machine that has not
        # identified itself has not paid.
        reply = self.quota(userId="")
        self.assertFalse(reply["allowed"])
        self.assertEqual(reply["reason"], "noLicense")

    def test_the_endpoint_never_travels_with_a_no(self):
        # The token is the only thing guarding the GPU, so it must not be
        # issued by a reply that just refused.
        self.licensed(False)
        self.assertIsNone(self.quota()["endpoint"])

    def test_a_deployment_with_no_endpoint_says_so_rather_than_guessing(self):
        h.FILL_ENDPOINT_URL = ""
        reply = self.quota()
        self.assertFalse(reply["allowed"])
        self.assertEqual(reply["reason"], "unavailable")

    def test_a_deployment_with_no_signing_secret_refuses_too(self):
        # Otherwise it would mint tokens signed with an empty string, which the
        # inpaint service refuses anyway — but from the app that reads as the
        # service being broken rather than switched off.
        h.FILL_SIGNING_SECRET = ""
        self.assertFalse(self.quota()["allowed"])

    def test_the_numbers_are_this_service_s(self):
        h.FILL_FREE_UNITS = 250
        h.FILL_OVERAGE_PRICE = "$0.05"
        reply = self.quota()
        self.assertEqual(reply["limit"], 250)
        self.assertEqual(reply["overagePrice"], "$0.05")
        self.assertTrue(reply["periodEnds"].endswith("-01T00:00:00Z"))

    def test_asking_does_not_spend_anything(self):
        self.quota()
        self.quota()
        self.assertEqual(self.quota()["used"], 0)

    def test_an_unconfigured_table_is_a_501_not_a_crash(self):
        h._fill_usage_table = lambda: None
        self.assertEqual(h._handle_fill_quota({"body": "{}"})["statusCode"], 501)

    def test_a_request_naming_nobody_is_refused(self):
        reply = h._handle_fill_quota({"body": json.dumps({"appId": self.APP})})
        self.assertEqual(reply["statusCode"], 400)

    def test_a_malformed_device_id_is_refused(self):
        # It ends up in a DynamoDB partition key by way of _fill_user_key.
        reply = h._handle_fill_quota({"body": json.dumps(
            {"appId": self.APP, "deviceId": "../../etc/passwd"})})
        self.assertEqual(reply["statusCode"], 400)

    def test_a_body_that_is_not_json_is_refused_rather_than_raising(self):
        reply = h._handle_fill_quota({"body": "not json at all"})
        self.assertEqual(reply["statusCode"], 400)


class FillConsumeTests(FillTestCase):
    def test_counting_is_what_moves_the_number(self):
        self.assertEqual(self.consume(1)["used"], 1)
        self.assertEqual(self.consume(1)["used"], 2)
        self.assertEqual(self.quota()["remaining"], 98)

    def test_an_export_that_used_nothing_is_not_one_of_the_hundred(self):
        # What the app sends when every batch fell back to the local filler.
        self.assertEqual(self.consume(0)["used"], 0)

    def test_a_negative_count_cannot_hand_back_spent_allowance(self):
        self.consume(5)
        self.assertEqual(self.consume(-4)["used"], 5)

    def test_an_enormous_count_cannot_burn_a_year_in_one_call(self):
        reply = self.consume(10 ** 9)
        self.assertEqual(reply["used"], h.FILL_MAX_UNITS_PER_CALL)

    def test_a_count_that_is_not_a_number_counts_as_nothing(self):
        self.assertEqual(self.consume("lots")["used"], 0)

    def test_the_allowance_runs_out(self):
        self.consume(h.FILL_MAX_UNITS_PER_CALL)
        reply = self.quota()
        self.assertEqual(reply["remaining"], 0)
        self.assertFalse(reply["allowed"])
        self.assertEqual(reply["reason"], "overLimit")
        # And the price is still reported, so the app can say what a further
        # export would cost even though it cannot make one.
        self.assertEqual(reply["overagePrice"], "¥0.30")

    def test_overage_is_a_switch_and_not_a_release(self):
        self.consume(h.FILL_MAX_UNITS_PER_CALL)
        h.FILL_OVERAGE_ALLOWED = True
        reply = self.quota()
        self.assertTrue(reply["allowed"])
        self.assertIsNone(reply["reason"])

    def test_the_count_is_kept_per_account_not_per_machine(self):
        self.consume(3)
        self.assertEqual(self.quota(deviceId="e" * 64)["used"], 3)

    def test_an_account_with_no_user_is_counted_against_its_device(self):
        self.licensed(False)
        self.consume(2, userId="")
        self.assertEqual(self.quota(userId="")["used"], 2)
        # And a different machine's count is its own.
        self.assertEqual(self.quota(userId="", deviceId="f" * 64)["used"], 0)

    def test_the_row_ages_out(self):
        self.consume(1)
        row = next(iter(self.table.items.values()))
        self.assertGreater(row["expiresAt"], int(time.time()) + 300 * DAY)


class FillTokenTests(FillTestCase):
    def test_the_token_says_who_and_when(self):
        now = int(time.time())
        token = h._mint_fill_token(self.APP, self.USER, now)
        payload = json.loads(base64.urlsafe_b64decode(
            token.split(".")[0] + "=" * (-len(token.split(".")[0]) % 4)))
        self.assertEqual(payload["app"], self.APP)
        self.assertEqual(payload["sub"], self.USER)
        self.assertEqual(payload["exp"], now + h.FILL_TOKEN_TTL_SECONDS)

    def test_fill_token_matches_the_inpaint_service(self):
        """
        The two halves of the token agree.

        This is the test worth having. `_mint_fill_token` here and `verify` in
        serverless/cloud-inpaint/auth.py are written from the same description
        and checked by nobody — and a disagreement between them is invisible on
        both sides: the service simply returns 401, the app falls back to the
        local filler, and everything looks like the service being down. So the
        real verifier is imported and run against a real token.
        """
        sys.path.insert(0, os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cloud-inpaint"))
        import auth  # noqa: PLC0415

        now = int(time.time())
        token = h._mint_fill_token(self.APP, self.USER, now)
        with unittest.mock.patch.dict(
                os.environ,
                {"FILL_SIGNING_SECRET": h.FILL_SIGNING_SECRET, "FILL_APP_ID": self.APP}):
            payload = auth.verify(token, now=now)
        self.assertEqual(payload["sub"], self.USER)

    def test_a_token_this_service_did_not_sign_is_not_honoured_there(self):
        # The other direction: proves the check above is checking something.
        sys.path.insert(0, os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cloud-inpaint"))
        import auth  # noqa: PLC0415

        now = int(time.time())
        token = h._mint_fill_token(self.APP, self.USER, now)
        with unittest.mock.patch.dict(
                os.environ, {"FILL_SIGNING_SECRET": "a different secret entirely"}):
            with self.assertRaises(auth.Unauthorised):
                auth.verify(token, now=now)


class FillPeriodTests(unittest.TestCase):
    def test_a_period_is_a_calendar_month_in_utc(self):
        # 2026-09-23T12:00:00Z
        self.assertEqual(h._fill_period(1790164800), "2026-09")

    def test_december_rolls_into_the_next_year(self):
        # 2026-12-31T23:00:00Z — the case an off-by-one here gets wrong, and
        # gets wrong once a year.
        self.assertEqual(h._fill_period_ends(1798758000), "2027-01-01T00:00:00Z")

    def test_the_period_ends_at_the_start_of_the_next_month(self):
        self.assertEqual(h._fill_period_ends(1790164800), "2026-10-01T00:00:00Z")
