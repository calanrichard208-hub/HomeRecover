// Trend-based early warning. Same rules as backend/app/trend.py (both tested
// against shared/trend_cases.json). It never diagnoses: it compares check-ins with
// the limits from the doctor's own discharge summary and looks at how they change.

export const OK = "OK";
export const WARN = "WARN";
export const RED_FLAG = "RED_FLAG";

export const DEFAULT_FEVER_LIMIT_F = 100.4;
export const DEFAULT_PAIN_LIMIT = 8;

const SEVERITY = { OK: 0, WARN: 1, RED_FLAG: 2 };

/** checkins: [{day, pain, fever_f?, wound_discharge?}]  limits: {fever_limit_f, pain_limit} */
export function assess(checkins, limits = {}) {
  const feverLimit = limits.fever_limit_f ?? DEFAULT_FEVER_LIMIT_F;
  const painLimit = limits.pain_limit ?? DEFAULT_PAIN_LIMIT;
  const result = { status: OK, findings: [] };
  if (!checkins || checkins.length === 0) return result;

  const add = (status, code, params) => {
    if (SEVERITY[status] > SEVERITY[result.status]) result.status = status;
    result.findings.push({ code, params });
  };

  const history = [...checkins].sort((a, b) => a.day - b.day);
  const latest = history[history.length - 1];

  // 1) Red flags from the doctor's own limits (latest check-in only).
  if (latest.fever_f != null && latest.fever_f >= feverLimit) {
    add(RED_FLAG, "FEVER_LIMIT", { fever: latest.fever_f, limit: feverLimit });
  }
  if (latest.wound_discharge) add(RED_FLAG, "WOUND_DISCHARGE", {});
  if (latest.pain >= painLimit) add(RED_FLAG, "PAIN_LIMIT", { pain: latest.pain, limit: painLimit });

  // 2) Trend: pain rising on three consecutive days by at least 2 points in total.
  if (history.length >= 3) {
    const [a, b, c] = history.slice(-3);
    if (c.day - a.day === 2 && a.pain < b.pain && b.pain < c.pain && c.pain - a.pain >= 2) {
      add(WARN, "PAIN_RISING", { a: a.pain, b: b.pain, c: c.pain });
    }
  }

  // 3) Trend: fever rising and within 1 degree F of the limit.
  const temps = history.filter((c) => c.fever_f != null);
  if (temps.length >= 2) {
    const prev = temps[temps.length - 2];
    const cur = temps[temps.length - 1];
    if (prev.fever_f < cur.fever_f && feverLimit - 1 <= cur.fever_f && cur.fever_f < feverLimit) {
      add(WARN, "FEVER_RISING", { prev: prev.fever_f, cur: cur.fever_f });
    }
  }
  return result;
}

const MS_PER_DAY = 86400000;

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : t;
}

/** Day number since discharge for a YYYY-MM-DD date (discharge day is day 1), or null. */
export function dayNumber(date, dischargeDate) {
  const d = parseDate(date);
  const start = parseDate(dischargeDate);
  if (d == null || start == null) return null;
  return Math.round((d - start) / MS_PER_DAY) + 1;
}

/** One check-in per day (latest entry of the day wins). Mirrors daily_checkins() in trend.py. */
export function dailyCheckins(events, dischargeDate) {
  const perDay = new Map();
  const sorted = events
    .filter((e) => e.kind === "checkin")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const ev of sorted) {
    const day = dayNumber(ev.data?.date, dischargeDate);
    if (day == null || day < 1) continue;
    perDay.set(day, ev.data);
  }
  return [...perDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, v]) => ({
      day,
      pain: Number(v.pain ?? 0),
      fever_f: v.fever_f ?? null,
      wound_discharge: Boolean(v.wound_discharge),
    }));
}
