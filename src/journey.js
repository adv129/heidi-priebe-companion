/*
 * Heidi Priebe Agent — Journey stores (src/journey.js).
 *
 * Two small disk stores that no other file owns, plus the read-time composition
 * of the user-visible journey timeline:
 *
 *   memory/experiments.json   pattern-replacement experiments (the change loop)
 *   memory/timeline.json      dated life events + milestones
 *
 * Everything else on the timeline (sessions, hypotheses, assignments, goal
 * movement) already lives in memory.js stores and is merged at READ time by
 * composeTimeline() — never duplicated here.
 *
 * Writes happen only via applyConsolidation() at session end (the app's single
 * write point), keeping per-turn reads pure. All `now` params are injectable.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const memory = require("./memory");
const ta = require("./timeaware");

const EXPERIMENTS_PATH = path.join(memory.MEM_DIR, "experiments.json");
const TIMELINE_PATH = path.join(memory.MEM_DIR, "timeline.json");

const MAX_RUNNING_EXPERIMENTS = 2;
const EVENT_EXPIRY_DAYS = 21;
const CHECKIN_DUE_DAYS = 4;

// --- Stores ------------------------------------------------------------------

function loadJson(p, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(p, "utf8")) }; } catch { return fallback; }
}
function saveJson(p, data) {
  memory.ensureDirs();
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return data;
}

function loadExperiments() { return loadJson(EXPERIMENTS_PATH, { version: 1, experiments: [] }); }
function saveExperiments(d) { return saveJson(EXPERIMENTS_PATH, d); }
function loadTimeline() { return loadJson(TIMELINE_PATH, { version: 1, events: [], milestones: [] }); }
function saveTimeline(d) { return saveJson(TIMELINE_PATH, d); }

function newId(prefix, existingIds) {
  const base = `${prefix}-${memory.stamp().id}`;
  let id = base;
  for (let n = 2; existingIds.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function normText(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

// --- Events / milestones -------------------------------------------------------

/** Add a dated life event (dedupe on similar text + same date). */
function addEvent(tl, { text, date, confidence }, sessionId) {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const dup = tl.events.find((e) => e.date === date && normText(e.text) === normText(text));
  if (dup) return null;
  const evt = {
    id: newId("evt", tl.events.map((e) => e.id)),
    text: String(text),
    date: String(date),
    confidence: confidence === "approx" ? "approx" : "exact",
    status: "upcoming",
    source: sessionId || null,
    createdAt: memory.stamp().id,
    followUp: null,
  };
  tl.events.push(evt);
  return evt;
}

function resolveEvent(tl, eventId, note, sessionId) {
  const evt = tl.events.find((e) => e.id === eventId);
  if (!evt) return null;
  evt.status = "followed-up";
  evt.followUp = { at: memory.stamp().id, note: String(note || ""), sessionId: sessionId || null };
  return evt;
}

function addMilestone(tl, text, sessionId) {
  if (!text) return null;
  const ms = { id: newId("ms", tl.milestones.map((m) => m.id)), at: memory.stamp().id, text: String(text), source: sessionId || null };
  tl.milestones.push(ms);
  return ms;
}

/** Passed >EVENT_EXPIRY_DAYS days ago and never mentioned again → quietly expire. */
function expireStaleEvents(tl, now) {
  for (const e of tl.events) {
    if (e.status === "upcoming") {
      const d = ta.dayDiff(e.date, now);
      if (d !== null && d > EVENT_EXPIRY_DAYS) e.status = "expired";
    }
  }
}

// --- Experiments -----------------------------------------------------------------

function createExperiment(store, input, sessionId) {
  if (!input || !input.thePattern || !input.theReplacement) return null;
  const runningCount = store.experiments.filter((e) => e.status === "running").length;
  const agreed = input.agreed === true && runningCount < MAX_RUNNING_EXPERIMENTS;
  const nowId = memory.stamp().id;
  const exp = {
    id: newId("exp", store.experiments.map((e) => e.id)),
    hypothesisId: typeof input.hypothesisId === "string" ? input.hypothesisId : null,
    goalId: typeof input.goalId === "string" ? input.goalId : null,
    thePattern: String(input.thePattern),
    theReplacement: String(input.theReplacement),
    strategy: String(input.strategy || ""),
    lens: typeof input.lens === "string" ? input.lens : null,
    proposedAt: nowId,
    startedAt: agreed ? nowId : null,
    checkIns: [],
    status: agreed ? "running" : "proposed",
    outcome: null,
    source: sessionId || null,
  };
  store.experiments.push(exp);
  return exp;
}

const VERDICTS = ["helping", "mixed", "not-yet", "hard-to-say"];
const EXP_STATUSES = ["proposed", "running", "paused", "concluded"];

