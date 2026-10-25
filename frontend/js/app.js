import { createStore } from "./store.js";
import { translate, LANGS } from "./i18n.js";
import { assess, dailyCheckins, dayNumber, OK, WARN, RED_FLAG, DEFAULT_FEVER_LIMIT_F, DEFAULT_PAIN_LIMIT } from "./trend.js";

const store = createStore();
const root = document.getElementById("app");
const ui = {
  tab: "today", step: "welcome", draft: null, photo: null, busy: false, error: "",
  nearby: null, speaking: false, online: navigator.onLine, toast: "",
};

// ---------- helpers ----------
const S = () => store.getState();
const t = (k, v) => translate(S().lang, k, v);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const telHref = (p) => "tel:" + String(p).replace(/[^\d+]/g, "");
const num = (v) => (v === "" || v == null ? null : Number(v));
const icon = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  today: icon('<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10.5V19h12v-8.5"/><path d="M10 19v-5h4v5"/>'),
  checkin: icon('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
  help: icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  plan: icon('<path d="M7 4h10a1 1 0 0 1 1 1v15H6V5a1 1 0 0 1 1-1z"/><path d="M9 9h6M9 13h6M9 17h3"/>'),
};

function flash(msg) {
  ui.toast = msg;
  const el = document.getElementById("toast");
  if (el) { el.textContent = msg; el.hidden = !msg; }
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { ui.toast = ""; const e = document.getElementById("toast"); if (e) e.hidden = true; }, 2600);
}

function statusInfo() {
  const st = S();
  const plan = st.plan || {};
  const daily = dailyCheckins(st.events, plan.discharge_date);
  const limits = plan.red_flags || {};
  const result = assess(daily, { fever_limit_f: limits.fever_limit_f, pain_limit: limits.pain_limit });
  const latest = daily[daily.length - 1] || null;
  const state = daily.length === 0 ? "none" : result.status;
  return { daily, result, state, latest, limits };
}

const findingText = (f) => t(f.code, f.params);

// ---------- chart ----------
function chartSvg(daily, limits) {
  const maxDay = Math.max(7, ...daily.map((d) => d.day));
  const W = 320, L = 34, R = 10;
  const x = (d) => L + (d - 1) * ((W - L - R) / (maxDay - 1));
  const painY = (v) => 14 + 84 * (1 - Math.min(10, Math.max(0, v)) / 10);
  const tMin = 97, tMax = 103;
  const tempY = (v) => 128 + 62 * (1 - (Math.min(tMax, Math.max(tMin, v)) - tMin) / (tMax - tMin));
  const painLimit = limits.pain_limit ?? DEFAULT_PAIN_LIMIT;
  const feverLimit = limits.fever_limit_f ?? DEFAULT_FEVER_LIMIT_F;
  const pts = (arr, fy) => arr.map((d) => `${x(d.day).toFixed(1)},${fy(d).toFixed(1)}`).join(" ");
  const temps = daily.filter((d) => d.fever_f != null);
  let g = "";
  for (let d = 1; d <= maxDay; d++) {
    g += `<line x1="${x(d)}" y1="10" x2="${x(d)}" y2="196" class="c-grid"/><text x="${x(d)}" y="210" class="c-lab" text-anchor="middle">${d}</text>`;
  }
  for (const v of [0, 5, 10]) g += `<text x="${L - 6}" y="${painY(v) + 4}" class="c-lab" text-anchor="end">${v}</text>`;
  for (const v of [97, 100, 103]) g += `<text x="${L - 6}" y="${tempY(v) + 4}" class="c-lab" text-anchor="end">${v}</text>`;
  g += `<line x1="${L}" y1="${painY(painLimit)}" x2="${W - R}" y2="${painY(painLimit)}" class="c-limit"/>`;
  if (feverLimit >= tMin && feverLimit <= tMax) g += `<line x1="${L}" y1="${tempY(feverLimit)}" x2="${W - R}" y2="${tempY(feverLimit)}" class="c-limit"/>`;
  if (daily.length > 1) g += `<polyline points="${pts(daily, (d) => painY(d.pain))}" class="c-line"/>`;
  if (temps.length > 1) g += `<polyline points="${pts(temps, (d) => tempY(d.fever_f))}" class="c-line"/>`;
  daily.forEach((d, i) => { g += `<circle cx="${x(d.day)}" cy="${painY(d.pain)}" r="${i === daily.length - 1 ? 5.5 : 4}" class="c-dot${i === daily.length - 1 ? " c-last" : ""}"/>`; });
  temps.forEach((d, i) => { g += `<circle cx="${x(d.day)}" cy="${tempY(d.fever_f)}" r="${i === temps.length - 1 ? 5.5 : 4}" class="c-dot${i === temps.length - 1 ? " c-last" : ""}"/>`; });
  const summary = `${t("chart_pain")}: ${daily.map((d) => `${d.day}: ${d.pain}`).join(", ") || "-"}`;
  return `<svg class="chart" viewBox="0 0 ${W} 218" role="img" aria-label="${esc(summary)}">${g}
    <text x="${L}" y="9" class="c-title">${esc(t("chart_pain"))}</text>
    <text x="${L}" y="123" class="c-title">${esc(t("chart_temp"))}</text></svg>`;
}

