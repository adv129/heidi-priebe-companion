/*
 * Heidi Priebe Agent — Referential-network memory (src/memory.js).
 *
 * Memory is a small graph on disk, mirroring the Builder Log Agent's
 * "markdown-first + json-state" duality:
 *
 *   memory/profile.json      global PROFILE (agent-core schema) + onboarding seed
 *   memory/graph.json        the network: sessions[] + skill→sessions reverse index
 *   memory/sessions/<id>.md  human-readable session record with [[links]]
 *
 * The network links skills ↔ sessions ↔ skills. When a skill is activated, the
 * caller injects that skill's recent prior sessions (1 hop) — each carrying its
 * OWN skill tags, so a past relationship chat that also touched shame surfaces
 * that link. Deeper hops (pulling a full past session) are done on demand.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MEM_DIR = path.join(ROOT, "memory");
const SESSIONS_DIR = path.join(MEM_DIR, "sessions");
const PROFILE_PATH = path.join(MEM_DIR, "profile.json");
const GRAPH_PATH = path.join(MEM_DIR, "graph.json");

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// --- Timestamps ------------------------------------------------------------

function stamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const id = `${date}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return { date, id };
}

// --- Profile ---------------------------------------------------------------

function defaultProfile() {
  return {
    name: "",
    onboarding: {},
    // The evolving PROFILE schema:
    lifeContext: "", // who they are / their situation
    people: [], // relational map: [{ name, relationship, notes }]
    values: [], // what matters to them
    goals: [], // structured: [{ id, text, status, progress:[{at,movement,note}], createdAt, updatedAt }]
    history: [], // key turning points they've shared
    whatHelps: [], // things that have helped / been tried
    relationalContext: "",
    emotionalStyle: "",
    readiness: "",
    presentingConcerns: [], // recurring themes across sessions
    suspectedPatterns: [], // legacy — migrated into hypotheses on load
    hypotheses: [], // transparent working model: see applyHypothesisUpdates for shape
    assignments: [], // noticing assignments: see applyAssignmentUpdates for shape
    childhoodSignals: [],
    skillsVisited: {}, // skillName -> count
    redFlags: [],
    nextOpener: null, // { blurb, options:[] } pre-generated at last session end
    createdAt: null,
    updatedAt: null,
  };
}

/** Unique id within a list: <prefix>-<stamp> with a collision suffix. */
function newId(prefix, existingIds = []) {
  const base = `${prefix}-${stamp().id}`;
  let id = base;
  for (let n = 2; existingIds.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function normStatement(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Goals: strings become structured objects; objects get missing fields defaulted. Returns true if anything changed. */
function normalizeGoals(p) {
  if (!Array.isArray(p.goals)) { p.goals = []; return true; }
  let changed = false;
  const ids = p.goals.map((g) => (g && g.id) || "").filter(Boolean);
  p.goals = p.goals.map((g) => {
    if (typeof g === "string") {
      const id = newId("goal", ids);
      ids.push(id);
      changed = true;
      return { id, text: g, status: "active", progress: [], createdAt: p.updatedAt || stamp().id, updatedAt: p.updatedAt || stamp().id };
    }
    if (g && typeof g === "object") {
      if (!g.id) { g.id = newId("goal", ids); ids.push(g.id); changed = true; }
      g.text = g.text || "";
      if (!["active", "progressing", "stalled", "achieved"].includes(g.status)) { g.status = "active"; }
      g.progress = Array.isArray(g.progress) ? g.progress : [];
      g.createdAt = g.createdAt || p.updatedAt || stamp().id;
      g.updatedAt = g.updatedAt || g.createdAt;
      return g;
    }
    changed = true;
    return null;
  }).filter((g) => g && g.text);
  return changed;
}

/**
 * One-time migration: legacy suspectedPatterns strings → forming hypotheses;
 * goal strings → structured goals. Returns true if anything changed so the
 * caller can PERSIST immediately — generated ids must be stable across loads
 * (consolidation references them by id a call later).
 */
function migrateProfile(p) {
  let changed = false;
  if (!Array.isArray(p.hypotheses)) { p.hypotheses = []; }
  if (!Array.isArray(p.assignments)) { p.assignments = []; }
  if (Array.isArray(p.suspectedPatterns) && p.suspectedPatterns.length) {
    for (const s of p.suspectedPatterns) {
      addHypothesis(p, { statement: String(s).replace(/\s*\((?:tentative|hypothesis)\)\s*$/i, ""), origin: "migrated" });
    }
    p.suspectedPatterns = [];
    changed = true;
  }
  if (normalizeGoals(p)) changed = true;
  return changed;
}

/** Create a hypothesis if no non-retired one has the same normalized statement. */
function addHypothesis(p, { statement, lens = null, confidence = "low", origin = "consolidate", evidenceNote = null, sessionId = null }) {
  if (!statement || !String(statement).trim()) return null;
  const norm = normStatement(statement);
  if (p.hypotheses.some((h) => h.status !== "retired" && normStatement(h.statement) === norm)) return null;
  const at = stamp().id;
  const h = {
    id: newId("hyp", p.hypotheses.map((x) => x.id)),
    statement: String(statement).trim(),
    lens: typeof lens === "string" && lens ? lens : null,
    confidence: ["low", "medium", "high"].includes(confidence) ? confidence : "low",
    status: "forming",
    evidence: evidenceNote ? [{ at, sessionId, note: String(evidenceNote), kind: "for" }] : [],
    revisions: [],
    origin,
    createdAt: at,
    updatedAt: at,
    statusChangedAt: at,
  };
  p.hypotheses.push(h);
  return h;
}

function loadProfile() {
  let p, existed = true;
  try {
    p = { ...defaultProfile(), ...JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8")) };
  } catch {
    p = defaultProfile();
    existed = false;
  }
  // Persist a migration right away: it mints ids (hyp-…/goal-…) that other
  // components will reference across calls, so they must survive this load.
  if (migrateProfile(p) && existed) saveProfile(p);
  return p;
}

function saveProfile(p) {
  ensureDirs();
  p.updatedAt = stamp().id;
  if (!p.createdAt) p.createdAt = p.updatedAt;
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2) + "\n");
  return p;
}

/** Seed the profile from onboarding intake / settings edits (called when config is saved). */
function seedProfileFromOnboarding(user = {}) {
  const p = loadProfile();
  p.name = user.name || p.name;
  p.onboarding = {
    brings: user.brings || (p.onboarding && p.onboarding.brings) || "",
    goals: Array.isArray(user.goals) ? user.goals : (p.onboarding && p.onboarding.goals) || [],
    tone: user.tone || (p.onboarding && p.onboarding.tone) || "balanced",
    struggles: user.struggles || (p.onboarding && p.onboarding.struggles) || "",
  };
  return saveProfile(p);
}

/** Merge a list of {name, relationship, notes} into the profile's people map (dedupe by name). */
function mergePeople(p, incoming) {
  if (!Array.isArray(incoming)) return;
  p.people = p.people || [];
  for (const person of incoming) {
    if (!person || !person.name) continue;
    const existing = p.people.find((x) => x.name.toLowerCase() === String(person.name).toLowerCase());
    if (existing) {
      if (person.relationship) existing.relationship = person.relationship;
      if (person.notes) existing.notes = person.notes;
    } else {
      p.people.push({ name: person.name, relationship: person.relationship || "", notes: person.notes || "" });
    }
  }
}

/**
 * Fold a structured onboarding extraction (from the conversational intake) into
 * the profile's real dimensions. Only sets fields that were actually captured.
 */
function seedFromOnboardingExtraction(data = {}) {
  const p = loadProfile();
  if (data.lifeContext) p.lifeContext = data.lifeContext;
  if (data.relationalContext) p.relationalContext = data.relationalContext;
  if (data.emotionalStyle) p.emotionalStyle = data.emotionalStyle;
  if (data.readiness) p.readiness = data.readiness;
  pushUnique(p.presentingConcerns, data.presentingConcerns);
  for (const s of data.suspectedPatterns || []) addHypothesis(p, { statement: s, origin: "onboarding" });
  pushUnique(p.values, data.values);
  mergeGoals(p, data.goals);
  pushUnique(p.history, data.history);
  pushUnique(p.whatHelps, data.whatHelps);
  mergePeople(p, data.people);
  if (data.tone) { p.onboarding = p.onboarding || {}; p.onboarding.tone = data.tone; }
  if (Array.isArray(data.goals) && data.goals.length) {
    p.onboarding = p.onboarding || {};
    p.onboarding.goals = [...new Set([...(p.onboarding.goals || []), ...data.goals])];
  }
  return saveProfile(p);
}

/**
 * Direct profile additions from the UI's fill-in-your-picture exercises:
 * structured people entries and plain goal lines. Same merge rules as
 * consolidation (dedupe by name / normalized text).
 */
function addDirect({ people, goals } = {}) {
  const p = loadProfile();
  if (Array.isArray(people)) {
    mergePeople(p, people.filter((x) => x && x.name).map((x) => ({
      name: String(x.name),
      relationship: String(x.relationship || ""),
      notes: [String(x.notes || ""), x.workingOn ? "(a relationship they're working on)" : ""].filter(Boolean).join(" "),
    })));
  }
  if (Array.isArray(goals)) mergeGoals(p, goals.map((g) => String(g || "").trim()).filter(Boolean));
  saveProfile(p);
  return { ok: true, people: p.people.length, goals: p.goals.length };
}

/** Save the pre-generated opener for next session (called at session end). */
function setNextOpener(opener) {
  const p = loadProfile();
  p.nextOpener = opener && opener.blurb ? { blurb: opener.blurb, options: Array.isArray(opener.options) ? opener.options.slice(0, 3) : [] } : null;
  return saveProfile(p);
}

// --- Graph -----------------------------------------------------------------

function defaultGraph() {
  return { sessions: [], skills: {} };
}

function loadGraph() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));
    g.sessions = g.sessions || [];
    g.skills = g.skills || {};
    return g;
  } catch {
    return defaultGraph();
  }
}

