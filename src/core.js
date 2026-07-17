/*
 * Heidi Priebe Agent — Engine (src/core.js).
 *
 * Surface-agnostic. One chat turn = route (plan) → assemble → respond. The router
 * makes ALL the machinery decisions (skill, reference, recall, consult, close) so
 * the respond step emits pure prose. Session end = consolidate into memory and
 * pre-generate the next opener.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const provider = require("./provider");
const skills = require("./skills");
const memory = require("./memory");
const journey = require("./journey");
const brief = require("./brief");
const timeaware = require("./timeaware");
const safety = require("./safety");
const tracer = require("./trace");
const T = require("./templates");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const CURRENT_PATH = path.join(memory.MEM_DIR, "current.json");

const MAX_HISTORY_MSGS = 24;
const ROUTE_TAIL_MSGS = 6;

// ─── Config ────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return null; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

// ─── Current session (persisted so a restart doesn't lose it) ────────────────

function newSession(mode = "talk") {
  return { id: memory.stamp().id, startedAt: memory.stamp().id, mode, messages: [], skillsUsed: [], activeSkill: null };
}
function loadCurrent() {
  try {
    const s = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
    s.messages = s.messages || [];
    s.skillsUsed = s.skillsUsed || [];
    s.mode = s.mode === "explore" ? "explore" : "talk";
    return s;
  } catch { return null; }
}
function saveCurrent(s) {
  memory.ensureDirs();
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(s, null, 2) + "\n");
  return s;
}
function clearCurrent() { try { fs.unlinkSync(CURRENT_PATH); } catch {} }
function ensureSession() { return loadCurrent() || saveCurrent(newSession()); }

/**
 * Switch the current session's mode (deliberate explore start, or accepting a
 * mid-chat proposal — the conversion keeps context, no session restart). Marks
 * exploreSuggested so the router never re-proposes in the same session.
 */
function setSessionMode(mode) {
  const m = mode === "explore" ? "explore" : "talk";
  const session = loadCurrent() || newSession(m);
  session.mode = m;
  if (m === "explore") session.exploreSuggested = true;
  saveCurrent(session);
  return session;
}

/** The shared TIME CONTEXT block (server-computed; injectable now for tests). */
function buildTimeBlock(mode, now = new Date()) {
  try {
    return timeaware.timeContext({
      now,
      sessions: memory.listSessions(),
      events: journey.loadTimeline().events,
      experiments: journey.loadExperiments().experiments,
      assignments: memory.getAssignments(),
      goals: memory.loadProfile().goals,
      mode,
    });
  } catch (e) { console.error(`[timeaware] ${e.message}`); return ""; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the first balanced {...} JSON object from text; null on failure. */
function parseJsonLoose(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function renderTranscript(messages, limit = MAX_HISTORY_MSGS) {
  return messages
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "Person" : "Companion"}: ${m.content}`)
    .join("\n\n");
}

function agentCoreRoutingTable() {
  const body = skills.readAgentCore();
  const m = body.match(/###?\s*Routing table[\s\S]*?(?=\n##\s|\n---|\s*$)/i);
  return m ? m[0].trim() : body;
}

/** Timed provider call that trace-logs the full prompt, output, model, and latency. */
async function timedComplete(label, prompt, opts, extra) {
  const start = Date.now();
  let output = "", error = null;
  const usage = {}; // adapters may fill { model, tokens, costUsd } via this sink
  try {
    output = await provider.complete(prompt, { ...opts, kind: label, usageSink: usage });
    return output;
  } catch (e) {
    error = e.message;
    throw e;
  } finally {
    tracer.log({
      label,
      model: usage.model || (opts && opts.provider) || "claude-p",
      ms: Date.now() - start,
      ...(usage.tokens ? { usage: usage.tokens, costUsd: usage.costUsd } : {}),
      ...(extra || {}),
      prompt,
      output,
      error,
    });
  }
}

/**
 * Strip a leaked "planning" preamble — leading sentences that talk ABOUT the
 * person (third person) or narrate the model's own intent ("I should…", "meet
 * him there") before it actually speaks TO them. Conservative: only strips
 * leading planning sentences, and never strips everything.
 */
function stripPlanning(text) {
  const planningCue = /\b(I should|I'll\b|I will\b|I need to|I want to|I'm going to|let me\b|meet (?:him|her|them) (?:there|where)|not push|honou?r (?:it|that|his|her|their|the))\b/i;
  const thirdPersonStart = /^(he|she|they|his|her|their|him|the client|the person|this person)\b/i;
  const sentences = text.split(/(?<=[.!?])\s+/);
  let i = 0;
  while (i < sentences.length) {
    const s = sentences[i].trim();
    const addressesYou = /\byou(r|'|\b)/i.test(s);
    const isPlanning = !addressesYou && (thirdPersonStart.test(s) || planningCue.test(s));
    if (isPlanning) i++; else break;
  }
  const kept = sentences.slice(i).join(" ").trim();
  return kept || text; // if that would strip everything, keep the original
}

/**
 * Backup for the plain-text rule: the UI renders replies as literal text, so
 * any markdown the model emits anyway is unwrapped here (bold/italic markers,
 * headings, bullets, code ticks) rather than shown as symbols.
 */
function stripMarkdown(text) {
  return String(text)
    .replace(/^```[^\n]*$/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=[\s.,!?;:)]|$)/g, "$1$2")
    .replace(/(^|\s)_([^_\n]+)_(?=[\s.,!?;:)]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "");
}

