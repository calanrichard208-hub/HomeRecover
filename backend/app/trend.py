"""Trend-based early warning for post-discharge recovery.

The engine is deliberately rule-based and transparent. It never diagnoses:
it only compares daily check-ins against the red-flag limits written in the
patient's own discharge summary, and looks at how the answers change over time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

OK = "OK"
WARN = "WARN"
RED_FLAG = "RED_FLAG"

_SEVERITY = {OK: 0, WARN: 1, RED_FLAG: 2}


@dataclass
class CheckIn:
    day: int                              # day since discharge (1, 2, 3, ...)
    pain: int                             # 0-10 self-reported
    fever_f: Optional[float] = None       # body temperature in Fahrenheit, if measured
    wound_discharge: bool = False         # any discharge from the wound


@dataclass
class RedFlagLimits:
    """Limits copied from the doctor's discharge instructions (editable by the family)."""
    fever_limit_f: float = 100.4
    pain_limit: int = 8


@dataclass
class Assessment:
    status: str = OK
    reasons: List[str] = field(default_factory=list)

    def raise_to(self, status: str, reason: str) -> None:
        if _SEVERITY[status] > _SEVERITY[self.status]:
            self.status = status
        self.reasons.append(reason)


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
        result.raise_to(RED_FLAG, f"Fever {latest.fever_f:g}F is at or above the limit of {limits.fever_limit_f:g}F")
    if latest.wound_discharge:
        result.raise_to(RED_FLAG, "Discharge reported from the wound")
    if latest.pain >= limits.pain_limit:
        result.raise_to(RED_FLAG, f"Pain {latest.pain}/10 is at or above the limit of {limits.pain_limit}/10")

    # 2) Trend: pain rising on three consecutive days by at least 2 points in total.
    if len(history) >= 3:
        last3 = history[-3:]
        consecutive = last3[2].day - last3[0].day == 2
        rising = last3[0].pain < last3[1].pain < last3[2].pain
        if consecutive and rising and last3[2].pain - last3[0].pain >= 2:
            result.raise_to(
                WARN,
                f"Pain rising for 3 days ({last3[0].pain} -> {last3[1].pain} -> {last3[2].pain})",
            )

    # 3) Trend: fever rising and within 1F of the limit.
    temps = [c for c in history if c.fever_f is not None]
    if len(temps) >= 2:
        prev, cur = temps[-2], temps[-1]
        if cur.fever_f > prev.fever_f and cur.fever_f >= limits.fever_limit_f - 1 and cur.fever_f < limits.fever_limit_f:
            result.raise_to(WARN, f"Fever rising and close to the limit ({prev.fever_f:g}F -> {cur.fever_f:g}F)")

    return result