function saveGraph(g) {
  ensureDirs();
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(g, null, 2) + "\n");
  return g;
}

// --- Session record markdown ----------------------------------------------

function renderSessionMd(node) {
  const skillLinks = (node.skills || []).map((s) => `[[${s}]]`).join(", ") || "—";
  const relLinks = (node.relatedSessions || []).map((s) => `[[${s}]]`).join(", ") || "—";
  const insights = (node.insights || []).map((i) => `- ${i}`).join("\n") || "- (none recorded)";
  return [
    `# ${node.date} — ${node.title}`,
    ``,
    ...(node.mode === "explore" ? [`- **Type:** explore session`] : []),
    `- **Skills:** ${skillLinks}`,
    `- **Related sessions:** ${relLinks}`,
    `- **Presenting concern:** ${node.presentingConcern || "—"}`,
    ``,
    `## Summary`,
    node.summary || "—",
    ``,
    `## Key insights`,
    insights,
    ``,
  ].join("\n");
}

// --- Write path: consolidate a finished session ----------------------------

/**
 * Append a finished session to the network.
 * input: { title, summary, presentingConcern, skills:[names], insights:[], profileUpdates:{} }
 * Returns the created node.
 */
function appendSession(input, when = new Date()) {
  ensureDirs();
  const { id: baseId, date } = stamp(when);
  const skills = [...new Set((input.skills || []).filter(Boolean))];

  const graph = loadGraph();

  // Guarantee a unique id even if two sessions end in the same second.
  const existing = new Set(graph.sessions.map((s) => s.id));
  let id = baseId;
  for (let n = 2; existing.has(id); n++) id = `${baseId}-${n}`;

  // relatedSessions = prior sessions sharing at least one skill (most recent first).
  const related = graph.sessions
    .filter((s) => s.skills.some((sk) => skills.includes(sk)))
    .map((s) => s.id);

  const node = {
    id,
    date,
    title: input.title || "Untitled session",
    summary: input.summary || "",
    presentingConcern: input.presentingConcern || "",
    mode: input.mode === "explore" ? "explore" : "talk",
    skills,
    relatedSessions: related.slice(0, 8),
    insights: Array.isArray(input.insights) ? input.insights : [],
    path: path.join("sessions", `${id}.md`),
  };

  // Reciprocal edges: add this session to each related prior session too.
  for (const s of graph.sessions) {
    if (related.includes(s.id) && !s.relatedSessions.includes(id)) {
      s.relatedSessions.unshift(id);
      s.relatedSessions = s.relatedSessions.slice(0, 8);
    }
  }

  graph.sessions.push(node);

  // Reverse index: skill -> [sessionIds]
  for (const sk of skills) {
    graph.skills[sk] = graph.skills[sk] || { sessions: [] };
    graph.skills[sk].sessions.push(id);
  }

  saveGraph(graph);
  fs.writeFileSync(path.join(MEM_DIR, node.path), renderSessionMd(node));

  // Merge into the global profile.
  mergeProfile(input, skills);

  return node;
}

