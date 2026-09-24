"""
The routes, exercised without the model.

`inpaint.fill` is stubbed throughout: what is worth testing here is the
contract the desktop client is written against — who is let in, what sizes are
refused, and that a frame survives the WebP round trip — and none of that
changes with 208 MB of ONNX loaded. It also keeps this suite, which is the
pre-deploy gate, to seconds.
"""
from __future__ import annotations

import base64
import time
import unittest
from unittest import mock

import cv2
import numpy as np
from fastapi.testclient import TestClient

import app
import auth
import inpaint

SECRET = 'a' * 40
SIZE = (24, 32)  # height, width — small, and not square, which has caught bugs


def token(**overrides):
    payload = {'app': 'shuyin', 'sub': 'user-1', 'exp': time.time() + 300}
    payload.update(overrides)
    return auth.sign(payload, SECRET)


def encoded_frame(fill=127):
    frame = np.full((*SIZE, 3), fill, np.uint8)
    ok, buf = cv2.imencode('.webp', frame, [cv2.IMWRITE_WEBP_QUALITY, 90])
    assert ok
    return base64.b64encode(buf.tobytes()).decode('ascii')


def encoded_mask():
    mask = np.zeros(SIZE, np.uint8)
    mask[4:12, 6:20] = 255
    ok, buf = cv2.imencode('.png', mask)
    assert ok
    return base64.b64encode(buf.tobytes()).decode('ascii')


