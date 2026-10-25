import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assess, dailyCheckins, dayNumber } from "../js/trend.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "..", "..", "shared", "trend_cases.json"), "utf8"));

for (const c of cases) {
  test(`shared case: ${c.name}`, () => {
    const checkins = c.checkins.map((x) => ({ wound_discharge: false, fever_f: null, ...x }));
    const result = assess(checkins, c.limits);
    assert.equal(result.status, c.status);
    assert.deepEqual(result.findings.map((f) => f.code).sort(), [...c.codes].sort());
  });
}

test("dayNumber counts the discharge day as day 1", () => {
  assert.equal(dayNumber("2026-10-01", "2026-10-01"), 1);
  assert.equal(dayNumber("2026-10-03", "2026-10-01"), 3);
  assert.equal(dayNumber("2026-09-30", "2026-10-01"), 0);
  assert.equal(dayNumber("garbage", "2026-10-01"), null);
});

test("dailyCheckins keeps the latest entry per day and ignores bad dates", () => {
  const ev = (date, pain, created) => ({ kind: "checkin", created_at: created, data: { date, pain } });
  const out = dailyCheckins(
    [ev("2026-10-02", 5, "a"), ev("2026-10-02", 3, "b"), ev("2026-09-30", 9, "c"), ev("nope", 1, "d"),
     { kind: "dose", created_at: "e", data: {} }],
    "2026-10-01",
  );
  assert.deepEqual(out.map((d) => [d.day, d.pain]), [[2, 3]]);
});

test("end to end: pain 1,2,3 over three days warns", () => {
  const events = [1, 2, 3].map((d) => ({ kind: "checkin", created_at: `2026-10-0${d}T09:00:00Z`,
    data: { date: `2026-10-0${d}`, pain: d } }));
  assert.equal(assess(dailyCheckins(events, "2026-10-01")).status, "WARN");
});