// ---------- doses ----------
function todaysSlots(plan, events, today) {
  const slots = [];
  for (const med of plan.medicines || []) {
    for (const time of med.times || []) {
      const key = `${today}|${time}|${med.name}`;
      const given = events.filter((e) => e.kind === "dose" && e.data.slot === key)
        .sort((a, b) => String(a.data.taken_at).localeCompare(String(b.data.taken_at)));
      slots.push({ med, time, key, given });
    }
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time) || a.med.name.localeCompare(b.med.name));
}

function slotState(slot, nowDate = new Date()) {
  if (slot.given.length) return "given";
  const [h, m] = slot.time.split(":").map(Number);
  const due = new Date(nowDate); due.setHours(h, m, 0, 0);
  return nowDate - due > 2 * 3600 * 1000 ? "missed" : "due";
}

function dosesHtml(plan) {
  const slots = todaysSlots(plan, S().events, localDate());
  if (!plan.medicines?.length) return `<p class="muted">${esc(t("no_plan"))}</p>`;
  return `<ul class="doses">${slots.map((s) => {
    const state = slotState(s);
    const who = [...new Set(s.given.map((g) => g.data.by || "?"))].join(", ");
    let right = "";
    if (state === "given") right = `<span class="given">${esc(t("given_by", { who: s.given[0].data.by || "?", time: clock(s.given[0].data.taken_at) }))}</span>`;
    else right = `<button class="btn small" data-action="dose" data-slot="${esc(s.key)}" data-med="${esc(s.med.name)}">${esc(t("mark_given"))}</button>`;
    const sub = state === "given" ? "" : state === "missed" ? `<span class="late">${esc(t("missed"))}</span>` : `<span class="muted">${esc(t("due_at", { time: s.time }))}</span>`;
    const warn = s.given.length > 1 ? `<p class="warnline">${esc(t("double_warn", { who }))}</p>` : "";
    return `<li class="dose dose-${state}"><div class="dose-main"><span class="dose-time">${esc(s.time)}</span>
      <div><strong>${esc(s.med.name)}</strong> <span class="muted">${esc(s.med.dose)}</span>${s.med.notes ? `<div class="muted small-text">${esc(s.med.notes)}</div>` : ""} ${sub}</div></div>
      <div class="dose-act">${right}</div>${warn}</li>`;
  }).join("")}</ul>`;
}

// ---------- shared pieces ----------
function syncPill() {
  const info = store.getSyncInfo();
  let label = t("sync_local"), cls = "pill-local";
  if (info.status === "synced") { label = t("sync_synced"); cls = "pill-ok"; }
  else if (info.status === "badcode") { label = t("sync_badcode"); cls = "pill-bad"; }
  else if (info.status === "offline") { label = info.waiting ? t("sync_waiting", { n: info.waiting }) : t("sync_offline"); cls = "pill-wait"; }
  return `<span id="sync-pill" class="pill ${cls}">${esc(label)}</span>`;
}
function updatePill() {
  const el = document.getElementById("sync-pill");
  if (!el) return;
  el.outerHTML = syncPill();
}

function langChips() {
  return `<div class="chips" role="group" aria-label="${esc(t("language"))}">${LANGS.map((l) =>
    `<button class="chip${S().lang === l.code ? " on" : ""}" data-action="lang" data-lang="${l.code}" aria-pressed="${S().lang === l.code}">${esc(l.label)}</button>`).join("")}</div>`;
}

function emergencyButtons(plan, includeDoctor = true) {
  const phone = plan?.doctor_phone;
  return `<div class="callrow">
    ${includeDoctor && phone ? `<a class="btn call" href="${esc(telHref(phone))}">${esc(t("call_doctor"))}</a>` : ""}
    <a class="btn call" href="tel:112">${esc(t("call_emergency"))}</a>
    <a class="btn call" href="tel:108">${esc(t("call_ambulance"))}</a></div>`;
}