function applyExperimentUpdate(store, u, sessionId) {
  const exp = store.experiments.find((e) => e.id === u.experimentId);
  if (!exp) return null;
  const at = memory.stamp().id;
  if (u.checkIn && u.checkIn.note) {
    exp.checkIns.push({
      at,
      note: String(u.checkIn.note),
      verdict: VERDICTS.includes(u.checkIn.verdict) ? u.checkIn.verdict : "hard-to-say",
      sessionId: sessionId || null,
    });
  }
  if (u.statusChange && EXP_STATUSES.includes(u.statusChange)) {
    exp.status = u.statusChange;
    if (u.statusChange === "running" && !exp.startedAt) exp.startedAt = at;
  }
  if (u.outcome && u.outcome.summary) {
    exp.status = "concluded";
    exp.outcome = {
      at,
      summary: String(u.outcome.summary),
      keeping: u.outcome.keeping === true || u.outcome.keeping === false ? u.outcome.keeping : "adapted",
    };
  }
  return exp;
}

// --- Consolidation fold ----------------------------------------------------------

/**
 * Fold a consolidate result's journey fields into the stores. Every item is
 * applied independently in try/catch — malformed output never blocks the save.
 * Handles: datedEvents, eventFollowUps, newExperiment, experimentUpdates, milestones.
 * (goalProgress / hypothesisUpdates / assignmentUpdates are memory.js's job.)
 */
function applyConsolidation(parsed, sessionId, now = new Date()) {
  if (!parsed || typeof parsed !== "object") return;

  const tl = loadTimeline();
  let tlDirty = false;
  for (const ev of Array.isArray(parsed.datedEvents) ? parsed.datedEvents.slice(0, 3) : []) {
    try { if (addEvent(tl, ev, sessionId)) tlDirty = true; } catch {}
  }
  for (const fu of Array.isArray(parsed.eventFollowUps) ? parsed.eventFollowUps.slice(0, 3) : []) {
    try { if (fu && resolveEvent(tl, fu.eventId, fu.note, sessionId)) tlDirty = true; } catch {}
  }
  for (const ms of Array.isArray(parsed.milestones) ? parsed.milestones.slice(0, 2) : []) {
    try { if (addMilestone(tl, ms, sessionId)) tlDirty = true; } catch {}
  }
  try {
    const before = JSON.stringify(tl.events.map((e) => e.status));
    expireStaleEvents(tl, now);
    if (JSON.stringify(tl.events.map((e) => e.status)) !== before) tlDirty = true;
  } catch {}
  if (tlDirty) saveTimeline(tl);

  const store = loadExperiments();
  let expDirty = false;
  try {
    if (parsed.newExperiment && createExperiment(store, parsed.newExperiment, sessionId)) expDirty = true;
  } catch {}
  for (const u of Array.isArray(parsed.experimentUpdates) ? parsed.experimentUpdates.slice(0, 3) : []) {
    try { if (u && applyExperimentUpdate(store, u, sessionId)) expDirty = true; } catch {}
  }
  if (expDirty) saveExperiments(store);
}

// --- Prompt blocks ---------------------------------------------------------------

/**
 * Experiments block for the respond prompt, including the deterministic gate:
 * no supported hypothesis on record → the model is told NOT to propose experiments.
 */
function experimentsContext(now = new Date()) {
  const store = loadExperiments();
  const hyps = (typeof memory.getHypotheses === "function" ? memory.getHypotheses() : []) || [];
  const supported = hyps.filter((h) => h.status === "supported");
  const lines = [];

  const active = store.experiments.filter((e) => e.status === "running" || e.status === "proposed");
  for (const e of active.slice(0, 3)) {
    if (e.status === "running") {
      const day = (ta.dayDiff(e.startedAt, now) || 0) + 1;
      lines.push(`- [${e.id}] RUNNING (day ${day}): trying "${e.theReplacement}" instead of "${e.thePattern}"${e.checkIns.length ? ` — last check-in: "${e.checkIns[e.checkIns.length - 1].note}" (${e.checkIns[e.checkIns.length - 1].verdict})` : ""}`);
    } else {
      lines.push(`- [${e.id}] PROPOSED (they haven't said yes yet): "${e.theReplacement}" instead of "${e.thePattern}" — only revisit if THEY bring up wanting change.`);
    }
  }

  if (!supported.length) {
    lines.push("(no pattern has been confirmed with them yet — do NOT propose experiments; keep building understanding)");
  } else {
    const linked = new Set(store.experiments.filter((e) => e.hypothesisId && e.status !== "concluded").map((e) => e.hypothesisId));
    const unaddressed = supported.find((h) => !linked.has(h.id));
    if (unaddressed && store.experiments.filter((e) => e.status === "running").length < MAX_RUNNING_EXPERIMENTS) {
      lines.push(`(the pattern "${unaddressed.statement}" is confirmed with them and has no experiment yet — if THEY express wanting change there, you may co-design a small experiment together)`);
    }
  }

  return lines.join("\n");
}

/**
 * Deterministic opener-chip candidates, priority-ordered. Chips are invitations —
 * no "overdue", no day counts, no status language.
 */