function pushUnique(arr, items) {
  for (const it of items || []) {
    if (it && !arr.includes(it)) arr.push(it);
  }
  return arr;
}

/** Fold goal strings (from consolidation/onboarding) into structured goals, dedup by text. */
function mergeGoals(p, incoming) {
  if (!Array.isArray(incoming)) return;
  normalizeGoals(p);
  for (const g of incoming) {
    const text = typeof g === "string" ? g : (g && g.text) || "";
    if (!text) continue;
    const norm = normStatement(text);
    if (p.goals.some((x) => normStatement(x.text) === norm)) continue;
    const at = stamp().id;
    p.goals.push({ id: newId("goal", p.goals.map((x) => x.id)), text, status: "active", progress: [], createdAt: at, updatedAt: at });
  }
}

function mergeProfile(input, skills) {
  const p = loadProfile();
  const u = input.profileUpdates || {};
  if (u.lifeContext) p.lifeContext = u.lifeContext;
  if (u.relationalContext) p.relationalContext = u.relationalContext;
  if (u.emotionalStyle) p.emotionalStyle = u.emotionalStyle;
  if (u.readiness) p.readiness = u.readiness;
  // Legacy field from stale consolidate outputs: fold into the hypothesis model.
  for (const s of u.suspectedPatterns || []) addHypothesis(p, { statement: s, origin: "consolidate" });
  pushUnique(p.childhoodSignals, u.childhoodSignals);
  pushUnique(p.redFlags, u.redFlags);
  pushUnique(p.values, u.values);
  mergeGoals(p, u.goals);
  pushUnique(p.history, u.history);
  pushUnique(p.whatHelps, u.whatHelps);
  mergePeople(p, u.people);
  if (input.presentingConcern) pushUnique(p.presentingConcerns, [input.presentingConcern]);
  for (const sk of skills) p.skillsVisited[sk] = (p.skillsVisited[sk] || 0) + 1;
  saveProfile(p);
}