function statusBanner(info, plan) {
  const { state, result, latest } = info;
  const titleKey = { none: "status_none", OK: "status_ok", WARN: "status_warn", RED_FLAG: "status_red" }[state];
  const findings = result.findings.map((f) => `<li>${esc(findingText(f))}</li>`).join("");
  const advice = state === RED_FLAG ? t("advice_red") : state === WARN ? t("advice_warn") : "";
  const today = localDate();
  const basedOn = latest && info.daily.length && state !== "none"
    ? (() => { const lastDay = latest.day; const todayDay = dayNumber(today, plan.discharge_date); return lastDay !== todayDay ? `<p class="muted small-text">${esc(t("based_on", { date: lastDate(info) }))}</p>` : ""; })() : "";
  return `<section class="status status-${state}" aria-live="polite">
    <h2>${esc(t(titleKey))}</h2>
    ${state === "none" ? `<p>${esc(t("no_checkins"))}</p>` : ""}
    ${findings ? `<ul class="findings">${findings}</ul>` : ""}
    ${advice ? `<p>${esc(advice)}</p>` : ""}${basedOn}
    ${state === RED_FLAG || state === WARN ? emergencyButtons(plan) : ""}
    <p class="muted small-text">${esc(t("no_diagnosis"))}</p>
    ${"speechSynthesis" in window ? `<button class="btn ghost small" data-action="speak">${esc(ui.speaking ? t("stop") : t("read_aloud"))}</button>` : ""}
  </section>`;
}
function lastDate(info) {
  const ev = S().events.filter((e) => e.kind === "checkin").sort((a, b) => a.created_at.localeCompare(b.created_at));
  return ev.length ? ev[ev.length - 1].data.date : "";
}

// ---------- screens ----------
function viewToday() {
  const st = S(), plan = st.plan || {};
  const info = statusInfo();
  const day = dayNumber(localDate(), plan.discharge_date);
  const checkedToday = S().events.some((e) => e.kind === "checkin" && e.data.date === localDate());
  return `<header class="top"><div><h1>${esc(plan.patient_name || "HomeRecover")}</h1>
      <p class="muted">${day && day >= 1 ? esc(t("day_n", { n: day })) : esc(t("before_discharge"))}</p></div>${syncPill()}</header>
    ${statusBanner(info, plan)}
    <section class="card chartcard"><h2>${esc(t("chart_title"))}</h2>${info.daily.length ? "" : `<p class="muted small-text">${esc(t("chart_empty"))}</p>`}${chartSvg(info.daily, info.limits)}</section>
    <section class="card"><h2>${esc(t("doses_today"))}</h2>${dosesHtml(plan)}</section>
    <button class="btn primary wide" data-action="goto" data-tab="checkin">${esc(checkedToday ? t("update_checkin") : t("do_checkin"))}</button>`;
}

function viewCheckin() {
  const st = S();
  const mine = [...st.events.filter((e) => e.kind === "checkin")].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);
  const lastPain = mine[0]?.data.pain ?? 3;
  return `<header class="top"><h1>${esc(t("tab_checkin"))}</h1>${syncPill()}</header>
    <form class="card form" data-form="checkin" novalidate>
      <label for="pain">${esc(t("pain_q"))}</label>
      <div class="painrow"><input id="pain" name="pain" type="range" min="0" max="10" step="1" value="${lastPain}"><output id="painout" for="pain">${lastPain}</output></div>
      <label for="fever">${esc(t("fever_q"))}</label>
      <input id="fever" name="fever" type="number" inputmode="decimal" step="0.1" min="90" max="110" placeholder="98.6">
      <fieldset><legend>${esc(t("wound_q"))}</legend>
        <label class="radio"><input type="radio" name="wound" value="no" checked> ${esc(t("no"))}</label>
        <label class="radio"><input type="radio" name="wound" value="yes"> ${esc(t("yes"))}</label></fieldset>
      <p class="error" id="form-error" role="alert" ${ui.error ? "" : "hidden"}>${esc(ui.error)}</p>
      <button class="btn primary wide" type="submit">${esc(t("save_checkin"))}</button>
      <p class="muted small-text">${esc(t("checkin_latest"))}</p>
    </form>
    ${mine.length ? `<section class="card"><h2>${esc(t("recent_checkins"))}</h2><ul class="recent">${mine.map((e) =>
      `<li><strong>${esc(e.data.date)}</strong> ${esc(t("chart_pain").split(" ")[0])} ${e.data.pain}/10${e.data.fever_f != null ? `, ${e.data.fever_f}°F` : ""}${e.data.wound_discharge ? `, ${esc(t("WOUND_DISCHARGE"))}` : ""}
      <span class="muted">${esc(t("by", { who: e.data.by || "?" }))}</span></li>`).join("")}</ul></section>` : ""}`;
}

