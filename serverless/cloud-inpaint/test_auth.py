"""
What the service will and will not honour.

Every test here is about refusing something. That is the shape of the problem:
this is the only thing standing between a public Function URL and a stranger's
inpainting service running on our bill, and its failure mode is silent — a
token check that is too generous does not break anything visibly, it just
quietly stops being a check.
"""
from __future__ import annotations

import time
import unittest
from unittest import mock

import auth

SECRET = 'a' * 40
OTHER_SECRET = 'b' * 40


def a_token(secret=SECRET, **overrides):
    payload = {'app': 'shuyin', 'sub': 'user-1', 'exp': time.time() + 300}
    payload.update(overrides)
    return auth.sign(payload, secret)


def with_env(**values):
    return mock.patch.dict(auth.os.environ, values, clear=False)


class VerifyTest(unittest.TestCase):
    def test_a_token_this_service_signed_is_honoured(self):
        with with_env(FILL_SIGNING_SECRET=SECRET, FILL_APP_ID='shuyin'):
            payload = auth.verify(a_token())
        self.assertEqual(payload['sub'], 'user-1')

    def test_a_token_signed_with_another_secret_is_not(self):
        with with_env(FILL_SIGNING_SECRET=SECRET):
            with self.assertRaises(auth.Unauthorised):
                auth.verify(a_token(secret=OTHER_SECRET))

    def test_a_payload_edited_after_signing_is_not(self):
        with with_env(FILL_SIGNING_SECRET=SECRET):
            body, _, signature = a_token().partition('.')
            forged = auth._b64url_encode(b'{"app":"shuyin","exp":99999999999}')
            with self.assertRaises(auth.Unauthorised):
                auth.verify(f'{forged}.{signature}')

    def test_an_expired_token_is_not(self):
        with with_env(FILL_SIGNING_SECRET=SECRET):
            with self.assertRaises(auth.Unauthorised):
                auth.verify(a_token(exp=time.time() - 3600))

    def test_expiry_allows_a_little_clock_skew(self):
        # Just inside the allowance: the two machines disagreeing by a few
        # seconds must not cost a user their export.
        with with_env(FILL_SIGNING_SECRET=SECRET):
            now = time.time()
            payload = auth.verify(
                a_token(exp=now - auth.CLOCK_SKEW_SECONDS + 5), now=now)
        self.assertEqual(payload['sub'], 'user-1')

    def test_a_token_with_no_expiry_is_not_honoured(self):
        # A token that never expires is a password, and this service has no
        # way to withdraw one.
        with with_env(FILL_SIGNING_SECRET=SECRET):
            token = auth.sign({'app': 'shuyin', 'sub': 'user-1'}, SECRET)
            with self.assertRaises(auth.Unauthorised):
                auth.verify(token)

    def test_a_token_for_another_app_is_not(self):
        with with_env(FILL_SIGNING_SECRET=SECRET, FILL_APP_ID='shuyin'):
            with self.assertRaises(auth.Unauthorised):
                auth.verify(a_token(app='smoothvoice'))

    def test_an_empty_app_id_accepts_any_app(self):
        with with_env(FILL_SIGNING_SECRET=SECRET, FILL_APP_ID=''):
            self.assertEqual(auth.verify(a_token(app='anything'))['app'], 'anything')

    def test_a_deployment_with_no_secret_honours_nothing(self):
        # Including a token that is otherwise perfectly well-formed: a service
        # that cannot tell a good token from a forged one must honour neither.
        with with_env(FILL_SIGNING_SECRET=''):
            with self.assertRaises(auth.Unauthorised):
                auth.verify(a_token())

    def test_rubbish_is_refused_rather_than_raising_something_else(self):
        with with_env(FILL_SIGNING_SECRET=SECRET):
            for token in ['', '.', 'nodot', 'a.b', '!!!.???', 'a.' + '=' * 5]:
                with self.subTest(token=token):
                    with self.assertRaises(auth.Unauthorised):
                        auth.verify(token)


class BearerTest(unittest.TestCase):
    def test_reads_the_token_out_of_the_header(self):
        self.assertEqual(auth.bearer('Bearer abc'), 'abc')

    def test_the_scheme_is_case_insensitive(self):
        self.assertEqual(auth.bearer('bearer abc'), 'abc')

    def test_anything_else_is_refused(self):
        for header in [None, '', 'abc', 'Basic abc', 'Bearer', 'Bearer   ']:
            with self.subTest(header=header):
                with self.assertRaises(auth.Unauthorised):
                    auth.bearer(header)


if __name__ == '__main__':
    unittest.main()