// --- Hypotheses, assignments, goal progress (applied at consolidation) --------

const HYP_STATUSES = ["forming", "testing", "supported", "revised", "retired"];
const ASSIGNMENT_LAPSE_DAYS = 21;

function daysSince(id, now = new Date()) {
  const m = String(id || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const then = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - then) / 86400000);
}

/**
 * Fold consolidate output into the hypothesis model.
 * updates: { new:[{statement,lens,confidence,evidenceNote}],
 *            evidence:[{id,note,kind}], statusChanges:[{id,status,why}],
 *            revisions:[{id,newStatement,why}] }
 */
function applyHypothesisUpdates(updates, sessionId) {
  if (!updates || typeof updates !== "object") return;
  const p = loadProfile();
  const at = stamp().id;
  const byId = (id) => p.hypotheses.find((h) => h.id === id);

  for (const n of Array.isArray(updates.new) ? updates.new.slice(0, 3) : []) {
    try { addHypothesis(p, { ...n, origin: n.origin || "consolidate", sessionId }); } catch {}
  }
  for (const ev of Array.isArray(updates.evidence) ? updates.evidence.slice(0, 6) : []) {
    try {
      const h = ev && byId(ev.id);
      if (!h || !ev.note) continue;
      h.evidence.push({ at, sessionId, note: String(ev.note), kind: ev.kind === "against" ? "against" : "for" });
      h.updatedAt = at;
      if (h.status === "forming") { h.status = "testing"; h.statusChangedAt = at; }
    } catch {}
  }
  for (const rv of Array.isArray(updates.revisions) ? updates.revisions.slice(0, 3) : []) {
    try {
      const h = rv && byId(rv.id);
      if (!h || !rv.newStatement) continue;
      h.revisions.push({ at, from: h.statement, why: String(rv.why || "") });
      h.statement = String(rv.newStatement).trim();
      h.status = "revised";
      h.updatedAt = at;
      h.statusChangedAt = at;
    } catch {}
  }
  for (const sc of Array.isArray(updates.statusChanges) ? updates.statusChanges.slice(0, 4) : []) {
    try {
      const h = sc && byId(sc.id);
      if (!h || !HYP_STATUSES.includes(sc.status)) continue;
      if (h.status !== sc.status) {
        h.status = sc.status;
        h.statusChangedAt = at;
        h.updatedAt = at;
        if (sc.status === "retired" && sc.why) h.evidence.push({ at, sessionId, note: String(sc.why), kind: "against" });
      }
      if (["low", "medium", "high"].includes(sc.confidence)) h.confidence = sc.confidence;
    } catch {}
  }
  saveProfile(p);
}

