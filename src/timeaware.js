/*
 * Heidi Priebe Agent — Time awareness (src/timeaware.js).
 *
 * Pure helpers that give the companion a real sense of time passing. Every
 * relative phrase ("3 days ago", "in 4 days") is computed HERE, server-side —
 * the model is told to trust these lines and never do date math itself.
 *
 * All functions take an injectable `now` so tests can fake the clock. Dates on
 * disk are either memory.stamp() ids (2026-07-10T14-22-01), plain YYYY-MM-DD,
 * or standard ISO — parseWhen() handles all three. Times are server-local
 * (single-user local app, consistent with memory.stamp()).
 */

"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Parse a stamp id, a plain date, or ISO into a Date; null if unparseable. */
function parseWhen(s) {
  if (s instanceof Date) return isNaN(s) ? null : s;
  if (typeof s !== "string" || !s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  // memory.stamp() format: 2026-07-10T14-22-01 (+ optional -N collision suffix)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days from `when` to `now`. Positive = past, negative = future, 0 = today. */
function dayDiff(when, now = new Date()) {
  const w = parseWhen(when);
  if (!w) return null;
  return Math.round((startOfDay(now) - startOfDay(w)) / DAY_MS);
}

/** Human phrase for how long ago / until: "today", "yesterday", "in 4 days", "about 3 weeks ago". */
function relPhrase(when, now = new Date()) {
  const d = dayDiff(when, now);
  if (d === null) return "";
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d === -1) return "tomorrow";
  const abs = Math.abs(d);
  let unit;
  if (abs < 14) unit = `${abs} days`;
  else if (abs < 60) unit = `about ${Math.round(abs / 7)} weeks`;
  else if (abs < 365) unit = `about ${Math.round(abs / 30)} months`;
  else unit = `over a year`;
  return d > 0 ? `${unit} ago` : `in ${unit}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

function shortDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Friday, 10 July 2026, 2:31 pm" */
function longNow(now = new Date()) {
  let h = now.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}, ${h}:${pad(now.getMinutes())} ${ampm}`;
}

/**
 * Cadence phrase from graph sessions (sorted newest first, ids are stamps).
 * Returns "" when there's nothing meaningful to say.
 */
function cadence(sessions, now = new Date()) {
  const times = (sessions || []).map((s) => parseWhen(s.id)).filter(Boolean).slice(0, 8);
  if (times.length < 3) return "";
  const gaps = [];
  for (let i = 0; i < times.length - 1; i++) gaps.push(Math.abs(dayDiff(times[i + 1], times[i])));
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 1) return "most days";
  if (median <= 3) return "roughly every 2-3 days";
  if (median <= 9) return "about weekly";
  if (median <= 18) return "about every couple of weeks";
  return "occasional, with long stretches between";
}

/**
 * Calendar lookup table for the consolidate prompt: 7 days back through 20 days
 * forward, so "next Tuesday" resolves by lookup, never by model arithmetic.
 */
function calendarTable(now = new Date()) {
  const lines = [];
  for (let off = -7; off <= 20; off++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
    const rel = off === 0 ? "TODAY" : relPhrase(d, now);
    lines.push(`${WEEKDAYS[d.getDay()].slice(0, 3)} ${shortDate(d)} (${rel})`);
  }
  return lines.join("\n");
}

/**
 * The injectable TIME CONTEXT block.
 * opts: { now, sessions, events, experiments, assignments, goals, mode }
 *   mode "respond" → full block; mode "route" → one dense line.
 * Hard caps keep this from ever reading as surveillance: ≤2 upcoming events,
 * ≤1 passed-unresolved, ≤1 assignment line, ≤2 experiments, ≤1 aging goal.
 */
function timeContext({ now = new Date(), sessions = [], events = [], experiments = [], assignments = [], goals = [], mode = "respond" } = {}) {
  const today = startOfDay(now);
  const upcoming = events
    .filter((e) => e.status === "upcoming" && parseWhen(e.date) && startOfDay(parseWhen(e.date)) >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const passed = events
    .filter((e) => {
      const d = dayDiff(e.date, now);
      return e.status === "upcoming" && d !== null && d > 0 && d <= 21;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const running = experiments.filter((e) => e.status === "running");
  const openAsg = assignments.filter((a) => a.status === "open");
  const quietGoals = goals.filter((g) => {
    if (!g || typeof g !== "object") return false;
    if (g.status === "achieved") return false;
    const last = (g.progress && g.progress.length) ? g.progress[g.progress.length - 1].at : (g.createdAt || g.updatedAt);
    const d = dayDiff(last, now);
    return d !== null && d >= 21;
  });

  if (mode === "route") {
    const d = new Date(now);
    const bits = [`Today: ${WEEKDAYS[d.getDay()].slice(0, 3)} ${shortDate(d)}.`];
    if (sessions.length) bits.push(`Last session: ${relPhrase(sessions[0].id, now)}.`);
    const counts = [];
    if (passed.length) counts.push(`${passed.length} passed event(s) not yet asked about`);
    if (running.length) counts.push(`${running.length} experiment(s) running`);
    if (openAsg.length) counts.push(`${openAsg.length} open homework item(s)`);
    if (counts.length) bits.push(counts.join("; ") + ".");
    return bits.join(" ");
  }

  const lines = [`Today is ${longNow(now)}.`];

  if (sessions.length) {
    const last = sessions[0];
    const cad = cadence(sessions, now);
    lines.push(`Last session: ${relPhrase(last.id, now)}${last.title ? ` ("${last.title}")` : ""}.${cad ? ` Recent cadence: ${cad}.` : ""}`);
  }

  if (upcoming.length) {
    const parts = upcoming.slice(0, 2).map((e) => {
      const when = e.confidence === "approx" ? `around ${e.date}` : `${relPhrase(e.date, now)} (${e.date})`;
      return `"${e.text}" — ${when}`;
    });
    lines.push(`Coming up for them: ${parts.join("; ")}.`);
  }

  if (passed.length) {
    const e = passed[0];
    lines.push(`Passed, not yet asked about: "${e.text}" — was ${relPhrase(e.date, now)}. If it fits naturally, ask how it went (once, lightly — never as a check-up).`);
  }

  if (openAsg.length) {
    const a = openAsg.slice().sort((x, y) => String(x.givenAt).localeCompare(String(y.givenAt)))[0];
    lines.push(`Open homework (${a.type || "notice"}): given ${relPhrase(a.givenAt, now)} — "${a.text}".`);
  }

  for (const e of running.slice(0, 2)) {
    const day = (dayDiff(e.startedAt, now) || 0) + 1;
    const lastCheck = e.checkIns && e.checkIns.length ? e.checkIns[e.checkIns.length - 1] : null;
    const checkBit = lastCheck ? `, last check-in ${relPhrase(lastCheck.at, now)} (${lastCheck.verdict})` : ", no check-ins yet";
    lines.push(`Running experiment: trying "${e.theReplacement}" instead of "${e.thePattern}" — day ${day}${checkBit}.`);
  }

  if (quietGoals.length) {
    const g = quietGoals[0];
    const last = (g.progress && g.progress.length) ? g.progress[g.progress.length - 1].at : (g.createdAt || g.updatedAt);
    lines.push(`Goal quietly aging: "${g.text}" — no movement noted in ${dayDiff(last, now)} days (mention only if it arises naturally; never as a nudge).`);
  }

  return lines.join("\n");
}

module.exports = {
  parseWhen,
  dayDiff,
  relPhrase,
  longNow,
  cadence,
  calendarTable,
  timeContext,
  shortDate,
};