/** Trim accidental meta leakage from a reply. The prompt already forbids it; this is backup. */
function sanitizeReply(text) {
  if (!text) return "";
  let lines = String(text).trim().split(/\r?\n/);
  // Drop leading meta lines like "Thinking:", "Note:", "(analysis ...)".
  while (lines.length) {
    const l = lines[0].trim();
    if (/^(thinking|thought|note|analysis|internal|reasoning|routing|assistant|reply|plan)\s*:/i.test(l)) { lines.shift(); continue; }
    if (/^\((?:note|thinking|analysis)[^)]*\)$/i.test(l)) { lines.shift(); continue; }
    break;
  }
  let out = stripMarkdown(lines.join("\n"))
    .replace(/\[\[\s*(?:recall|consult)\s*:[^\]]*\]\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripPlanning(out);
}

/**
 * Whole-reply leak detector: the model narrated its plan instead of speaking.
 * True only when it never addresses the person ("you") AND talks about them in
 * the third person with intent language — a distinctive, low-false-positive shape.
 */
function looksLikePlanning(text) {
  if (!text) return false;
  if (/\byou(r|'|\b)/i.test(text)) return false; // it addresses them → fine
  const thirdPerson = /\b(he|she|they|him|her|their)\b/i.test(text);
  const intent = /\b(I should|I'll|I will|I need to|I want to|meet (?:him|her|them)|not push|honou?r (?:it|that|his|her|their))\b/i.test(text);
  return thirdPerson && intent;
}

// ─── Turn pipeline ─────────────────────────────────────────────────────────

async function route(cfg, session, userMessage) {
  const tailMsgs = [...session.messages, { role: "user", content: userMessage }];
  const sessionHistory = memory.listSessions().slice(0, 12).map((s) => `${s.id} — ${s.title}`).join("\n");
  const prompt = T.buildRoutePrompt({
    catalog: skills.routerCatalog(),
    routingTable: agentCoreRoutingTable(),
    transcriptTail: renderTranscript(tailMsgs, ROUTE_TAIL_MSGS),
    currentSkill: session.activeSkill,
    sessionHistory,
    mode: session.mode,
    suggestedExploreAlready: !!session.exploreSuggested,
    timeLine: buildTimeBlock("route"),
  });
  try {
    const raw = await timedComplete("route", prompt, { provider: cfg.provider, config: cfg });
    const parsed = parseJsonLoose(raw);
    if (parsed) return parsed;
  } catch (e) { console.error(`[route] ${e.message}`); }
  return { skill: "stay", reference: null, recall: null, consult: null, close: false, suggestExplore: false, reason: "router-fallback" };
}

function resolveActiveSkill(routed, session) {
  let name = routed.skill;
  if (name === "stay") name = session.activeSkill || null;
  else if (name === "none" || !name) name = null;
  else if (!skills.skillExists(name)) name = session.activeSkill || null;

  let reference = null;
  if (name && routed.reference && /^[\w.-]+\.md$/.test(routed.reference)) {
    const s = skills.loadManifest().skills.find((x) => x.dir === name || x.name === name);
    if (s && s.references.includes(routed.reference)) reference = routed.reference;
  }
  return { name, reference };
}

/** Build the recall/consult context block the router asked for (loaded before respond). */
function buildRecallBlock(routed, activeName) {
  const parts = [];
  let recalledSessionId = null;
  if (routed.recall) {
    const r = memory.recallSession(routed.recall);
    if (r) { parts.push(`A past session that may be relevant:\n\n${r.markdown}`); recalledSessionId = routed.recall; }
  }
  let consulted = null;
  if (routed.consult && routed.consult !== activeName && skills.skillExists(routed.consult)) {
    parts.push(`An additional lens that may help here:\n\n${skills.readSkillBody(routed.consult)}`);
    consulted = routed.consult;
  }
  return { block: parts.join("\n\n---\n\n") || null, recalledSessionId, consulted };
}

function assemble(session, userMessage, active, opts = {}) {
  const skillBody = active.name ? skills.readSkillBody(active.name) : null;
  const referenceBody = active.reference ? skills.readReference(active.name, active.reference) : null;
  const exploring = session.mode === "explore";
  return T.buildRespondPrompt({
    system: exploring ? T.EXPLORE_PREAMBLE : T.SYSTEM_PREAMBLE,
    safetyDirective: opts.safetyDirective || null,
    toneDirective: opts.toneDirective || null,
    agentCore: skills.readAgentCore(),
    activeSkillName: active.name,
    skillBody,
    referenceName: active.reference,
    referenceBody,
    profileBlock: memory.profileContext(),
    timeBlock: buildTimeBlock("respond"),
    understandingBlock: memory.hypothesesContext({ mode: exploring ? "explore" : "talk" }),
    assignmentsBlock: memory.assignmentsContext(),
    experimentsBlock: journey.experimentsContext(),
    skillHistoryBlock: active.name ? memory.skillHistoryContext(active.name, { excludeId: session.id }) : "",
    transcript: renderTranscript(session.messages),
    userMessage,
    recallBlock: opts.recallBlock || null,
  });
}

async function handleTurn(userMessage) {
  const cfg = loadConfig() || {};
  const session = ensureSession();
  const crisis = safety.crisisCheck(userMessage);

  let active = { name: null, reference: null };
  let recall = { block: null, recalledSessionId: null, consulted: null };
  let close = false;
  let suggestExplore = false;
  let routerReason = null;

  if (!crisis.flagged) {
    const routed = await route(cfg, session, userMessage);
    active = resolveActiveSkill(routed, session);
    recall = buildRecallBlock(routed, active.name);
    close = routed.close === true;
    routerReason = routed.reason || null;
    if (routed.suggestExplore === true && session.mode !== "explore" && !session.exploreSuggested) {
      suggestExplore = true;
      session.exploreSuggested = true;
    }
  }

  const opts = { recallBlock: recall.block, toneDirective: T.buildToneDirective(cfg.user || {}) };
  if (crisis.flagged) opts.safetyDirective = safety.SAFETY_DIRECTIVE;

  const respondPrompt = assemble(session, userMessage, active, opts);
  const raw = await timedComplete(session.mode === "explore" ? "explore-respond" : "respond", respondPrompt, { provider: cfg.provider, config: cfg }, {
    activeLens: active.name, reference: active.reference, recall: recall.recalledSessionId, consult: recall.consulted, crisis: crisis.flagged, mode: session.mode,
  });
  let reply = sanitizeReply(raw) || "I'm here. Tell me a little more about what's on your mind.";
  let leaked = false;
  if (looksLikePlanning(reply)) {
    leaked = true;
    reply = "I'm right here with you. Take whatever time you need — we don't have to force anything.";
  }

  const trace = {
    activeLens: active.name,
    routerReason,
    reference: active.reference,
    recalledSessionId: recall.recalledSessionId,
    consulted: recall.consulted,
    close,
    suggestExplore,
    mode: session.mode,
    safety: crisis.flagged,
  };
  tracer.log({ label: "turn", sessionId: session.id, userMessage, rawReply: raw, reply, leaked, ...trace });

  session.messages.push({ role: "user", content: userMessage });
  session.messages.push({ role: "assistant", content: reply, trace });
  if (active.name) {
    session.activeSkill = active.name;
    if (!session.skillsUsed.includes(active.name)) session.skillsUsed.push(active.name);
  }
  saveCurrent(session);

  return { reply, activeSkill: active.name, reference: active.reference, safety: crisis.flagged, close, suggestExplore, mode: session.mode, trace };
}

// ─── Session end / consolidate ───────────────────────────────────────────────

/** Compact "open items on record" block (by id) for the consolidate prompt. */
function buildOpenItemsBlock(now = new Date()) {
  const lines = [];
  try {
    const tl = journey.loadTimeline();
    for (const e of tl.events.filter((x) => x.status === "upcoming").slice(0, 4)) {
      const d = timeaware.dayDiff(e.date, now);
      lines.push(`- (${e.id}) event "${e.text}" — ${e.date}, ${d > 0 ? `passed ${timeaware.relPhrase(e.date, now)}` : timeaware.relPhrase(e.date, now)}`);
    }
    for (const x of journey.loadExperiments().experiments.filter((e) => e.status === "running" || e.status === "proposed").slice(0, 3)) {
      const day = x.startedAt ? (timeaware.dayDiff(x.startedAt, now) || 0) + 1 : null;
      lines.push(`- (${x.id}) experiment "${x.theReplacement}" instead of "${x.thePattern}" — ${x.status}${day ? `, day ${day}` : ""}${x.checkIns.length ? `, last check-in ${timeaware.relPhrase(x.checkIns[x.checkIns.length - 1].at, now)}` : ""}`);
    }
    for (const g of memory.loadProfile().goals.filter((g) => g.status !== "achieved").slice(0, 5)) {
      lines.push(`- (${g.id}) goal "${g.text}" — ${g.status}`);
    }
  } catch (e) { console.error(`[open-items] ${e.message}`); }
  return lines.join("\n");
}

async function endSession() {
  const session = loadCurrent();
  if (!session || !session.messages.length) { clearCurrent(); return { ended: false, reason: "empty" }; }
  const cfg = loadConfig() || {};
  const transcript = renderTranscript(session.messages, 1000);
  const now = new Date();

  let parsed = null;
  try {
    const raw = await timedComplete(
      "consolidate",
      T.buildConsolidatePrompt({
        transcript,
        skillsUsed: session.skillsUsed,
        profileBlock: memory.profileContext(),
        mode: session.mode,
        hypothesesBlock: memory.hypothesesContext({ mode: "consolidate" }),
        assignmentsBlock: memory.assignmentsContext(now),
        openItemsBlock: buildOpenItemsBlock(now),
        todayLine: timeaware.longNow(now),
        calendarBlock: timeaware.calendarTable(now),
      }),
      { provider: cfg.provider, config: cfg }
    );
    parsed = parseJsonLoose(raw);
  } catch (e) { console.error(`[consolidate] ${e.message}`); }

  if (!parsed) {
    const firstUser = session.messages.find((m) => m.role === "user");
    parsed = { title: "Session", summary: firstUser ? firstUser.content.slice(0, 160) : "(conversation)", presentingConcern: "", insights: [], profileUpdates: {} };
  }

  const node = memory.appendSession({ ...parsed, skills: session.skillsUsed, mode: session.mode });
  // Fold the understanding + journey loops. Each is defensive — malformed
  // fields are skipped item-by-item and never block the session save.
  try { if (parsed.hypothesisUpdates) memory.applyHypothesisUpdates(parsed.hypothesisUpdates, node.id); } catch (e) { console.error(`[hypotheses] ${e.message}`); }
  try { if (parsed.assignmentUpdates) memory.applyAssignmentUpdates(parsed.assignmentUpdates, node.id, { experiments: journey.loadExperiments().experiments }); } catch (e) { console.error(`[assignments] ${e.message}`); }
  try { if (parsed.goalProgress) memory.applyGoalProgress(parsed.goalProgress); } catch (e) { console.error(`[goals] ${e.message}`); }
  try { journey.applyConsolidation(parsed, node.id, now); } catch (e) { console.error(`[journey] ${e.message}`); }
  if (parsed.nextOpener) {
    memory.setNextOpener({
      blurb: stripMarkdown(parsed.nextOpener.blurb || "").trim(),
      options: Array.isArray(parsed.nextOpener.options) ? parsed.nextOpener.options.map((o) => stripMarkdown(o).trim()) : [],
    });
  }
  clearCurrent();
  return { ended: true, node };
}

// ─── Opener (pre-generated at consolidation; deterministic fallback otherwise) ─

function getOpener(cfg) {
  const style = (cfg && cfg.user && cfg.user.openerStyle) || "smart";
  const profile = memory.loadProfile();
  const name = profile.name || (cfg && cfg.user && cfg.user.name) || "";
  const sessions = memory.listSessions();

  // These ride along for every style: report-back chips for open homework
  // items, deterministic journey starters (passed event / experiment
  // check-in — at most one), and whether an explore session makes sense yet.
  const chipByType = {
    notice: { label: "Report back", message: (t) => `I want to report back on what I was noticing: "${t}"` },
    action: { label: "How it went", message: (t) => `I want to tell you how it went — the thing I said I'd try: "${t}"` },
    reflection: { label: "What came up", message: (t) => `I want to share what came up when I sat with: "${t}"` },
  };
  const reportBacks = memory.openAssignments().slice(0, 2).map((a) => {
    const chip = chipByType[a.type] || chipByType.notice;
    return {
      id: a.id,
      label: `${chip.label}: ${a.text.length > 44 ? a.text.slice(0, 44).trim() + "…" : a.text}`,
      message: chip.message(a.text),
    };
  });
  const starters = journey.openerCandidates();
  // Profile exercises: the depth onboarding deliberately skips (people, goals,
  // patterns) surfaces here as light invitations once the person is in the app.
  const exercises = [];
  if (!(profile.people && profile.people.length)) exercises.push({ kind: "people", label: "Add the people in your life" });
  if (!(profile.goals && profile.goals.length)) exercises.push({ kind: "goal", label: "Name something you're working toward" });
  const base = { style, reportBacks, starters, exercises: exercises.slice(0, 2), canExplore: sessions.length > 0 || !!profile.lifeContext };

  if (style === "open") {
    return { ...base, blurb: `Hi${name ? " " + name : ""}. What's on your mind?`, options: [] };
  }

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seen = new Set(starters.map((s) => norm(s.label)));
  const dedupe = (arr) => arr.filter((o) => {
    const n = norm(o);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  // Fresh, consolidation-generated opener — used for every style except "open".
  if (profile.nextOpener && profile.nextOpener.blurb) {
    let options = dedupe((profile.nextOpener.options || []).map((o) => String(o).trim()));
    if (!options.some((o) => /something new/i.test(o))) options.push("Something new today");
    return { ...base, blurb: profile.nextOpener.blurb, options: options.slice(0, 3) };
  }

  if (sessions.length) {
    const last = sessions[0];
    const candidates = [`Pick up on “${last.title}”`];
    const recent = (profile.presentingConcerns || []).slice(-1)[0];
    if (recent && norm(recent) !== norm(last.title)) {
      const short = recent.replace(/^["']|["']$/g, "");
      candidates.push(short.length > 48 ? short.slice(0, 48).trim() + "…" : short);
    }
    const options = dedupe(candidates);
    options.push("Something new today");
    return {
      ...base,
      blurb: `Hi${name ? " " + name : ""}. Last time we sat with “${last.title}.” We can pick that thread back up, or start somewhere new — whatever feels right.`,
      options: options.slice(0, 3),
    };
  }

  // First-ever session.
  return {
    ...base,
    blurb: `Hi${name ? " " + name : ""}. There's no agenda here — we can start wherever you like. What's been sitting with you lately?`,
    options: [],
  };
}

/**
 * First message of a deliberate explore session: a good question, generated
 * from the working model. Deterministic fallback if the call fails.
 */
async function getExploreOpener() {
  const cfg = loadConfig() || {};
  const recentSessions = memory.listSessions().slice(0, 3)
    .map((s) => `- ${s.id} — "${s.title}": ${s.summary}`).join("\n");
  try {
    const raw = await timedComplete(
      "explore-opener",
      T.buildExploreOpenerPrompt({
        profileBlock: memory.profileContext(),
        hypothesesBlock: memory.hypothesesContext({ mode: "explore" }),
        assignmentsBlock: memory.assignmentsContext(),
        recentSessions,
        timeBlock: buildTimeBlock("route"),
      }),
      { provider: cfg.provider, config: cfg }
    );
    const parsed = parseJsonLoose(raw);
    if (parsed && parsed.blurb) {
      return {
        mode: "explore",
        blurb: stripMarkdown(parsed.blurb).trim(),
        options: (Array.isArray(parsed.options) ? parsed.options.slice(0, 3) : []).map((o) => stripMarkdown(o).trim()),
      };
    }
  } catch (e) { console.error(`[explore-opener] ${e.message}`); }

  // Deterministic fallback: the newest hypothesis being tested, else the biggest gap.
  const testing = memory.getHypotheses().filter((h) => h.status === "testing" || h.status === "forming")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const blurb = testing
    ? `There's something I've been noticing that we haven't looked at head-on: "${testing.statement}." Want to look at it together and see if it actually fits? If something else feels more alive, we go there instead.`
    : `Let's get to know each other a bit better — no agenda, just curiosity. What's something about how you work that you've never quite been able to explain to yourself?`;
  return { mode: "explore", blurb, options: ["Let's look at it", "Somewhere else today"] };
}

/**
 * Deliberate explore start: switch the session to explore mode and, when it's
 * fresh, generate the opening question AND persist it as an assistant message —
 * the model must see its own question in the transcript when the person replies.
 */
async function startExploreSession() {
  const session = setSessionMode("explore");
  if (session.messages.length) return { mode: "explore", opener: null };
  const opener = await getExploreOpener();
  session.messages.push({ role: "assistant", content: opener.blurb });
  saveCurrent(session);
  return { mode: "explore", opener };
}

// ─── Onboarding (conversational sections + finish/extraction) ─────────────────

/** One warm follow-up within an onboarding section. Returns pure prose. */
async function onboardChat(title, messages, final) {
  const cfg = loadConfig() || {};
  const transcript = (messages || [])
    .map((m) => `${m.role === "user" ? "Person" : "Companion"}: ${m.content}`)
    .join("\n\n");
  const raw = await timedComplete(
    "onboard-followup",
    T.buildOnboardFollowupPrompt({ sectionTitle: title || "getting to know you", transcript, final: !!final }),
    { provider: cfg.provider, config: cfg },
    { title, final: !!final }
  );
  return sanitizeReply(raw) || (final ? "Thank you for sharing that." : "Tell me a bit more about that?");
}

/** Fold the whole onboarding into the profile. input: { mc, sections:[{id,title,messages}] }. */
async function onboardFinish(input = {}) {
  const cfg = loadConfig() || {};
  const mc = input.mc || {};

  // A finishing onboarding means a (possibly new) person. NEVER inherit the
  // previous memory — one person's patterns/goals must not leak into the next
  // profile. Existing learned data is archived (moved, not deleted), then the
  // fresh profile is seeded from this onboarding alone.
  let archivedTo = null;
  if (memory.hasLearnedData()) {
    archivedTo = memory.archiveAll();
    console.log(`[onboard] previous memory archived to ${archivedTo}`);
  }
  memory.seedProfileFromOnboarding({ name: (cfg.user && cfg.user.name) || "", tone: mc.tone });

  // Deterministic MC fields → profile / config (no LLM needed for these).
  // readiness is an ordered array (click order = priority); emotionalStyle is multi-select.
  const readinessArr = (Array.isArray(mc.readiness) ? mc.readiness : (mc.readiness ? [mc.readiness] : [])).filter(Boolean);
  const readiness = readinessArr.join(" > "); // preserves priority
  const esArr = (Array.isArray(mc.emotionalStyle) ? mc.emotionalStyle : (mc.emotionalStyle ? [mc.emotionalStyle] : [])).filter((x) => x && x !== "unsure");
  const emotionalStyleMC = esArr.join(", ");
  const topics = Array.isArray(mc.topics) ? mc.topics.filter((t) => t && t !== "Not sure yet") : [];

  // People added through the structured widget — typed by the person, so they
  // outrank anything the extraction infers about the same names.
  const widgetPeople = (Array.isArray(input.people) ? input.people : [])
    .filter((x) => x && x.name)
    .map((x) => ({
      name: String(x.name),
      relationship: String(x.relationship || ""),
      notes: [String(x.notes || ""), x.workingOn ? "(a relationship they're working on)" : ""].filter(Boolean).join(" "),
    }));

  const quizAnswers = Array.isArray(mc.quizAnswers) ? mc.quizAnswers.filter((x) => x && x.q && x.a) : [];
  const mcSummary = [
    quizAnswers.length ? `Check-in answers (single-tap; broad signals only, NOT the person's own words):\n${quizAnswers.map((x) => `  - ${x.q} → ${x.a}`).join("\n")}` : "",
    topics.length ? `Answers that stood out: ${topics.join("; ")}` : "",
    readinessArr.length ? `What they want, in priority order: ${readinessArr.join(" > ")}` : "",
    mc.tone ? `Preferred tone: ${mc.tone}` : "",
    esArr.length ? `Self-reported way(s) of handling feelings: ${esArr.join(", ")}` : "",
    widgetPeople.length ? `People they added: ${widgetPeople.map((p) => `${p.name}${p.relationship ? ` (${p.relationship})` : ""}${p.notes ? ` — ${p.notes}` : ""}`).join("; ")}` : "",
  ].filter(Boolean).join("\n");

  const transcripts = (input.sections || [])
    .map((s) => {
      const t = (s.messages || []).map((m) => `${m.role === "user" ? "Person" : "Companion"}: ${m.content}`).join("\n");
      return `## ${s.title}\n${t || "(skipped)"}`;
    })
    .join("\n\n");

  // LLM extraction over the conversational parts (best-effort).
  let extracted = {};
  const hasConvo = (input.sections || []).some((s) => (s.messages || []).some((m) => m.role === "user"));
  if (hasConvo || topics.length || widgetPeople.length) {
    try {
      const raw = await timedComplete(
        "onboard-extract",
        T.buildOnboardExtractionPrompt({ mcSummary: mcSummary || "(none)", transcripts: transcripts || "(none)" }),
        { provider: cfg.provider, config: cfg }
      );
      extracted = parseJsonLoose(raw) || {};
    } catch (e) { console.error(`[onboard-extract] ${e.message}`); }
  }

  // Merge deterministic MC over/into the extraction, then seed the profile.
  const data = {
    lifeContext: extracted.lifeContext || "",
    // Widget people last: mergePeople dedupes by name, and the person's own
    // typed entry should win over anything the model inferred.
    people: [...(Array.isArray(extracted.people) ? extracted.people : []), ...widgetPeople],
    values: extracted.values || [],
    goals: extracted.goals || [],
    history: extracted.history || [],
    whatHelps: extracted.whatHelps || [],
    relationalContext: extracted.relationalContext || "",
    emotionalStyle: extracted.emotionalStyle || emotionalStyleMC,
    readiness,
    presentingConcerns: extracted.presentingConcerns && extracted.presentingConcerns.length
      ? extracted.presentingConcerns
      : (topics.length ? [topics.join(", ")] : []),
    // Hard gate, independent of the prompt: a hypothesis needs the person's own
    // words. If they skipped the conversational sections, no pattern gets
    // minted from multiple-choice taps — ever.
    suspectedPatterns: hasConvo ? (extracted.suspectedPatterns || []) : [],
    tone: mc.tone || "",
  };
  memory.seedFromOnboardingExtraction(data);

  // The extraction also drafts the FIRST session's opener, so the person's
  // first Talk screen starts from what they just shared, not a generic line.
  if (extracted.firstOpener && extracted.firstOpener.blurb) {
    memory.setNextOpener({
      blurb: stripMarkdown(extracted.firstOpener.blurb).trim(),
      options: Array.isArray(extracted.firstOpener.options) ? extracted.firstOpener.options.map((o) => stripMarkdown(o).trim()) : [],
    });
  }

  // Wire the tone answer into the store the runtime actually reads
  // (buildToneDirective reads cfg.user.tone/toneDials, not the profile).
  if (mc.tone) {
    cfg.user = cfg.user || {};
    cfg.user.tone = mc.tone;
    cfg.user.toneDials = T.resolveDials({ tone: mc.tone });
    saveConfig(cfg);
  }
  return { ok: true, seeded: data, archived: !!archivedTo };
}

// ─── Therapist brief ─────────────────────────────────────────────────────────

/**
 * Compose the (already user-filtered) brief data and write its opening
 * narrative in one model call. The digest is built from the same filtered
 * object the document renders, so excluded items cannot reach the prose.
 */
async function generateBriefNarrative(selection = {}) {
  const cfg = loadConfig();
  const composed = brief.composeBrief(selection);
  if (!composed) throw new Error("invalid brief selection");
  const digest = brief.digestForNarrative(composed);
  const prompt = T.buildBriefNarrativePrompt({
    preset: composed.preset,
    clientName: composed.header.clientName,
    todayLine: timeaware.longNow(),
    windowLine: composed.header.windowLine ? composed.header.windowLine.toLowerCase() : "",
    digest: digest || "(nothing was shared — say so honestly in one short paragraph)",
  });
  const raw = await timedComplete("brief", prompt, { provider: cfg.provider, config: cfg });
  return stripMarkdown(String(raw)).trim();
}

// ─── Management ──────────────────────────────────────────────────────────────

function currentSessionView() {
  const s = loadCurrent();
  return s
    ? { active: true, id: s.id, mode: s.mode, turns: s.messages.filter((m) => m.role === "user").length, activeSkill: s.activeSkill, skillsUsed: s.skillsUsed, messages: s.messages }
    : { active: false, messages: [] };
}

module.exports = {
  ROOT,
  loadConfig,
  saveConfig,
  handleTurn,
  endSession,
  getOpener,
  getExploreOpener,
  startExploreSession,
  setSessionMode,
  onboardChat,
  onboardFinish,
  generateBriefNarrative,
  currentSessionView,
  clearCurrent,
  parseJsonLoose,
};