/**
 * The person's direct feedback from the Journey view. A vote is honest
 * evidence: up = "this fits" (counts for; nudges forming → testing),
 * down = "this doesn't fit" (counts against; a second down-vote sets the
 * hypothesis aside — retired, never deleted).
 */
function voteHypothesis(id, vote) {
  const p = loadProfile();
  const h = p.hypotheses.find((x) => x.id === id);
  if (!h) return null;
  const at = stamp().id;
  h.votes = h.votes || { up: 0, down: 0 };
  if (vote === "up") {
    h.votes.up++;
    h.evidence.push({ at, sessionId: null, note: "They marked this as fitting (from the Journey view).", kind: "for" });
    if (h.status === "forming") { h.status = "testing"; h.statusChangedAt = at; }
  } else if (vote === "down") {
    h.votes.down++;
    h.evidence.push({ at, sessionId: null, note: "They marked this as not fitting (from the Journey view).", kind: "against" });
    if (h.votes.down >= 2 && h.status !== "retired") { h.status = "retired"; h.statusChangedAt = at; }
  } else {
    return null;
  }
  h.updatedAt = at;
  saveProfile(p);
  return h;
}

/**
 * Fold consolidate output into assignments.
 * updates: { reported:[{id,findings}], dropped:[{id,why}],
 *            new:[{text,whatToNotice,linkedHypothesisId}] }
 */
function applyAssignmentUpdates(updates, sessionId) {
  if (!updates || typeof updates !== "object") return;
  const p = loadProfile();
  const at = stamp().id;
  const byId = (id) => p.assignments.find((a) => a.id === id);

  for (const r of Array.isArray(updates.reported) ? updates.reported.slice(0, 3) : []) {
    try {
      const a = r && byId(r.id);
      if (!a) continue;
      a.status = "reported";
      a.report = { at, sessionId, findings: String(r.findings || "") };
    } catch {}
  }
  for (const d of Array.isArray(updates.dropped) ? updates.dropped.slice(0, 3) : []) {
    try { const a = d && byId(d.id); if (a) a.status = "dropped"; } catch {}
  }
  for (const n of Array.isArray(updates.new) ? updates.new.slice(0, 1) : []) {
    try {
      if (!n || !n.text) continue;
      const linked = typeof n.linkedHypothesisId === "string" && p.hypotheses.some((h) => h.id === n.linkedHypothesisId)
        ? n.linkedHypothesisId : null;
      p.assignments.push({
        id: newId("asg", p.assignments.map((a) => a.id)),
        text: String(n.text),
        whatToNotice: String(n.whatToNotice || n.text),
        givenAt: at,
        givenInSessionId: sessionId || null,
        linkedHypothesisId: linked,
        status: "open",
        nudgedAt: null,
        report: null,
      });
    } catch {}
  }
  saveProfile(p);
}