function distanceKm(a, b, c, d) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function viewHelp() {
  const plan = S().plan || {};
  const info = statusInfo();
  const findings = info.result.findings.map((f) => `<li>${esc(findingText(f))}</li>`).join("");
  const cache = S().helpCache;
  let nearby = "";
  if (ui.nearby?.state === "loading") nearby = `<p class="muted">${esc(t("locating"))}</p>`;
  else if (ui.nearby?.state === "denied") nearby = `<p class="error">${esc(t("location_denied"))}</p>`;
  if (ui.nearby?.state === "failed") nearby = `<p class="error">${esc(t("nearby_failed"))}</p>`;
  const items = cache?.items;
  if (items && ui.nearby?.state !== "loading") {
    const when = new Date(cache.at).toLocaleString();
    nearby += ui.nearby?.state === "ok" ? "" : `<p class="muted small-text">${esc(t("saved_list", { when }))}</p>`;
    nearby += items.length ? `<ul class="places">${items.map((p) => `<li><div><strong>${esc(p.name)}</strong><div class="muted small-text">${esc(t("away_km", { km: p.km.toFixed(1) }))}</div></div>
      <div class="placeact">${p.phone ? `<a class="btn small ghost" href="${esc(telHref(p.phone))}">${esc(t("call_doctor").split(" ")[0])}</a>` : ""}
      <a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}">${esc(t("directions"))}</a></div></li>`).join("")}</ul>`
      : `<p class="muted">${esc(t("nearby_none"))}</p>`;
  }
  return `<header class="top"><h1>${esc(t("help_title"))}</h1>${syncPill()}</header>
    ${findings ? `<section class="status status-${info.state}"><ul class="findings">${findings}</ul></section>` : ""}
    <section class="card">${emergencyButtons(plan)}</section>
    ${plan.red_flag_text?.length ? `<section class="card"><h2>${esc(t("signs_title"))}</h2><ul class="bullets">${plan.red_flag_text.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></section>` : ""}
    <section class="card"><h2>${esc(t("nearest"))}</h2>
      <button class="btn primary" data-action="nearby" ${ui.nearby?.state === "loading" ? "disabled" : ""}>${esc(t("find_nearby"))}</button>${nearby}</section>`;
}

