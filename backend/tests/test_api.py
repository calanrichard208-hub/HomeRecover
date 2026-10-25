import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_tmp = tempfile.mkdtemp()
os.environ["HOMERECOVER_DB"] = os.path.join(_tmp, "test.db")
os.environ.pop("ANTHROPIC_API_KEY", None)

from app import extract, server  # noqa: E402


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.make_server("127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            return resp.status, json.loads(raw)
        except ValueError:
            return resp.status, raw.decode()

    def new_family(self):
        status, data = self.call("POST", "/api/families", {"name": "Test family"})
        self.assertEqual(status, 201)
        return data["code"]

    @staticmethod
    def checkin(i, date, pain, fever=None, created=None):
        return {"id": f"c{i}", "kind": "checkin", "created_at": created or f"{date}T09:00:00.000Z",
                "data": {"date": date, "pain": pain, "fever_f": fever, "wound_discharge": False, "by": "Meena"}}


class FamilyAndEvents(ApiTestCase):
    def test_health(self):
        self.assertEqual(self.call("GET", "/api/health"), (200, {"ok": True}))

    def test_create_and_get_family(self):
        code = self.new_family()
        self.assertEqual(len(code), 8)
        status, fam = self.call("GET", f"/api/families/{code}")
        self.assertEqual((status, fam["name"], fam["plan"]), (200, "Test family", None))

    def test_unknown_family_is_404(self):
        self.assertEqual(self.call("GET", "/api/families/ABCDEFGH")[0], 404)

    def test_family_needs_a_name(self):
        self.assertEqual(self.call("POST", "/api/families", {"name": "  "})[0], 400)

    def test_plan_last_write_wins(self):
        code = self.new_family()
        new = {"plan": {"patient_name": "New"}, "updated_at": "2026-10-02T10:00:00.000Z"}
        old = {"plan": {"patient_name": "Old"}, "updated_at": "2026-10-01T10:00:00.000Z"}
        self.assertEqual(self.call("PUT", f"/api/families/{code}/plan", new)[1], {"replaced": True})
        self.assertEqual(self.call("PUT", f"/api/families/{code}/plan", old)[1], {"replaced": False})
        self.assertEqual(self.call("GET", f"/api/families/{code}")[1]["plan"]["patient_name"], "New")

    def test_duplicate_events_are_ignored_and_since_works(self):
        code = self.new_family()
        evs = [self.checkin(1, "2026-10-01", 3), self.checkin(2, "2026-10-02", 2)]
        self.assertEqual(self.call("POST", f"/api/families/{code}/events", {"events": evs})[1], {"accepted": 2})
        self.assertEqual(self.call("POST", f"/api/families/{code}/events", {"events": evs})[1], {"accepted": 0})
        _, got = self.call("GET", f"/api/families/{code}/events")
        self.assertEqual(len(got["events"]), 2)
        _, later = self.call("GET", f"/api/families/{code}/events?since={got['events'][0]['seq']}")
        self.assertEqual([e["id"] for e in later["events"]], ["c2"])

    def test_dose_events_are_stored(self):
        code = self.new_family()
        dose = {"id": "d1", "kind": "dose", "created_at": "2026-10-01T08:05:00.000Z",
                "data": {"slot": "2026-10-01|08:00|Tab A", "medicine": "Tab A", "by": "Ravi",
                         "taken_at": "2026-10-01T08:05:00.000Z"}}
        self.assertEqual(self.call("POST", f"/api/families/{code}/events", {"events": [dose]})[1], {"accepted": 1})

    def test_validation_rejects_bad_events(self):
        code = self.new_family()
        bad = [
            self.checkin(1, "2026-10-01", 11),
            self.checkin(2, "not-a-date", 3),
            self.checkin(3, "2026-10-01", 3, fever=150),
            {"id": "x", "kind": "weird", "created_at": "now", "data": {}},
            {"id": "bad id!", "kind": "dose", "created_at": "now", "data": {}},
        ]
        for ev in bad:
            with self.subTest(ev["id"]):
                self.assertEqual(self.call("POST", f"/api/families/{code}/events", {"events": [ev]})[0], 400)

    def test_status_uses_trend_engine(self):
        code = self.new_family()
        plan = {"plan": {"discharge_date": "2026-10-01", "red_flags": {"fever_limit_f": 100.4, "pain_limit": 8}},
                "updated_at": "2026-10-01T00:00:00.000Z"}
        self.call("PUT", f"/api/families/{code}/plan", plan)
        evs = [self.checkin(i, f"2026-10-0{i}", i) for i in (1, 2, 3)]
        self.call("POST", f"/api/families/{code}/events", {"events": evs})
        _, st = self.call("GET", f"/api/families/{code}/status")
        self.assertEqual(st["status"], "WARN")
        self.assertEqual(st["findings"][0]["code"], "PAIN_RISING")
        self.assertEqual(st["days_logged"], 3)

    def test_status_without_plan_is_ok(self):
        code = self.new_family()
        self.assertEqual(self.call("GET", f"/api/families/{code}/status")[1]["status"], "OK")

    def test_bad_json_and_unknown_routes(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/families", "{not json", {"Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 400)
        conn.close()
        self.assertEqual(self.call("GET", "/api/nope")[0], 404)
        self.assertEqual(self.call("DELETE", "/api/health")[0], 405)


class StaticFiles(ApiTestCase):
    def raw_get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", "replace")
        ctype = resp.getheader("Content-Type")
        conn.close()
        return resp.status, ctype, body

    def test_app_and_assets_are_served_with_the_right_types(self):
        status, ctype, body = self.raw_get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn("HomeRecover", body)
        self.assertIn("text/javascript", self.raw_get("/js/app.js")[1])
        self.assertIn("text/css", self.raw_get("/styles.css")[1])
        self.assertIn("json", self.raw_get("/manifest.json")[1])

    def test_paths_outside_the_frontend_folder_are_never_served(self):
        for path in ("/../backend/app/db.py", "/..%2fbackend/app/db.py", "/%2e%2e/backend/app/db.py",
                     "/js/../../backend/app/db.py"):
            with self.subTest(path):
                _, _, body = self.raw_get(path)
                self.assertNotIn("sqlite3", body)
                self.assertNotIn("CREATE TABLE", body)


class Extraction(ApiTestCase):
    def test_extract_is_503_without_key(self):
        status, data = self.call("POST", "/api/extract", {"text": "Tab A twice daily"})
        self.assertEqual(status, 503)
        self.assertIn("not switched on", data["error"])

    def test_extract_with_mocked_ai(self):
        answer = json.dumps({
            "patient_name": "Raman", "procedure": "Bypass surgery", "doctor_phone": "+91 98765 43210",
            "medicines": [{"name": "Tab Aspirin", "dose": "75 mg", "times": ["08:00"], "notes": "after food"}],
            "red_flag_text": ["Fever above 100.4 F", "Wound swelling"], "fever_limit_f": 100.4, "pain_limit": None,
        })
        with mock.patch.object(extract, "call_claude", return_value="```json\n" + answer + "\n```"):
            status, data = self.call("POST", "/api/extract", {"text": "summary"})
        self.assertEqual(status, 200)
        plan = data["plan"]
        self.assertEqual(plan["medicines"][0]["times"], ["08:00"])
        self.assertTrue(plan["red_flags"]["fever_from_summary"])
        self.assertFalse(plan["red_flags"]["pain_from_summary"])  # family must confirm this one
        self.assertEqual(plan["red_flags"]["pain_limit"], 8)

    def test_extract_garbage_answer_is_502(self):
        with mock.patch.object(extract, "call_claude", return_value="Sorry, I cannot help"):
            self.assertEqual(self.call("POST", "/api/extract", {"text": "x"})[0], 502)

    def test_extract_needs_input(self):
        with mock.patch.object(extract, "call_claude", return_value="{}"):
            self.assertEqual(self.call("POST", "/api/extract", {})[0], 502)


class NormalizePlan(unittest.TestCase):
    def test_messy_input_never_crashes(self):
        for raw in (None, "text", [], {"medicines": "nope"}, {"medicines": [None, 5, {"name": ""}]}):
            plan = extract.normalize_plan(raw)
            self.assertEqual(plan["medicines"], [])
            self.assertEqual(plan["red_flags"]["fever_limit_f"], 100.4)

    def test_times_are_cleaned_and_guess_is_marked(self):
        plan = extract.normalize_plan({"medicines": [
            {"name": "A", "times": ["8:00", "25:00", "20:00", "20:00"]},
            {"name": "B", "times": ["soon"]},
        ]})
        self.assertEqual(plan["medicines"][0]["times"], ["08:00", "20:00"])
        self.assertFalse(plan["medicines"][0]["times_guessed"])
        self.assertTrue(plan["medicines"][1]["times_guessed"])

    def test_silly_limits_fall_back_to_defaults(self):
        plan = extract.normalize_plan({"fever_limit_f": 500, "pain_limit": 40})
        self.assertFalse(plan["red_flags"]["fever_from_summary"])
        self.assertFalse(plan["red_flags"]["pain_from_summary"])

    def test_phone_is_cleaned(self):
        self.assertEqual(extract.normalize_plan({"doctor_phone": "tel:+91 98<script>"})["doctor_phone"], "+91 98")


if __name__ == "__main__":
    unittest.main()
