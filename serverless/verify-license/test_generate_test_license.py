"""
Unit tests for generate_test_license.py — the out-of-band test-code minter.

What is worth testing here is exactly the property the script exists for: a
code it prints is one *this* handler accepts. So the assertions run the minted
key and token back through handler.py's own validators, verify route and
signing, rather than re-checking the shapes the script produced.

Stdlib only (unittest), matching test_handler.py. Run with:

    cd serverless/verify-license && python3 -m unittest test_generate_test_license -v
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import generate_test_license as g  # noqa: E402
import handler as h  # noqa: E402

DAY = 86400


def decode_token(token):
    """The claims, after checking the signature the same way the client does."""
    header, payload, sig = token.split(".")
    expected = hmac.new(h.SIGNING_SECRET.encode(), f"{header}.{payload}".encode(),
                        hashlib.sha256).hexdigest()
    assert hmac.compare_digest(sig, expected), "token signature does not verify"
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


class FakeLicensesTable:
    """Enough of the DynamoDB Table object for write_license()."""

    def __init__(self):
        self.items = {}

    def put_item(self, Item):  # noqa: N803 — boto3's own casing
        self.items[(Item["userId"], Item["appId"])] = Item


class KeyFormatTests(unittest.TestCase):
    def test_generated_key_is_one_the_service_accepts(self):
        for _ in range(20):
            key = g.generate_license_key()
            self.assertTrue(h._valid_license_key_format(key), key)
            self.assertTrue(key.startswith("TEST-"), key)

    def test_keys_do_not_repeat(self):
        keys = {g.generate_license_key() for _ in range(50)}
        self.assertEqual(len(keys), 50)

    def test_a_prefix_that_would_make_an_invalid_key_is_refused(self):
        # "#" is outside ^[A-Za-z0-9_-]+ — and is the separator DemosTable's
        # composite key uses, so it is exactly the character that must not
        # slip through.
        with self.assertRaises(ValueError):
            g.generate_license_key("BAD#PREFIX")

    def test_an_empty_prefix_still_makes_a_valid_key(self):
        key = g.generate_license_key("")
        self.assertTrue(h._valid_license_key_format(key), key)
        self.assertFalse(key.startswith("-"), key)


class MintTests(unittest.TestCase):
    def test_token_verifies_and_carries_the_app_id(self):
        minted = g.mint(app_id="shuyin", plan_id="annual")
        claims = decode_token(minted["token"])
        self.assertEqual(claims["appId"], "shuyin")
        self.assertEqual(claims["planId"], "annual")
        self.assertEqual(claims["licenseKey"], minted["licenseKey"])
        self.assertEqual(claims["expiresAt"], minted["expiresAt"])
        self.assertEqual(claims["features"], h.ALLOWED_FEATURES)

    def test_length_comes_from_the_plan(self):
        for plan_id, plan in h.PLANS.items():
            minted = g.mint(app_id="shuyin", plan_id=plan_id, now=1_000_000)
            self.assertEqual(minted["durationDays"], plan["durationDays"], plan_id)
            self.assertEqual(minted["expiresAt"], 1_000_000 + plan["durationDays"] * DAY)

    def test_the_demo_plan_is_demo_days_long_not_monthly(self):
        minted = g.mint(app_id="shuyin", plan_id=h.DEMO_PLAN_ID, now=1_000_000)
        self.assertEqual(minted["durationDays"], h.DEMO_DAYS)

    def test_an_unknown_plan_is_an_error_rather_than_a_silent_monthly(self):
        with self.assertRaises(ValueError):
            g.mint(app_id="shuyin", plan_id="lifetime")

    def test_negative_days_mints_an_already_expired_licence(self):
        now = int(time.time())
        minted = g.mint(app_id="shuyin", days=-1, now=now)
        self.assertLess(minted["expiresAt"], now)

    def test_the_derived_user_id_matches_what_the_custom_provider_derives(self):
        minted = g.mint(app_id="shuyin")
        self.assertEqual(minted["userId"],
                         h._check_payment_provider(minted["licenseKey"])["userId"])

    def test_an_explicit_user_id_is_kept(self):
        minted = g.mint(app_id="shuyin", user_id="qa-team")
        self.assertEqual(minted["userId"], "qa-team")
        self.assertEqual(decode_token(minted["token"])["userId"], "qa-team")

    def test_an_invalid_app_id_is_refused(self):
        with self.assertRaises(ValueError):
            g.mint(app_id="shu#yin")

    def test_an_explicit_key_is_used_as_given(self):
        minted = g.mint(app_id="shuyin", license_key="QA-FIXED-KEY-001")
        self.assertEqual(minted["licenseKey"], "QA-FIXED-KEY-001")

    def test_an_explicit_key_the_service_would_refuse_is_refused_here(self):
        with self.assertRaises(ValueError):
            g.mint(app_id="shuyin", license_key="short")


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.table = FakeLicensesTable()
        self._real = h._licenses_table
        h._licenses_table = lambda: self.table

    def tearDown(self):
        h._licenses_table = self._real

    def test_the_row_is_keyed_and_shaped_the_way_the_service_writes_one(self):
        minted = g.mint(app_id="shuyin", plan_id="quarterly")
        g.write_license(minted)
        item = self.table.items[(minted["userId"], "shuyin")]
        self.assertEqual(set(item), {"userId", "appId", "token", "planId",
                                     "licenseKey", "expiresAt", "updatedAt"})
        self.assertEqual(item["licenseKey"], minted["licenseKey"])
        self.assertEqual(item["expiresAt"], minted["expiresAt"])

    def test_an_unconfigured_table_is_an_error_not_a_silent_no_op(self):
        h._licenses_table = lambda: None
        with self.assertRaises(RuntimeError):
            g.write_license(g.mint(app_id="shuyin"))


class VerifyRouteTests(unittest.TestCase):
    """The end the codes are for: POST / with the key, as the client sends it."""

    def setUp(self):
        self.table = FakeLicensesTable()
        self._real_licenses = h._licenses_table
        self._real_find = h._find_license_by_key
        h._licenses_table = lambda: self.table
        h._find_license_by_key = self._find

    def tearDown(self):
        h._licenses_table = self._real_licenses
        h._find_license_by_key = self._real_find

    def _find(self, license_key):
        for item in self.table.items.values():
            if item["licenseKey"] == license_key:
                return item
        return None

    def _post(self, body):
        return h.handler({"httpMethod": "POST", "rawPath": "/", "body": json.dumps(body)}, None)

    def test_a_written_code_activates_and_keeps_its_own_expiry(self):
        minted = g.mint(app_id="shuyin", plan_id="annual")
        g.write_license(minted)

        resp = self._post({"licenseKey": minted["licenseKey"], "appId": "shuyin"})
        body = json.loads(resp["body"])
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(body["valid"])
        # The stored expiry, not EXPIRY_DAYS from now: re-verifying a key must
        # not push an annual plan's end date around.
        self.assertEqual(decode_token(body["token"])["expiresAt"], minted["expiresAt"])
        self.assertEqual(body["appId"], "shuyin")

    def test_a_code_minted_for_one_app_is_refused_by_the_other(self):
        minted = g.mint(app_id="shuyin")
        g.write_license(minted)

        resp = self._post({"licenseKey": minted["licenseKey"], "appId": "smoothvoice"})
        body = json.loads(resp["body"])
        self.assertEqual(resp["statusCode"], 403)
        self.assertEqual(body["code"], "app_id_mismatch")
        self.assertEqual(body["appId"], "shuyin")

    def test_an_unwritten_code_still_verifies_under_the_custom_provider(self):
        minted = g.mint(app_id="shuyin")
        resp = self._post({"licenseKey": minted["licenseKey"], "appId": "shuyin"})
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(decode_token(json.loads(resp["body"])["token"])["userId"],
                         minted["userId"])


class CliTests(unittest.TestCase):
    def test_json_output_is_parseable_and_carries_every_code(self):
        import contextlib, io  # noqa: PLC0415

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = g.main(["--app-id", "shuyin", "--count", "3", "--json"])
        self.assertEqual(code, 0)
        parsed = json.loads(out.getvalue())
        self.assertFalse(parsed["written"])
        self.assertEqual(len(parsed["licenses"]), 3)
        self.assertEqual(len({lic["licenseKey"] for lic in parsed["licenses"]}), 3)

    def test_an_unknown_plan_exits_nonzero_rather_than_printing_a_code(self):
        import contextlib, io  # noqa: PLC0415

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = g.main(["--plan", "lifetime"])
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("unknown plan", err.getvalue())

    def test_an_explicit_key_mints_exactly_one_however_many_were_asked_for(self):
        import contextlib, io  # noqa: PLC0415

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            g.main(["--key", "QA-FIXED-KEY-001", "--count", "5", "--json"])
        self.assertEqual(len(json.loads(out.getvalue())["licenses"]), 1)


if __name__ == "__main__":
    unittest.main()