def a_job(frames=1):
    return {'mask_png': encoded_mask(),
            'frames_webp': [encoded_frame() for _ in range(frames)]}


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.api, raise_server_exceptions=False)
        self.env = mock.patch.dict(
            app.os.environ,
            {'FILL_SIGNING_SECRET': SECRET, 'FILL_APP_ID': 'shuyin'},
            clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        # Hands back what it was given, so a failure is about the plumbing
        # rather than about what the model painted.
        self.filled = mock.patch.object(
            inpaint, 'fill', side_effect=lambda patches, mask: patches)
        self.filled.start()
        self.addCleanup(self.filled.stop)

    def post(self, body, bearer=None):
        headers = {'Authorization': f'Bearer {bearer}'} if bearer else {}
        return self.client.post('/inpaint', json=body, headers=headers)

    def test_health_answers_without_a_token(self):
        # And without touching the model: a public URL that loaded 208 MB for
        # anyone who asked would be a cold start a stranger can buy.
        with mock.patch.object(inpaint, 'session',
                               side_effect=AssertionError('must not load')):
            reply = self.client.get('/health')
        self.assertEqual(reply.status_code, 200)
        self.assertTrue(reply.json()['ok'])

    def test_readiness_needs_a_token(self):
        self.assertEqual(self.client.get('/ready').status_code, 401)

    def test_readiness_reports_the_model_loading(self):
        with mock.patch.object(inpaint, 'session', return_value=object()):
            reply = self.client.get(
                '/ready', headers={'Authorization': f'Bearer {token()}'})
        self.assertEqual(reply.status_code, 200)

    def test_readiness_reports_a_model_that_will_not_load(self):
        with mock.patch.object(inpaint, 'session',
                               side_effect=RuntimeError('no file')):
            reply = self.client.get(
                '/ready', headers={'Authorization': f'Bearer {token()}'})
        self.assertEqual(reply.status_code, 503)

    def test_a_job_without_a_token_is_refused(self):
        self.assertEqual(self.post(a_job()).status_code, 401)

    def test_a_job_with_a_forged_token_is_refused(self):
        forged = auth.sign({'app': 'shuyin', 'exp': time.time() + 300}, 'z' * 40)
        self.assertEqual(self.post(a_job(), forged).status_code, 401)

    def test_a_job_with_an_expired_token_is_refused(self):
        self.assertEqual(
            self.post(a_job(), token(exp=time.time() - 3600)).status_code, 401)

    def test_the_token_is_checked_before_the_job_is_decoded(self):
        # Otherwise an unauthenticated caller can still make the service do the
        # base64 and image decoding of a very large body.
        with mock.patch.object(app, '_decode',
                               side_effect=AssertionError('decoded too early')):
            self.assertEqual(self.post(a_job()).status_code, 401)

    def test_a_signed_job_comes_back_frame_for_frame(self):
        reply = self.post(a_job(frames=3), token())
        self.assertEqual(reply.status_code, 200)
        frames = reply.json()['frames_webp']
        self.assertEqual(len(frames), 3)
        for blob in frames:
            raw = base64.b64decode(blob, validate=True)
            patch = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            self.assertEqual(patch.shape[:2], SIZE)

    def test_an_empty_job_is_refused(self):
        body = a_job()
        body['frames_webp'] = []
        self.assertEqual(self.post(body, token()).status_code, 400)

    def test_a_job_over_the_cap_is_refused(self):
        with mock.patch.dict(app.os.environ, {'MAX_FRAMES_PER_JOB': '2'}):
            self.assertEqual(self.post(a_job(frames=3), token()).status_code, 413)
            self.assertEqual(self.post(a_job(frames=2), token()).status_code, 200)

    def test_a_frame_that_is_not_the_mask_size_is_refused(self):
        body = a_job()
        other = np.full((SIZE[0] + 4, SIZE[1], 3), 60, np.uint8)
        ok, buf = cv2.imencode('.webp', other)
        assert ok
        body['frames_webp'] = [base64.b64encode(buf.tobytes()).decode('ascii')]
        self.assertEqual(self.post(body, token()).status_code, 400)

    def test_something_that_is_not_an_image_is_refused(self):
        body = a_job()
        body['mask_png'] = base64.b64encode(b'not a png').decode('ascii')
        self.assertEqual(self.post(body, token()).status_code, 400)

    def test_something_that_is_not_base64_is_refused(self):
        body = a_job()
        body['mask_png'] = 'not base64 at all!!'
        self.assertEqual(self.post(body, token()).status_code, 400)


class CapTest(unittest.TestCase):
    def test_the_cap_comes_from_the_environment(self):
        with mock.patch.dict(app.os.environ, {'MAX_FRAMES_PER_JOB': '60'}):
            self.assertEqual(app.max_frames_per_job(), 60)

    def test_an_unset_or_nonsense_cap_falls_back_to_the_default(self):
        for value in ['', 'lots', '0', '-5']:
            with self.subTest(value=value):
                with mock.patch.dict(app.os.environ,
                                     {'MAX_FRAMES_PER_JOB': value}):
                    self.assertEqual(app.max_frames_per_job(),
                                     app.DEFAULT_MAX_FRAMES_PER_JOB)

    def test_the_default_matches_what_the_client_sends(self):
        # The client's cloud_fill.FRAMES_PER_REQUEST. A service that caps below what the
        # client batches refuses every job, and the client's only answer is to
        # fill locally — which looks exactly like the service being down.
        self.assertEqual(app.DEFAULT_MAX_FRAMES_PER_JOB, 240)


if __name__ == '__main__':
    unittest.main()


class ModelFrameTest(unittest.TestCase):
    """
    How a patch is put in front of the model.

    This has one job that is easy to get wrong in the direction nobody
    notices: a patch scaled *up* to fill the model's input measured 90 levels
    of error against a known frame where the same patch at 1:1 measured 6 —
    worse than the local filler this service exists to beat, at GPU prices.
    Nothing crashes when that happens; the fill just quietly becomes invention.
    """

    def _frame(self, width, height):
        patch = np.zeros((height, width, 3), np.uint8)
        mask = np.zeros((height, width), np.uint8)
        mask[height // 4:height // 2, width // 4:width // 2] = 1
        return inpaint._to_model_frame(patch, mask)

    def test_a_small_patch_is_not_scaled_up(self):
        _, _, working = self._frame(119, 68)
        self.assertEqual(working, (119, 68))

    def test_a_patch_the_size_of_the_input_is_left_alone(self):
        side = inpaint.MODEL_SIDE
        _, _, working = self._frame(side, side // 2)
        self.assertEqual(working, (side, side // 2))

    def test_a_patch_too_big_for_the_graph_is_scaled_down(self):
        _, _, working = self._frame(1024, 512)
        self.assertLessEqual(max(working), inpaint.MODEL_SIDE)
        # And in proportion, so nothing is squashed.
        self.assertEqual(working, (inpaint.MODEL_SIDE, inpaint.MODEL_SIDE // 2))

    def test_whatever_the_size_the_tensors_are_the_square_the_graph_wants(self):
        for width, height in [(119, 68), (1024, 300), (10, 600)]:
            with self.subTest(size=(width, height)):
                image, grown, _ = self._frame(width, height)
                self.assertEqual(image.shape[:2],
                                 (inpaint.MODEL_SIDE, inpaint.MODEL_SIDE))
                self.assertEqual(grown.shape, (inpaint.MODEL_SIDE, inpaint.MODEL_SIDE))

    def test_the_padding_is_not_something_the_model_is_asked_to_repaint(self):
        # Reflected picture in the padding gives the model plausible context;
        # a mask that reached into it would have it invent there instead.
        _, grown, working = self._frame(119, 68)
        self.assertEqual(grown[working[1]:, :].sum(), 0)
        self.assertEqual(grown[:, working[0]:].sum(), 0)