/**
 * Fold consolidate goalProgress into structured goals.
 * updates: [{ goalId | goalText, movement: forward|backward|holding, note, status? }]
 * Status changes only when consolidation explicitly says so — silence never stalls a goal.
 */
function applyGoalProgress(updates) {
  if (!Array.isArray(updates) || !updates.length) return;
  const p = loadProfile();
  const at = stamp().id;
  for (const u of updates.slice(0, 3)) {
    try {
      if (!u) continue;
      let g = u.goalId ? p.goals.find((x) => x.id === u.goalId) : null;
      if (!g && u.goalText) {
        const norm = normStatement(u.goalText);
        g = p.goals.find((x) => normStatement(x.text) === norm)
          || p.goals.find((x) => normStatement(x.text).includes(norm) || norm.includes(normStatement(x.text)));
      }
      if (!g) continue;
      const movement = ["forward", "backward", "holding"].includes(u.movement) ? u.movement : "holding";
      g.progress.push({ at, movement, note: String(u.note || "") });
      if (["active", "progressing", "stalled", "achieved"].includes(u.status)) g.status = u.status;
      g.updatedAt = at;
    } catch {}
  }
  saveProfile(p);
}

// --- Hypothesis / assignment read paths ----------------------------------------

function getHypotheses() { return loadProfile().hypotheses; }
function getAssignments() { return loadProfile().assignments; }
function openAssignments() { return loadProfile().assignments.filter((a) => a.status === "open"); }

const HYP_ORDER = { testing: 0, supported: 1, revised: 2, forming: 3 };

/**
 * Render the working model for a prompt.
 * mode "talk"     → compact, statements only (token-light, every turn).
 * mode "explore" / "consolidate" → full, with ids and recent evidence.
 * Capped at 8 hypotheses × 3 evidence lines.
 */
