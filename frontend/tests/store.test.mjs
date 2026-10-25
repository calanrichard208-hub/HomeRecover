// Two phones, one real server. Starts the Python backend on a spare port.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../js/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "..", "..", "backend");
const port = 18000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let proc;

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};
const phone = (opts = {}) => createStore({ storage: memoryStorage(), baseUrl, ...opts });

before(async () => {
  const env = { ...process.env, HOMERECOVER_DB: join(mkdtempSync(join(tmpdir(), "hr-")), "t.db"), PYTHONPATH: backend };
  delete env.ANTHROPIC_API_KEY;
  proc = spawn("python3", ["-m", "app.server", "--port", String(port)], { cwd: backend, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => proc?.kill());

const plan = (name = "Raman") => ({
  patient_name: name, discharge_date: "2026-10-01",
  red_flags: { fever_limit_f: 100.4, pain_limit: 8 },
  medicines: [{ name: "Tab A", dose: "1", times: ["08:00"] }],
});

test("two phones share a plan and merge records made while offline", async () => {
  const a = phone();
  a.update({ me: "Meena", setupDone: true });
  a.setPlan(plan());
  a.addEvent("checkin", { date: "2026-10-01", pain: 3, fever_f: null, wound_discharge: false, by: "Meena" });
  const code = await a.createFamily();
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(a.getSyncInfo().status, "synced");
  assert.equal(a.getSyncInfo().waiting, 0);

  const b = phone();
  b.update({ me: "Ravi" });
  await b.joinFamily(code);
  assert.equal(b.getState().plan.patient_name, "Raman");
  assert.equal(b.getState().events.length, 1);

  // both log a dose for the same slot while "offline", then sync
  const slot = "2026-10-02|08:00|Tab A";
  a.addEvent("dose", { slot, medicine: "Tab A", by: "Meena", taken_at: "2026-10-02T08:05:00.000Z" });
  b.addEvent("dose", { slot, medicine: "Tab A", by: "Ravi", taken_at: "2026-10-02T08:07:00.000Z" });
  await Promise.all([a.sync(), b.sync()]);
  await Promise.all([a.sync(), b.sync()]);

  for (const p of [a, b]) {
    const doses = p.getState().events.filter((e) => e.kind === "dose" && e.data.slot === slot);
    assert.deepEqual(doses.map((d) => d.data.by).sort(), ["Meena", "Ravi"]); // nothing lost, both visible
    assert.equal(p.getState().events.length, 3);
  }
});

test("the newest plan edit wins", async () => {
  const a = phone();
  a.update({ setupDone: true });
  a.setPlan(plan("Old name"));
  const code = await a.createFamily();
  const b = phone();
  await b.joinFamily(code);
  await new Promise((r) => setTimeout(r, 5));
  b.setPlan(plan("New name"));
  await b.sync();
  await a.sync();
  assert.equal(a.getState().plan.patient_name, "New name");
});

test("a wrong code is rejected and offline phones keep their data", async () => {
  const a = phone();
  await assert.rejects(a.joinFamily("ZZZZZZZZ"), (e) => e.status === 404);

  const offline = phone({ fetchFn: () => Promise.reject(new TypeError("network down")) });
  offline.update({ familyCode: "ABCDEFGH" });
  offline.addEvent("checkin", { date: "2026-10-01", pain: 2, fever_f: null, wound_discharge: false, by: "x" });
  await offline.sync();
  assert.equal(offline.getSyncInfo().status, "offline");
  assert.equal(offline.getSyncInfo().waiting, 1);
  assert.equal(offline.getState().events.length, 1);
});

test("AI reading says clearly when the server has no key", async () => {
  const a = phone();
  await assert.rejects(a.extract({ text: "hello" }), (e) => e.status === 503 && /not switched on/.test(e.message));
});

test("state survives a restart", () => {
  const storage = memoryStorage();
  const a = createStore({ storage, baseUrl });
  a.update({ me: "Meena", lang: "ta" });
  const again = createStore({ storage, baseUrl });
  assert.equal(again.getState().me, "Meena");
  assert.equal(again.getState().lang, "ta");
});
