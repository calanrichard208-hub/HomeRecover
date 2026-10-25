"""Trend-based early warning for post-discharge recovery.

The engine is deliberately rule-based and transparent. It never diagnoses:
it only compares daily check-ins against the red-flag limits written in the
patient's own discharge summary, and looks at how the answers change over time.

The same rules live in frontend/js/trend.js so the phone can work offline.
Both are tested against shared/trend_cases.json.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

OK = "OK"
WARN = "WARN"
RED_FLAG = "RED_FLAG"

_SEVERITY = {OK: 0, WARN: 1, RED_FLAG: 2}

DEFAULT_FEVER_LIMIT_F = 100.4
DEFAULT_PAIN_LIMIT = 8


@dataclass
class CheckIn:
    day: int                              # day since discharge (1, 2, 3, ...)
    pain: int                             # 0-10 self-reported
    fever_f: Optional[float] = None       # body temperature in Fahrenheit, if measured
    wound_discharge: bool = False         # any discharge from the wound


@dataclass
class RedFlagLimits:
    """Limits copied from the doctor's discharge instructions (editable by the family)."""
    fever_limit_f: float = DEFAULT_FEVER_LIMIT_F
    pain_limit: int = DEFAULT_PAIN_LIMIT


@dataclass
class Assessment:
    status: str = OK
    reasons: List[str] = field(default_factory=list)       # plain English, for logs and tests
    findings: List[Dict[str, Any]] = field(default_factory=list)  # {code, params} for translation

    def raise_to(self, status: str, code: str, params: Dict[str, Any], reason: str) -> None:
        if _SEVERITY[status] > _SEVERITY[self.status]:
            self.status = status
        self.findings.append({"code": code, "params": params})
        self.reasons.append(reason)

    @property
    def codes(self) -> List[str]:
        return [f["code"] for f in self.findings]


def assess(checkins: List[CheckIn], limits: Optional[RedFlagLimits] = None) -> Assessment:
    """Assess a recovery from the check-ins so far (any order; sorted by day)."""
    limits = limits or RedFlagLimits()
    result = Assessment()
    if not checkins:
        return result

    history = sorted(checkins, key=lambda c: c.day)
    latest = history[-1]

    # 1) Red flags from the doctor's own limits (latest check-in only).
    if latest.fever_f is not None and latest.fever_f >= limits.fever_limit_f:
        result.raise_to(
            RED_FLAG, "FEVER_LIMIT", {"fever": latest.fever_f, "limit": limits.fever_limit_f},
            f"Fever {latest.fever_f:g}F is at or above the limit of {limits.fever_limit_f:g}F",
        )
    if latest.wound_discharge:
        result.raise_to(RED_FLAG, "WOUND_DISCHARGE", {}, "Discharge reported from the wound")
    if latest.pain >= limits.pain_limit:
        result.raise_to(
            RED_FLAG, "PAIN_LIMIT", {"pain": latest.pain, "limit": limits.pain_limit},
            f"Pain {latest.pain}/10 is at or above the limit of {limits.pain_limit}/10",
        )

    # 2) Trend: pain rising on three consecutive days by at least 2 points in total.
    if len(history) >= 3:
        a, b, c = history[-3:]
        if c.day - a.day == 2 and a.pain < b.pain < c.pain and c.pain - a.pain >= 2:
            result.raise_to(
                WARN, "PAIN_RISING", {"a": a.pain, "b": b.pain, "c": c.pain},
                f"Pain rising for 3 days ({a.pain} -> {b.pain} -> {c.pain})",
            )

    # 3) Trend: fever rising and within 1F of the limit.
    temps = [c for c in history if c.fever_f is not None]
    if len(temps) >= 2:
        prev, cur = temps[-2], temps[-1]
        if prev.fever_f < cur.fever_f and limits.fever_limit_f - 1 <= cur.fever_f < limits.fever_limit_f:
            result.raise_to(
                WARN, "FEVER_RISING", {"prev": prev.fever_f, "cur": cur.fever_f},
                f"Fever rising and close to the limit ({prev.fever_f:g}F -> {cur.fever_f:g}F)",
            )

    return result


def daily_checkins(events: List[Dict[str, Any]], discharge_date: str) -> List[CheckIn]:
    """Turn raw check-in events into one CheckIn per day (latest entry of the day wins).

    Each event is {"created_at": ISO string, "data": {"date": "YYYY-MM-DD", "pain": int,
    "fever_f": float|None, "wound_discharge": bool}}. Days before discharge are ignored.
    """
    from datetime import date

    try:
        start = date.fromisoformat(discharge_date)
    except (TypeError, ValueError):
        return []
    per_day: Dict[int, Dict[str, Any]] = {}
    for ev in sorted(events, key=lambda e: e.get("created_at", "")):
        data = ev.get("data", {})
        try:
            day = (date.fromisoformat(data["date"]) - start).days + 1
        except (KeyError, TypeError, ValueError):
            continue
        if day < 1:
            continue
        per_day[day] = data
    return [
        CheckIn(
            day=d,
            pain=int(v.get("pain", 0)),
            fever_f=v.get("fever_f"),
            wound_discharge=bool(v.get("wound_discharge", False)),
        )
        for d, v in sorted(per_day.items())
    ]