function hypothesesContext({ mode = "talk" } = {}) {
  const hyps = loadProfile().hypotheses
    .filter((h) => h.status !== "retired")
    .sort((a, b) => (HYP_ORDER[a.status] ?? 9) - (HYP_ORDER[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 8);
  if (!hyps.length) return "";

  if (mode === "talk") {
    return hyps.map((h) => `- (${h.status}) ${h.statement}`).join("\n");
  }
  return hyps.map((h) => {
    const head = `- [${h.id}] (${h.status} · ${h.confidence} confidence${h.lens ? ` · lens: ${h.lens}` : ""}) "${h.statement}"`;
    const ev = h.evidence.slice(-3).map((e) => `    ${e.kind === "against" ? "against" : "for"}: ${e.note} (${String(e.at).slice(0, 10)})`);
    const rev = h.revisions.length ? [`    (previously worded: "${h.revisions[h.revisions.length - 1].from}")`] : [];
    return [head, ...ev, ...rev].join("\n");
  }).join("\n");
}

/** Open noticing assignments, with age; lapsed ones get a gentle one-time follow-up note. */
function assignmentsContext(now = new Date()) {
  const open = openAssignments();
  if (!open.length) return "";
  return open.map((a) => {
    const age = daysSince(a.givenAt, now);
    const lapsed = age !== null && age > ASSIGNMENT_LAPSE_DAYS;
    return `- [${a.id}] given ${age === null ? "recently" : age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`}: "${a.text}"${a.linkedHypothesisId ? ` (linked to ${a.linkedHypothesisId})` : ""}${lapsed ? "\n    (it's been a while — if it fits, ask ONCE, gently, and offer to reshape or drop it; no guilt)" : ""}`;
  }).join("\n");
}

// --- Read path: context injection ------------------------------------------

/** Compact profile summary for the respond prompt. */
function profileContext(profile = loadProfile()) {
  const p = profile;
  const lines = [];
  if (p.name) lines.push(`Name: ${p.name}`);
  if (p.lifeContext) lines.push(`Life context: ${p.lifeContext}`);
  // Note: tone/delivery preferences are injected separately as the TONE CALIBRATION block.
  if (p.values.length) lines.push(`Values that matter to them: ${p.values.join("; ")}`);
  if (p.goals.length) {
    const goalLine = p.goals.map((g) => {
      const last = g.progress && g.progress.length ? g.progress[g.progress.length - 1] : null;
      const bits = [g.status !== "active" ? g.status : "", last ? `last movement ${String(last.at).slice(0, 10)}` : ""].filter(Boolean);
      return `${g.text}${bits.length ? ` (${bits.join("; ")})` : ""}`;
    }).join("; ");
    lines.push(`What they want / goals: ${goalLine}`);
  }
  if (p.people && p.people.length) {
    lines.push(`Key people:\n${p.people.map((x) => `  - ${x.name}${x.relationship ? ` (${x.relationship})` : ""}${x.notes ? `: ${x.notes}` : ""}`).join("\n")}`);
  }
  if (p.relationalContext) lines.push(`Relational context: ${p.relationalContext}`);
  if (p.emotionalStyle) lines.push(`Emotional style: ${p.emotionalStyle}`);
  if (p.readiness) lines.push(`Readiness: ${p.readiness}`);
  if (p.history.length) lines.push(`Turning points: ${p.history.join("; ")}`);
  if (p.whatHelps.length) lines.push(`What has helped before: ${p.whatHelps.join("; ")}`);
  if (p.presentingConcerns.length) lines.push(`Recurring concerns: ${p.presentingConcerns.join("; ")}`);
  const activeHyps = p.hypotheses.filter((h) => h.status === "testing" || h.status === "supported");
  if (activeHyps.length) lines.push(`Things we're noticing together (hold lightly — test, don't confirm): ${activeHyps.slice(0, 5).map((h) => `${h.statement} (${h.status})`).join("; ")}`);
  const openAsgCount = p.assignments.filter((a) => a.status === "open").length;
  if (openAsgCount) lines.push(`They're carrying ${openAsgCount} open noticing assignment${openAsgCount === 1 ? "" : "s"} (details in the assignments block, if present).`);
  const visited = Object.entries(p.skillsVisited).sort((a, b) => b[1] - a[1]);
  if (visited.length) lines.push(`Frameworks touched before: ${visited.map(([k, v]) => `${k} (${v}x)`).join(", ")}`);
  if (p.redFlags.length) lines.push(`Flags on record: ${p.redFlags.join("; ")}`);

  // Curiosity agenda: blank AND thin dimensions, so curiosity never goes silent.
  const gaps = [];
  if (p.values.length < 2) gaps.push("what they value / want out of life");
  if (!(p.people && p.people.length)) gaps.push("the important people in their life");
  if (!p.relationalContext || p.relationalContext.length < 40) gaps.push("their relational world");
  if (!p.emotionalStyle || p.emotionalStyle.length < 40) gaps.push("how they tend to handle feelings");
  if (!p.readiness) gaps.push("what they need right now");
  if (!p.history.length) gaps.push("the turning points that shaped them");
  if (!p.whatHelps.length) gaps.push("what has actually helped them before");
  const forming = p.hypotheses.filter((h) => h.status === "forming");
  if (forming.length) gaps.push(`guesses not yet explored with them (${forming.slice(0, 2).map((h) => `"${h.statement}"`).join("; ")})`);
  if (gaps.length) lines.push(`(still learning: ${gaps.slice(0, 4).join(", ")})`);

  return lines.length ? lines.join("\n") : "(no profile yet — this may be an early session; stay curious and warm)";
}

/**
 * 1-hop referential network for an active skill: recent prior sessions that
 * used it, each with its own OTHER skill tags (the cross-skill links the agent
 * can choose to follow). Returns "" if there is no prior history.
 */
function skillHistoryContext(skillName, { excludeId = null, limit = 4 } = {}) {
  const graph = loadGraph();
  const ids = (graph.skills[skillName]?.sessions || []).filter((id) => id !== excludeId);
  if (!ids.length) return "";
  const byId = new Map(graph.sessions.map((s) => [s.id, s]));
  const picked = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .reverse() // most recent first
    .slice(0, limit);
  if (!picked.length) return "";
  const lines = picked.map((s) => {
    const others = (s.skills || []).filter((x) => x !== skillName);
    const tags = others.length ? ` [also touched: ${others.join(", ")}]` : "";
    return `- (${s.id}) ${s.date} — "${s.title}": ${s.summary}${tags}`;
  });
  return lines.join("\n");
}

/** Full markdown of a past session — for the on-demand deeper hop ([[recall]]). */
function recallSession(id) {
  const graph = loadGraph();
  const node = graph.sessions.find((s) => s.id === id);
  if (!node) return null;
  try {
    return { node, markdown: fs.readFileSync(path.join(MEM_DIR, node.path), "utf8") };
  } catch {
    return { node, markdown: renderSessionMd(node) };
  }
}

// --- Views + management (for the UI) ---------------------------------------

function listSessions() {
  return loadGraph().sessions.slice().sort((a, b) => b.id.localeCompare(a.id));
}

function memoryView() {
  const graph = loadGraph();
  return {
    profile: loadProfile(),
    sessions: graph.sessions.slice().sort((a, b) => b.id.localeCompare(a.id)),
    skills: graph.skills,
  };
}

function deleteSession(id) {
  const graph = loadGraph();
  const node = graph.sessions.find((s) => s.id === id);
  graph.sessions = graph.sessions.filter((s) => s.id !== id);
  for (const s of graph.sessions) {
    s.relatedSessions = (s.relatedSessions || []).filter((r) => r !== id);
  }
  for (const sk of Object.keys(graph.skills)) {
    graph.skills[sk].sessions = graph.skills[sk].sessions.filter((sid) => sid !== id);
    if (!graph.skills[sk].sessions.length) delete graph.skills[sk];
  }
  saveGraph(graph);
  if (node) {
    try { fs.unlinkSync(path.join(MEM_DIR, node.path)); } catch {}
  }
  return { ok: true };
}

function deleteAll() {
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) fs.unlinkSync(path.join(SESSIONS_DIR, f));
  } catch {}
  saveGraph(defaultGraph());
  // A full wipe keeps NOTHING — carrying the old name/onboarding forward is how
  // one person's goals used to leak into the next person's profile.
  saveProfile(defaultProfile());
  return { ok: true };
}