function viewPlan() {
  const st = S(), plan = st.plan || {};
  const code = st.familyCode;
  return `<header class="top"><h1>${esc(t("tab_plan"))}</h1>${syncPill()}</header>
    <section class="card"><h2>${esc(t("family_title"))}</h2>
      ${code ? `<p>${esc(t("family_code_is"))}</p><p class="code" aria-label="${esc(code.split("").join(" "))}">${esc(code)}</p>
        <p class="muted small-text">${esc(t("share_hint"))}</p>
        <div class="btnrow"><button class="btn small" data-action="copy">${esc(t("copy"))}</button><button class="btn small ghost" data-action="syncnow">${esc(t("sync_now"))}</button></div>`
      : `<p class="muted">${esc(t("share_hint"))}</p><button class="btn primary" data-action="share">${esc(t("share"))}</button>`}
      <p class="error" id="plan-error" role="alert" ${ui.error ? "" : "hidden"}>${esc(ui.error)}</p>
      <p class="muted small-text">${esc(t("me_label", { who: st.me || "?" }))}</p></section>
    <section class="card"><h2>${esc(t("patient"))}: ${esc(plan.patient_name || "-")}</h2>
      <p class="muted">${esc(t("discharge_date"))}: ${esc(plan.discharge_date || "-")}${plan.doctor_phone ? ` · ${esc(plan.doctor_phone)}` : ""}</p>
      <p class="muted">${esc(t("fever_limit"))}: ${esc(plan.red_flags?.fever_limit_f ?? "-")} · ${esc(t("pain_limit"))}: ${esc(plan.red_flags?.pain_limit ?? "-")}</p>
      <h3>${esc(t("medicines"))}</h3>
      ${(plan.medicines || []).length ? `<ul class="bullets">${plan.medicines.map((m) => `<li><strong>${esc(m.name)}</strong> ${esc(m.dose)} <span class="muted">${esc((m.times || []).join(", "))}</span></li>`).join("")}</ul>` : `<p class="muted">-</p>`}
      ${plan.restrictions?.length ? `<h3>${esc(t("restrictions"))}</h3><ul class="bullets">${plan.restrictions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${plan.appointments?.length ? `<h3>${esc(t("appointments"))}</h3><ul class="bullets">${plan.appointments.map((a) => `<li>${esc(a.date)} ${esc(a.note)}</li>`).join("")}</ul>` : ""}
      <button class="btn small" data-action="editplan">${esc(t("edit_plan"))}</button></section>
    <section class="card"><h2>${esc(t("language"))}</h2>${langChips()}</section>
    <button class="btn danger wide" data-action="reset">${esc(t("start_over"))}</button>`;
}

// ---------- plan editor (used in onboarding and Plan tab) ----------
function blankDraft() {
  return {
    patient_name: "", discharge_date: localDate(), doctor_phone: "", medicines: [], red_flag_text: [],
    restrictions: [], appointments: [],
    red_flags: { fever_limit_f: DEFAULT_FEVER_LIMIT_F, pain_limit: DEFAULT_PAIN_LIMIT, fever_from_summary: false, pain_from_summary: false },
  };
}

function viewEditor(onboarding) {
  const d = ui.draft;
  const flags = d.red_flags;
  const meds = d.medicines.length ? d.medicines : [];
  return `<header class="top"><h1>${esc(onboarding ? t("add_summary") : t("edit_plan"))}</h1></header>
    <section class="card">
      <p class="muted">${esc(t("add_summary_hint"))}</p>
      <label class="filebtn btn small">${esc(t("photo"))}<input type="file" accept="image/*" capture="environment" data-change="photo" hidden></label>
      ${ui.photo ? `<p class="muted small-text">${esc(t("photo_ready", { name: ui.photo.name }))}</p>` : ""}
      <label for="paste">${esc(t("paste"))}</label>
      <textarea id="paste" rows="4" data-keep="paste">${esc(ui.paste || "")}</textarea>
      <button class="btn primary" data-action="extract" ${ui.busy ? "disabled" : ""}>${esc(ui.busy ? t("reading") : t("read_summary"))}</button>
      <p class="error" id="extract-error" role="alert" ${ui.error && ui.errorFor === "extract" ? "" : "hidden"}>${esc(ui.errorFor === "extract" ? ui.error : "")}</p>
    </section>
    <form class="card form" id="plan-form" data-form="plan" novalidate>
      <h2>${esc(t("review_title"))}</h2><p class="muted">${esc(t("review_hint"))}</p>
      <label for="f-patient">${esc(t("patient_name"))}</label><input id="f-patient" name="patient_name" value="${esc(d.patient_name)}" maxlength="80" required>
      <label for="f-date">${esc(t("discharge_date"))}</label><input id="f-date" name="discharge_date" type="date" value="${esc(d.discharge_date)}" required>
      <label for="f-phone">${esc(t("doctor_phone"))}</label><input id="f-phone" name="doctor_phone" type="tel" value="${esc(d.doctor_phone)}" maxlength="30">
      <div class="two">
        <div><label for="f-fever">${esc(t("fever_limit"))}</label><input id="f-fever" name="fever_limit_f" type="number" step="0.1" min="95" max="106" value="${esc(flags.fever_limit_f)}">
          ${flags.fever_from_summary === false ? `<p class="warnline">${esc(t("limit_default"))}</p>` : ""}</div>
        <div><label for="f-pain">${esc(t("pain_limit"))}</label><input id="f-pain" name="pain_limit" type="number" step="1" min="1" max="10" value="${esc(flags.pain_limit)}">
          ${flags.pain_from_summary === false ? `<p class="warnline">${esc(t("limit_default"))}</p>` : ""}</div>
      </div>
      <label for="f-signs">${esc(t("warning_signs"))} <span class="muted">(${esc(t("warning_signs_hint"))})</span></label>
      <textarea id="f-signs" name="red_flag_text" rows="4">${esc(d.red_flag_text.join("\n"))}</textarea>
      <h3>${esc(t("medicines"))}</h3>
      ${meds.map((m, i) => `<fieldset class="med" data-med="${i}">
        <label>${esc(t("med_name"))}<input name="med_name" value="${esc(m.name)}" maxlength="80"></label>
        <label>${esc(t("dose"))}<input name="med_dose" value="${esc(m.dose)}" maxlength="80"></label>
        <label>${esc(t("times"))}<input name="med_times" value="${esc((m.times || []).join(" "))}" inputmode="numeric"></label>
        ${m.times_guessed ? `<p class="warnline">${esc(t("times_guessed"))}</p>` : ""}
        <button type="button" class="btn small ghost" data-action="delmed" data-i="${i}">${esc(t("remove"))}</button></fieldset>`).join("")}
      <button type="button" class="btn small" data-action="addmed">${esc(t("add_medicine"))}</button>
      <p class="error" id="form-error" role="alert" ${ui.error && ui.errorFor === "plan" ? "" : "hidden"}>${esc(ui.errorFor === "plan" ? ui.error : "")}</p>
      <button class="btn primary wide" type="submit">${esc(t("save_plan"))}</button>
      ${onboarding ? "" : `<button type="button" class="btn ghost wide" data-action="canceledit">${esc(t("back"))}</button>`}
    </form>`;
}

function readDraft() {
  const form = document.getElementById("plan-form");
  if (!form || !ui.draft) return;
  const f = new FormData(form);
  const d = ui.draft;
  d.patient_name = f.get("patient_name") ?? d.patient_name;
  d.discharge_date = f.get("discharge_date") ?? d.discharge_date;
  d.doctor_phone = f.get("doctor_phone") ?? d.doctor_phone;
  const fever = num(f.get("fever_limit_f")), pain = num(f.get("pain_limit"));
  d.red_flags = { ...d.red_flags, fever_limit_f: fever ?? d.red_flags.fever_limit_f, pain_limit: pain ?? d.red_flags.pain_limit };
  d.red_flag_text = String(f.get("red_flag_text") || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const rows = [...form.querySelectorAll("fieldset.med")];
  d.medicines = rows.map((row, i) => ({
    ...(d.medicines[i] || {}),
    name: row.querySelector('[name="med_name"]').value.trim(),
    dose: row.querySelector('[name="med_dose"]').value.trim(),
    times: parseTimes(row.querySelector('[name="med_times"]').value),
  }));
  const paste = document.getElementById("paste");
  if (paste) ui.paste = paste.value;
}

function parseTimes(text) {
  const out = [];
  for (const raw of String(text).split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([01]?\d|2[0-3])[:.]?([0-5]\d)?$/.exec(raw);
    if (m) out.push(`${pad(+m[1])}:${m[2] ?? "00"}`);
  }
  return [...new Set(out)].sort();
}

function validateDraft(d) {
  const bad = [];
  if (!d.patient_name.trim()) bad.push(t("patient_name"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.discharge_date)) bad.push(t("discharge_date"));
  const fv = d.red_flags.fever_limit_f, pn = d.red_flags.pain_limit;
  if (!(fv >= 95 && fv <= 106)) bad.push(t("fever_limit"));
  if (!(Number.isInteger(pn) && pn >= 1 && pn <= 10)) bad.push(t("pain_limit"));
  d.medicines.forEach((m, i) => {
    if (!m.name) bad.push(`${t("med_name")} ${i + 1}`);
    else if (!m.times.length) bad.push(`${t("times")} (${m.name})`);
  });
  return bad;
}

// ---------- onboarding ----------
function viewOnboarding() {
  if (ui.step === "welcome") {
    return `<main class="welcome"><h1>HomeRecover</h1>${langChips()}<h2>${esc(t("welcome_title"))}</h2><p>${esc(t("welcome_sub"))}</p>
      <button class="btn primary wide" data-action="step" data-step="create">${esc(t("start_new"))}</button>
      <button class="btn ghost wide" data-action="step" data-step="join">${esc(t("join"))}</button></main>`;
  }
  if (ui.step === "create") {
    return `<main class="welcome"><h1>${esc(t("start_new"))}</h1>
      <form class="card form" data-form="create" novalidate>
        <label for="c-me">${esc(t("your_name"))}</label><input id="c-me" name="me" maxlength="40" required autocomplete="given-name">
        <label for="c-pt">${esc(t("patient_name"))}</label><input id="c-pt" name="patient_name" maxlength="80" required>
        <label for="c-dt">${esc(t("discharge_date"))}</label><input id="c-dt" name="discharge_date" type="date" value="${localDate()}" required>
        <p class="error" id="form-error" role="alert" ${ui.error ? "" : "hidden"}>${esc(ui.error)}</p>
        <button class="btn primary wide" type="submit">${esc(t("continue"))}</button>
        <button type="button" class="btn ghost wide" data-action="step" data-step="welcome">${esc(t("back"))}</button></form></main>`;
  }
  if (ui.step === "join") {
    return `<main class="welcome"><h1>${esc(t("join"))}</h1>
      <form class="card form" data-form="join" novalidate>
        <p class="muted">${esc(t("join_hint"))}</p>
        <label for="j-me">${esc(t("your_name"))}</label><input id="j-me" name="me" maxlength="40" required autocomplete="given-name">
        <label for="j-code">${esc(t("family_code"))}</label><input id="j-code" name="code" maxlength="12" required autocapitalize="characters" autocomplete="off" spellcheck="false">
        <p class="error" id="form-error" role="alert" ${ui.error ? "" : "hidden"}>${esc(ui.error)}</p>
        <button class="btn primary wide" type="submit" ${ui.busy ? "disabled" : ""}>${esc(t("join_btn"))}</button>
        <button type="button" class="btn ghost wide" data-action="step" data-step="welcome">${esc(t("back"))}</button></form></main>`;
  }
  return `<main>${viewEditor(true)}</main>`;
}

// ---------- render ----------
function render() {
  const st = S();
  let html;
  const editing = ui.draft && (ui.step === "plansetup" || ui.tab === "editplan");
  if (!st.setupDone) html = viewOnboarding();
  else if (ui.tab === "editplan") html = `<main>${viewEditor(false)}</main>`;
  else {
    const body = { today: viewToday, checkin: viewCheckin, help: viewHelp, plan: viewPlan }[ui.tab]();
    html = `<main>${body}</main>${tabBar()}`;
  }
  const offline = !ui.online ? `<div class="offline" role="status">${esc(t("offline_banner"))}</div>` : "";
  root.innerHTML = `${offline}${html}<div id="toast" class="toast" role="status" ${ui.toast ? "" : "hidden"}>${esc(ui.toast)}</div>`;
  document.documentElement.lang = st.lang;
  void editing;
}

function tabBar() {
  const tabs = ["today", "checkin", "help", "plan"];
  return `<nav class="tabs" aria-label="HomeRecover">${tabs.map((k) =>
    `<button data-action="goto" data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ""}>${ICONS[k]}<span>${esc(t("tab_" + k))}</span></button>`).join("")}</nav>`;
}

// ---------- actions ----------
async function fileToJpegBase64(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.split(",")[1];
}

function speak() {
  if (!("speechSynthesis" in window)) return;
  if (ui.speaking) { speechSynthesis.cancel(); ui.speaking = false; render(); return; }
  const info = statusInfo();
  const titleKey = { none: "status_none", OK: "status_ok", WARN: "status_warn", RED_FLAG: "status_red" }[info.state];
  const parts = [t(titleKey), ...info.result.findings.map(findingText)];
  if (info.state === RED_FLAG) parts.push(t("advice_red")); else if (info.state === WARN) parts.push(t("advice_warn"));
  const plan = S().plan || {};
  const due = todaysSlots(plan, S().events, localDate()).filter((s) => !s.given.length).map((s) => `${s.time} ${s.med.name} ${s.med.dose}`);
  if (due.length) parts.push(`${t("doses_today")}: ${due.join(". ")}`);
  const u = new SpeechSynthesisUtterance(parts.join(". "));
  u.lang = LANGS.find((l) => l.code === S().lang)?.speech || "en-IN";
  u.onend = () => { ui.speaking = false; render(); };
  ui.speaking = true; speechSynthesis.cancel(); speechSynthesis.speak(u); render();
}

async function findNearby() {
  ui.nearby = { state: "loading" }; render();
  let pos;
  try {
    pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000, maximumAge: 300000 }));
  } catch { ui.nearby = { state: S().helpCache ? "cached" : "denied" }; render(); return; }
  const { latitude: lat, longitude: lon } = pos.coords;
  const q = `[out:json][timeout:20];(nwr["amenity"="hospital"](around:6000,${lat},${lon});nwr["amenity"="clinic"](around:6000,${lat},${lon}););out center tags 40;`;
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 22000);
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    const items = (data.elements || []).map((el) => {
      const name = el.tags?.name || el.tags?.["name:en"]; const la = el.lat ?? el.center?.lat; const lo = el.lon ?? el.center?.lon;
      if (!name || la == null || lo == null) return null;
      return { name, lat: la, lon: lo, km: distanceKm(lat, lon, la, lo), phone: el.tags?.phone || el.tags?.["contact:phone"] || "" };
    }).filter(Boolean).sort((a, b) => a.km - b.km).slice(0, 8);
    store.update({ helpCache: { at: new Date().toISOString(), items } });
    ui.nearby = { state: "ok" };
  } catch { ui.nearby = { state: S().helpCache ? "cached" : "failed" }; }
  render();
}

const actions = {
  lang(el) { store.update({ lang: el.dataset.lang }); },
  step(el) { ui.step = el.dataset.step; ui.error = ""; render(); },
  goto(el) { ui.tab = el.dataset.tab; ui.error = ""; render(); window.scrollTo(0, 0); },
  speak() { speak(); },
  nearby() { findNearby(); },
  dose(el) {
    const slot = el.dataset.slot;
    if (S().events.some((e) => e.kind === "dose" && e.data.slot === slot)) return; // already logged on this phone
    store.addEvent("dose", { slot, medicine: el.dataset.med, by: S().me || "?", taken_at: new Date().toISOString() });
  },
  async copy() {
    try { await navigator.clipboard.writeText(S().familyCode); flash(t("copied")); } catch { flash(S().familyCode); }
  },
  async syncnow() { await store.sync(); },
  async share() {
    ui.error = "";
    try { await store.createFamily(); } catch { ui.error = t("need_connection"); render(); }
  },
  editplan() { ui.draft = structuredClone({ ...blankDraft(), ...S().plan, red_flags: { ...blankDraft().red_flags, ...(S().plan?.red_flags || {}), fever_from_summary: true, pain_from_summary: true } }); ui.tab = "editplan"; ui.error = ""; ui.photo = null; render(); },
  canceledit() { ui.draft = null; ui.tab = "plan"; render(); },
  addmed() { readDraft(); ui.draft.medicines.push({ name: "", dose: "", times: ["08:00"], notes: "" }); render(); },
  delmed(el) { readDraft(); ui.draft.medicines.splice(Number(el.dataset.i), 1); render(); },
  reset() { if (confirm(t("start_over_confirm"))) { ui.step = "welcome"; ui.tab = "today"; ui.draft = null; store.reset(); } },
  async extract() {
    readDraft();
    ui.error = ""; ui.errorFor = "extract";
    if (!ui.photo && !(ui.paste || "").trim()) { ui.error = t("add_summary_hint"); render(); return; }
    ui.busy = true; render();
    try {
      const plan = await store.extract({ text: ui.paste || undefined, image_base64: ui.photo?.data, media_type: ui.photo ? "image/jpeg" : undefined });
      const keep = ui.draft;
      ui.draft = { ...blankDraft(), ...plan, patient_name: keep.patient_name || plan.patient_name, discharge_date: keep.discharge_date,
        doctor_phone: plan.doctor_phone || keep.doctor_phone };
    } catch (err) {
      ui.errorFor = "extract";
      ui.error = err.status === 503 ? t("ai_off") : err.status === 0 ? t("need_connection") : err.message;
    }
    ui.busy = false; render();
  },
};

root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el); }
});

root.addEventListener("change", async (e) => {
  if (e.target.dataset.change === "photo" && e.target.files?.[0]) {
    readDraft();
    try { ui.photo = { name: e.target.files[0].name, data: await fileToJpegBase64(e.target.files[0]) }; }
    catch { ui.error = t("nearby_failed"); ui.errorFor = "extract"; }
    render();
  }
});

root.addEventListener("input", (e) => {
  if (e.target.id === "pain") document.getElementById("painout").textContent = e.target.value;
});

root.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const f = new FormData(form);
  const kind = form.dataset.form;
  ui.error = "";
  if (kind === "create") {
    const me = String(f.get("me") || "").trim(), pt = String(f.get("patient_name") || "").trim(), dt = String(f.get("discharge_date") || "");
    if (!me || !pt || !dt) { ui.error = t("fix_fields", { fields: [!me && t("your_name"), !pt && t("patient_name"), !dt && t("discharge_date")].filter(Boolean).join(", ") }); render(); return; }
    store.update({ me });
    ui.draft = { ...blankDraft(), patient_name: pt, discharge_date: dt };
    ui.step = "plansetup"; render();
  } else if (kind === "join") {
    const me = String(f.get("me") || "").trim(), code = String(f.get("code") || "");
    if (!me || !code.trim()) { ui.error = t("fix_fields", { fields: [!me && t("your_name"), !code.trim() && t("family_code")].filter(Boolean).join(", ") }); render(); return; }
    store.update({ me }); ui.busy = true; render();
    try { await store.joinFamily(code); ui.tab = "today"; }
    catch (err) { ui.error = err.status === 404 ? t("join_error") : t("join_offline"); }
    ui.busy = false; render();
  } else if (kind === "plan") {
    readDraft();
    const bad = validateDraft(ui.draft);
    if (bad.length) { ui.error = t("fix_fields", { fields: bad.join(", ") }); ui.errorFor = "plan"; render(); return; }
    const d = ui.draft;
    const plan = { ...d, red_flags: { ...d.red_flags, fever_from_summary: true, pain_from_summary: true },
      medicines: d.medicines.map((m) => ({ name: m.name, dose: m.dose, times: m.times, notes: m.notes || "" })) };
    store.setPlan(plan);
    store.update({ setupDone: true });
    ui.draft = null; ui.photo = null; ui.paste = ""; ui.tab = "today"; ui.step = "welcome"; render(); window.scrollTo(0, 0);
  } else if (kind === "checkin") {
    const fever = num(f.get("fever"));
    if (fever != null && !(fever >= 90 && fever <= 110)) { ui.error = t("fix_fields", { fields: t("fever_q") }); render(); return; }
    store.addEvent("checkin", { date: localDate(), pain: Number(f.get("pain")), fever_f: fever, wound_discharge: f.get("wound") === "yes", by: S().me || "?" });
    ui.tab = "today"; render(); flash(t("saved")); window.scrollTo(0, 0);
  }
});

store.subscribe((reason) => {
  if (reason === "sync-status") { updatePill(); return; }
  if (reason === "sync-data") {
    if (S().setupDone && (ui.tab === "today" || ui.tab === "plan" || ui.tab === "help")) render();
    return;
  }
  render();
});

window.addEventListener("online", () => { ui.online = true; render(); store.sync(); });
window.addEventListener("offline", () => { ui.online = false; render(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) store.sync(); });
setInterval(() => { if (!document.hidden && navigator.onLine) store.sync(); }, 20000);

render();
store.sync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* app still works without offline cache */ });
}
