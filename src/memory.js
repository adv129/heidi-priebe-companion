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
    goals: [], // what they want out of this / their life
    history: [], // key turning points they've shared
    whatHelps: [], // things that have helped / been tried
    relationalContext: "",
    emotionalStyle: "",
    readiness: "",
    presentingConcerns: [], // recurring themes across sessions
    suspectedPatterns: [],
    childhoodSignals: [],
    skillsVisited: {}, // skillName -> count
    redFlags: [],
    nextOpener: null, // { blurb, options:[] } pre-generated at last session end
    createdAt: null,
    updatedAt: null,
  };
}

function loadProfile() {
  try {
    return { ...defaultProfile(), ...JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8")) };
  } catch {
    return defaultProfile();
  }
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
  pushUnique(p.suspectedPatterns, data.suspectedPatterns);
  pushUnique(p.values, data.values);
  pushUnique(p.goals, data.goals);
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

function mergeProfile(input, skills) {
  const p = loadProfile();
  const u = input.profileUpdates || {};
  if (u.lifeContext) p.lifeContext = u.lifeContext;
  if (u.relationalContext) p.relationalContext = u.relationalContext;
  if (u.emotionalStyle) p.emotionalStyle = u.emotionalStyle;
  if (u.readiness) p.readiness = u.readiness;
  pushUnique(p.suspectedPatterns, u.suspectedPatterns);
  pushUnique(p.childhoodSignals, u.childhoodSignals);
  pushUnique(p.redFlags, u.redFlags);
  pushUnique(p.values, u.values);
  pushUnique(p.goals, u.goals);
  pushUnique(p.history, u.history);
  pushUnique(p.whatHelps, u.whatHelps);
  mergePeople(p, u.people);
  if (input.presentingConcern) pushUnique(p.presentingConcerns, [input.presentingConcern]);
  for (const sk of skills) p.skillsVisited[sk] = (p.skillsVisited[sk] || 0) + 1;
  saveProfile(p);
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
  if (p.goals.length) lines.push(`What they want / goals: ${p.goals.join("; ")}`);
  if (p.people && p.people.length) {
    lines.push(`Key people:\n${p.people.map((x) => `  - ${x.name}${x.relationship ? ` (${x.relationship})` : ""}${x.notes ? `: ${x.notes}` : ""}`).join("\n")}`);
  }
  if (p.relationalContext) lines.push(`Relational context: ${p.relationalContext}`);
  if (p.emotionalStyle) lines.push(`Emotional style: ${p.emotionalStyle}`);
  if (p.readiness) lines.push(`Readiness: ${p.readiness}`);
  if (p.history.length) lines.push(`Turning points: ${p.history.join("; ")}`);
  if (p.whatHelps.length) lines.push(`What has helped before: ${p.whatHelps.join("; ")}`);
  if (p.presentingConcerns.length) lines.push(`Recurring concerns: ${p.presentingConcerns.join("; ")}`);
  if (p.suspectedPatterns.length) lines.push(`Working hypotheses: ${p.suspectedPatterns.join("; ")}`);
  const visited = Object.entries(p.skillsVisited).sort((a, b) => b[1] - a[1]);
  if (visited.length) lines.push(`Frameworks touched before: ${visited.map(([k, v]) => `${k} (${v}x)`).join(", ")}`);
  if (p.redFlags.length) lines.push(`Flags on record: ${p.redFlags.join("; ")}`);

  // Curiosity agenda: what's still blank, so the model knows what to be curious about.
  const gaps = [];
  if (!p.values.length) gaps.push("what they value / want out of life");
  if (!(p.people && p.people.length)) gaps.push("the important people in their life");
  if (!p.relationalContext) gaps.push("their relational world");
  if (!p.emotionalStyle) gaps.push("how they tend to handle feelings");
  if (!p.readiness) gaps.push("what they need right now");
  if (gaps.length) lines.push(`(still learning: ${gaps.join(", ")})`);

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
  // Keep name + onboarding seed; clear learned/derived fields.
  const p = loadProfile();
  const fresh = { ...defaultProfile(), name: p.name, onboarding: p.onboarding, createdAt: p.createdAt };
  saveProfile(fresh);
  return { ok: true };
}

module.exports = {
  ROOT,
  MEM_DIR,
  ensureDirs,
  stamp,
  loadProfile,
  saveProfile,
  seedProfileFromOnboarding,
  seedFromOnboardingExtraction,
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
};
