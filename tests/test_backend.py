import base64
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from backend.app import app, build_request, Scan, verdict
from experiments.youtube_frames import QUESTIONS


def payload():
    return {"videoId": "XnWESGXnGwY", "start": 3, "end": 6, "ageBand": "6-8",
            "customRules": ["Avoid political campaigns"], "frames": [
                {"timestamp": t, "jpeg": "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xfftest").decode()}
                for t in [3.1, 4.1, 5.1]]}


class BackendTests(unittest.TestCase):
    def test_other_youtube_video_ids_are_accepted(self):
        for video_id in ["aqz-KE-bpKQ", "wiiFgsDJ8xk"]:
            self.assertEqual(Scan(**{**payload(), "videoId": video_id}).videoId, video_id)
        for video_id in ["tiktok:7675478347278863629", "instagram:DfF3eqGSKKc", "reddit:page-1x2y3z"]:
            self.assertEqual(Scan(**{**payload(), "videoId": video_id}).videoId, video_id)
        for video_id in ["bad", "https://www.youtube.com/watch?v=XnWESGXnGwY", "../private",
                         "tiktok:", "TikTok:123", "x:12/34", "reddit:../etc"]:
            with self.assertRaises(ValueError):
                Scan(**{**payload(), "videoId": video_id})

    def test_frames_and_rules_share_one_request(self):
        body = build_request(Scan(**payload()))
        self.assertEqual(sum(c["type"] == "input_image" for c in body["input"][0]["content"]), 3)
        self.assertEqual(len(body["questions"]), len(QUESTIONS) + 1)
        self.assertEqual(body["questions"][-1]["name"], "family_rule_0")

    def test_topic_tags_do_not_block_but_custom_rules_do(self):
        scores = dict.fromkeys(QUESTIONS, 0)
        scores["political_content"] = scores["religious_content"] = 1
        self.assertEqual(verdict(scores, "3-5")["status"], "safe")
        scores["family_rule_0"] = .9
        self.assertEqual(verdict(scores, "3-5")["status"], "blocked")

    def test_age_thresholds_and_uncertainty(self):
        scores = dict.fromkeys(QUESTIONS, 0)
        scores["violence"] = .6
        self.assertEqual(verdict(scores, "3-5")["status"], "blocked")
        self.assertEqual(verdict(scores, "6-8")["status"], "review")
        self.assertEqual(verdict(scores, "9-12")["status"], "safe")

    def test_bad_or_missing_frames_rejected_before_api(self):
        with TestClient(app) as client:
            for mutate in [lambda p: p.update(frames=[]), lambda p: p.update(end=20),
                           lambda p: p["frames"].pop(),
                           lambda p: p["frames"][0].update(jpeg="https://example.com/a.jpg"),
                           lambda p: p["frames"][0].update(timestamp=float("inf"))]:
                value = payload(); mutate(value)
                if value["frames"] and value["frames"][0]["timestamp"] == float("inf"):
                    with self.assertRaises(ValueError): Scan(**value)
                else:
                    self.assertEqual(client.post("/classify", json=value).status_code, 422)

    def test_live_contract_and_failure_never_safe(self):
        async def respond(request):
            return httpx.Response(200, json={"answers": [
                {"type": "predicate", "name": name, "probability": .95 if name == "violence" else .01}
                for name in [*QUESTIONS, "family_rule_0"]]})
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-only"}), TestClient(app) as client:
            original = app.state.client
            app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
            response = client.post("/classify", json=payload())
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "blocked")
            self.assertEqual(response.json()["frameCount"], 3)
            self.assertFalse(response.json()["audioAnalyzed"])
            async def refused(request):
                return httpx.Response(200, json={"answers": []})
            app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(refused))
            self.assertEqual(client.post("/classify", json=payload()).status_code, 502)
            app.state.client = original

    def test_arbitrary_web_origin_rejected(self):
        with TestClient(app) as client:
            self.assertEqual(client.post("/classify", json=payload(), headers={"Origin": "https://www.youtube.com"}).status_code, 403)


if __name__ == "__main__":
    unittest.main()
