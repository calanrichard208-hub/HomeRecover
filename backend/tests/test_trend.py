import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.trend import CheckIn, RedFlagLimits, assess, OK, WARN, RED_FLAG  # noqa: E402


class TrendTests(unittest.TestCase):
    def test_no_checkins_is_ok(self):
        self.assertEqual(assess([]).status, OK)

    def test_stable_recovery_is_ok(self):
        data = [CheckIn(1, 4, 99.0), CheckIn(2, 3, 98.8), CheckIn(3, 2, 98.6)]
        self.assertEqual(assess(data).status, OK)

    def test_pain_rising_three_days_warns_on_day_3(self):
        data = [CheckIn(1, 1), CheckIn(2, 2), CheckIn(3, 3)]
        result = assess(data)
        self.assertEqual(result.status, WARN)
        self.assertIn("Pain rising for 3 days", result.reasons[0])

    def test_single_pain_3_is_not_a_warning(self):
        self.assertEqual(assess([CheckIn(3, 3)]).status, OK)

    def test_pain_rise_must_be_on_consecutive_days(self):
        data = [CheckIn(1, 1), CheckIn(3, 2), CheckIn(5, 3)]
        self.assertEqual(assess(data).status, OK)

    def test_fever_at_limit_is_red_flag(self):
        self.assertEqual(assess([CheckIn(2, 2, 101.0)]).status, RED_FLAG)

    def test_custom_doctor_limit_is_respected(self):
        limits = RedFlagLimits(fever_limit_f=99.5)
        self.assertEqual(assess([CheckIn(2, 2, 99.6)], limits).status, RED_FLAG)

    def test_wound_discharge_is_red_flag(self):
        self.assertEqual(assess([CheckIn(4, 2, None, True)]).status, RED_FLAG)

    def test_high_pain_is_red_flag(self):
        self.assertEqual(assess([CheckIn(2, 9)]).status, RED_FLAG)

    def test_fever_rising_near_limit_warns(self):
        data = [CheckIn(1, 2, 99.0), CheckIn(2, 2, 99.8)]
        self.assertEqual(assess(data).status, WARN)

    def test_red_flag_outranks_warning(self):
        data = [CheckIn(1, 1), CheckIn(2, 2), CheckIn(3, 3, 101.5)]
        result = assess(data)
        self.assertEqual(result.status, RED_FLAG)
        self.assertGreaterEqual(len(result.reasons), 2)

    def test_unsorted_input_is_handled(self):
        data = [CheckIn(3, 3), CheckIn(1, 1), CheckIn(2, 2)]
        self.assertEqual(assess(data).status, WARN)


if __name__ == "__main__":
    unittest.main()
