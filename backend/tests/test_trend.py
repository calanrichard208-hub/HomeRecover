import json
import os
import sys
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app.trend import (  # noqa: E402
    CheckIn, RedFlagLimits, assess, daily_checkins, OK, WARN, RED_FLAG,
)

with open(os.path.join(ROOT, "shared", "trend_cases.json"), encoding="utf-8") as f:
    CASES = json.load(f)


class SharedCases(unittest.TestCase):
    """The same cases are run against frontend/js/trend.js, so both stay identical."""

    def test_all_shared_cases(self):
        for case in CASES:
            with self.subTest(case["name"]):
                checkins = [CheckIn(c["day"], c["pain"], c.get("fever_f"), c.get("wound_discharge", False))
                            for c in case["checkins"]]
                limits = RedFlagLimits(**case["limits"]) if "limits" in case else None
                result = assess(checkins, limits)
                self.assertEqual(result.status, case["status"])
                self.assertEqual(sorted(result.codes), sorted(case["codes"]))


class DailyCheckins(unittest.TestCase):
    def ev(self, date, pain, created, fever=None):
        return {"created_at": created, "data": {"date": date, "pain": pain, "fever_f": fever}}

    def test_latest_entry_of_the_day_wins(self):
        events = [self.ev("2026-10-02", 5, "2026-10-02T08:00:00Z"),
                  self.ev("2026-10-02", 3, "2026-10-02T20:00:00Z")]
        days = daily_checkins(events, "2026-10-01")
        self.assertEqual([(d.day, d.pain) for d in days], [(2, 3)])

    def test_days_before_discharge_and_bad_dates_are_ignored(self):
        events = [self.ev("2026-09-30", 5, "a"), {"created_at": "b", "data": {"date": "nope"}},
                  self.ev("2026-10-01", 2, "c")]
        days = daily_checkins(events, "2026-10-01")
        self.assertEqual([d.day for d in days], [1])

    def test_bad_discharge_date_gives_nothing(self):
        self.assertEqual(daily_checkins([self.ev("2026-10-01", 2, "a")], "oops"), [])

    def test_end_to_end_warns_on_day_3(self):
        events = [self.ev(f"2026-10-0{d}", d, f"2026-10-0{d}T09:00:00Z") for d in (1, 2, 3)]
        self.assertEqual(assess(daily_checkins(events, "2026-10-01")).status, WARN)


class Basics(unittest.TestCase):
    def test_status_constants(self):
        self.assertEqual((OK, WARN, RED_FLAG), ("OK", "WARN", "RED_FLAG"))

    def test_reasons_are_readable(self):
        r = assess([CheckIn(1, 1), CheckIn(2, 2), CheckIn(3, 3)])
        self.assertIn("Pain rising for 3 days", r.reasons[0])


if __name__ == "__main__":
    unittest.main()