/** Anything learned on record? (Used to decide whether onboarding must archive first.) */
function hasLearnedData() {
  const p = loadProfile();
  const g = loadGraph();
  return !!(
    g.sessions.length || p.hypotheses.length || p.goals.length || p.assignments.length ||
    p.lifeContext || (p.people && p.people.length) || p.presentingConcerns.length
  );
}

/**
 * Move the entire memory store into memory/archive-<stamp>/ so a NEW person can
 * onboard without inheriting the previous person's patterns, goals, or sessions.
 * Nothing is deleted — restoring is moving the files back.
 */
function archiveAll() {
  ensureDirs();
  const dir = path.join(MEM_DIR, `archive-${stamp().id}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["profile.json", "graph.json", "current.json", "experiments.json", "timeline.json", "briefs.json"]) {
    try { fs.renameSync(path.join(MEM_DIR, f), path.join(dir, f)); } catch {}
  }
  try { fs.renameSync(SESSIONS_DIR, path.join(dir, "sessions")); } catch {}
  ensureDirs(); // recreate the empty sessions/ dir
  return dir;
}

module.exports = {
  ROOT,
  MEM_DIR,
  ensureDirs,
  stamp,
  newId,
  loadProfile,
  saveProfile,
  seedProfileFromOnboarding,
  seedFromOnboardingExtraction,
  addDirect,
  setNextOpener,
  loadGraph,
  saveGraph,
  appendSession,
  profileContext,
  skillHistoryContext,
  recallSession,
  listSessions,
  memoryView,
  deleteSession,
  deleteAll,
  hasLearnedData,
  archiveAll,
  // Understanding engine
  applyHypothesisUpdates,
  applyAssignmentUpdates,
  applyGoalProgress,
  voteHypothesis,
  hypothesesContext,
  assignmentsContext,
  getHypotheses,
  getAssignments,
  openAssignments,
  ASSIGNMENT_LAPSE_DAYS,
};
