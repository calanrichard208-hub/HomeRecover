// Local-first storage and sync.
// Everything is saved on the phone first. If the family has a code, new records are pushed
// to the server and the others' records are pulled. Records are append-only with unique ids,
// so two phones that were both offline merge cleanly without losing anything.

const KEY = "homerecover.v1";

const blank = () => ({
  lang: "en", me: "", familyCode: null, setupDone: false,
  plan: null, planUpdated: null,
  events: [], pushed: {}, lastSeq: 0,
  helpCache: null,
});

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createStore({
  storage = globalThis.localStorage,
  fetchFn = (...a) => globalThis.fetch(...a),
  baseUrl = "",
  uuid = defaultUuid,
  now = () => new Date().toISOString(),
  key = KEY,
} = {}) {
  let state = load();
  let sync_status = state.familyCode ? "offline" : "local";
  let syncing = null;
  let timer = null;
  const listeners = new Set();

  function load() {
    try {
      const raw = storage?.getItem(key);
      if (raw) return { ...blank(), ...JSON.parse(raw) };
    } catch { /* corrupted or unavailable storage: start fresh */ }
    return blank();
  }

  function persist(reason = "local") {
    try { storage?.setItem(key, JSON.stringify(state)); } catch { /* storage full or blocked */ }
    listeners.forEach((fn) => fn(reason));
  }

  async function api(method, path, body, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(baseUrl + path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError(0, "offline");
    } finally {
      clearTimeout(t);
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
    return data;
  }

  const unsentEvents = () => state.events.filter((e) => !state.pushed[e.id]);

  async function runSync() {
    if (!state.familyCode) { sync_status = "local"; listeners.forEach((f) => f("sync-status")); return sync_status; }
    const code = state.familyCode;
    const before = JSON.stringify([state.plan, state.events.length]);
    try {
      // 1) plan: newest write wins
      const fam = await api("GET", `/api/families/${code}`);
      if (state.plan && (!fam.plan_updated || (state.planUpdated && state.planUpdated > fam.plan_updated))) {
        await api("PUT", `/api/families/${code}/plan`, { plan: state.plan, updated_at: state.planUpdated });
      } else if (fam.plan && (!state.planUpdated || fam.plan_updated > state.planUpdated)) {
        state = { ...state, plan: fam.plan, planUpdated: fam.plan_updated };
      }
      // 2) push records not on the server yet
      const unsent = unsentEvents();
      for (let i = 0; i < unsent.length; i += 100) {
        const chunk = unsent.slice(i, i + 100).map(({ id, kind, data, created_at }) => ({ id, kind, data, created_at }));
        await api("POST", `/api/families/${code}/events`, { events: chunk });
        const pushed = { ...state.pushed };
        chunk.forEach((e) => { pushed[e.id] = true; });
        state = { ...state, pushed };
      }
      // 3) pull records from the rest of the family
      const pulled = await api("GET", `/api/families/${code}/events?since=${state.lastSeq}`);
      const known = new Set(state.events.map((e) => e.id));
      const pushed = { ...state.pushed };
      const added = [];
      for (const e of pulled.events) {
        pushed[e.id] = true;
        if (!known.has(e.id)) added.push({ id: e.id, kind: e.kind, data: e.data, created_at: e.created_at });
      }
      state = { ...state, events: [...state.events, ...added], pushed, lastSeq: pulled.latest_seq };
      sync_status = "synced";
    } catch (err) {
      sync_status = err.status === 404 ? "badcode" : "offline";
    }
    const changed = before !== JSON.stringify([state.plan, state.events.length]);
    persist(changed ? "sync-data" : "sync-status");
    return sync_status;
  }

  function sync() {
    if (!syncing) syncing = runSync().finally(() => { syncing = null; });
    return syncing;
  }

  function scheduleSync() {
    clearTimeout(timer);
    timer = setTimeout(() => { sync(); }, 400);
  }

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(patch, reason = "local") { state = { ...state, ...patch }; persist(reason); },

    addEvent(kind, data) {
      const ev = { id: uuid(), kind, data, created_at: now() };
      state = { ...state, events: [...state.events, ev] };
      persist("local");
      scheduleSync();
      return ev;
    },

    setPlan(plan) {
      state = { ...state, plan, planUpdated: now() };
      persist("local");
      scheduleSync();
    },

    reset() { state = blank(); sync_status = "local"; persist("reset"); },

    sync,

    getSyncInfo() {
      return { status: state.familyCode ? sync_status : "local", waiting: state.familyCode ? unsentEvents().length : 0 };
    },

    /** Start sharing this phone's records with a new family code. */
    async createFamily() {
      const name = state.plan?.patient_name || "Family";
      const { code } = await api("POST", "/api/families", { name });
      state = { ...state, familyCode: code, pushed: {}, lastSeq: 0 };
      sync_status = "offline";
      persist("local");
      await sync();
      return code;
    },

    /** Join an existing family from a new phone. */
    async joinFamily(code) {
      const clean = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      const fam = await api("GET", `/api/families/${clean}`);
      state = {
        ...state, familyCode: clean, plan: fam.plan, planUpdated: fam.plan_updated,
        events: [], pushed: {}, lastSeq: 0, setupDone: true,
      };
      sync_status = "offline";
      persist("local");
      await sync();
      return state;
    },

    /** Ask the server to read a discharge summary (photo and/or text). */
    async extract(body) {
      const { plan } = await api("POST", "/api/extract", body, 70000);
      return plan;
    },
  };
}