function openerCandidates(now = new Date()) {
  const out = [];
  const tl = loadTimeline();

  const passed = tl.events
    .filter((e) => {
      const d = ta.dayDiff(e.date, now);
      return e.status === "upcoming" && d !== null && d > 0 && d <= 14;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (passed.length) {
    const text = passed[0].text.length > 30 ? passed[0].text.slice(0, 30).trim() + "…" : passed[0].text;
    out.push({ kind: "event", label: `How did ${text} go?`, message: `I want to tell you how it went — ${passed[0].text}.` });
  }

  const store = loadExperiments();
  const due = store.experiments.filter((e) => {
    if (e.status !== "running") return false;
    const lastAt = e.checkIns.length ? e.checkIns[e.checkIns.length - 1].at : e.startedAt;
    const d = ta.dayDiff(lastAt, now);
    return d !== null && d >= CHECKIN_DUE_DAYS;
  });
  if (due.length) {
    const e = due[0];
    const short = e.theReplacement.length > 26 ? e.theReplacement.slice(0, 26).trim() + "…" : e.theReplacement;
    out.push({ kind: "experiment", label: `Check in: ${short}`, message: `I want to check in on the experiment we set up — "${e.theReplacement}".` });
  }

  // At most one "check-in-ish" chip per opener: keep the highest-priority one.
  return out.slice(0, 1);
}

// --- Views + wipe -----------------------------------------------------------------

/**
 * Compose the user-visible journey from every store, sorted newest first.
 * Entry: { at, type, title, detail, refId, refKind }.
 */
function composeTimeline() {
  const entries = [];
  const push = (at, type, title, detail, refId, refKind) => {
    if (at) entries.push({ at, type, title: title || "", detail: detail || "", refId: refId || null, refKind: refKind || null });
  };

  for (const s of memory.listSessions()) {
    push(s.id, s.mode === "explore" ? "explore-session" : "session", s.title, s.summary, s.id, "session");
  }

  const tl = loadTimeline();
  for (const e of tl.events) {
    if (e.status === "followed-up") push(e.date, "life-event", e.text, e.followUp ? e.followUp.note : "", e.id, "event");
    else if (e.status === "upcoming") push(e.date, "upcoming", e.text, e.confidence === "approx" ? "around this time" : "", e.id, "event");
  }
  for (const m of tl.milestones) push(m.at, "milestone", m.text, "", m.id, "milestone");

  const store = loadExperiments();
  for (const e of store.experiments) {
    if (e.startedAt) push(e.startedAt, "experiment-started", `Trying: ${e.theReplacement}`, `instead of ${e.thePattern}`, e.id, "experiment");
    for (const c of e.checkIns) push(c.at, "experiment-checkin", `Check-in: ${e.theReplacement}`, `${c.note} (${c.verdict})`, e.id, "experiment");
    if (e.outcome) push(e.outcome.at, "experiment-concluded", `Wrapped up: ${e.theReplacement}`, e.outcome.summary, e.id, "experiment");
  }

  const hyps = (typeof memory.getHypotheses === "function" ? memory.getHypotheses() : []) || [];
  for (const h of hyps) {
    if (h.status === "supported" && h.statusChangedAt) push(h.statusChangedAt, "pattern-named", "A pattern came into focus", h.statement, h.id, "hypothesis");
  }

  const ASG_TITLES = { notice: "Something to notice", action: "Something to try", reflection: "Something to reflect on" };
  const asgs = (typeof memory.getAssignments === "function" ? memory.getAssignments() : []) || [];
  for (const a of asgs) {
    push(a.givenAt, "assignment-given", ASG_TITLES[a.type] || ASG_TITLES.notice, a.text, a.id, "assignment");
    if (a.report) push(a.report.at, "assignment-reported", "Reported back", a.report.findings, a.id, "assignment");
  }

  const goals = (memory.loadProfile().goals || []).filter((g) => g && typeof g === "object");
  for (const g of goals) {
    for (const pr of g.progress || []) push(pr.at, "goal-movement", g.text, pr.note ? `${pr.note} (${pr.movement})` : pr.movement, g.id, "goal");
  }

  // Upcoming entries sort to the top separately in the UI; here just sort by time desc.
  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return entries;
}

function journeyView() {
  const tl = loadTimeline();
  return { experiments: loadExperiments().experiments, events: tl.events, milestones: tl.milestones };
}

function wipe() {
  try { fs.unlinkSync(EXPERIMENTS_PATH); } catch {}
  try { fs.unlinkSync(TIMELINE_PATH); } catch {}
  return { ok: true };
}

module.exports = {
  loadExperiments,
  saveExperiments,
  loadTimeline,
  saveTimeline,
  applyConsolidation,
  experimentsContext,
  openerCandidates,
  composeTimeline,
  journeyView,
  wipe,
  MAX_RUNNING_EXPERIMENTS,
  CHECKIN_DUE_DAYS,
};
