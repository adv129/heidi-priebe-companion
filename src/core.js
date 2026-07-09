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

function newSession() {
  return { id: memory.stamp().id, startedAt: memory.stamp().id, messages: [], skillsUsed: [], activeSkill: null };
}
function loadCurrent() {
  try {
    const s = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
    s.messages = s.messages || [];
    s.skillsUsed = s.skillsUsed || [];
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
  try {
    output = await provider.complete(prompt, opts);
    return output;
  } catch (e) {
    error = e.message;
    throw e;
  } finally {
    tracer.log({ label, model: (opts && opts.provider) || "claude-p", ms: Date.now() - start, ...(extra || {}), prompt, output, error });
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
  let out = lines.join("\n")
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
  });
  try {
    const raw = await timedComplete("route", prompt, { provider: cfg.provider, config: cfg });
    const parsed = parseJsonLoose(raw);
    if (parsed) return parsed;
  } catch (e) { console.error(`[route] ${e.message}`); }
  return { skill: "stay", reference: null, recall: null, consult: null, close: false, reason: "router-fallback" };
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
  return T.buildRespondPrompt({
    system: T.SYSTEM_PREAMBLE,
    safetyDirective: opts.safetyDirective || null,
    toneDirective: opts.toneDirective || null,
    agentCore: skills.readAgentCore(),
    activeSkillName: active.name,
    skillBody,
    referenceName: active.reference,
    referenceBody,
    profileBlock: memory.profileContext(),
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
  let routerReason = null;

  if (!crisis.flagged) {
    const routed = await route(cfg, session, userMessage);
    active = resolveActiveSkill(routed, session);
    recall = buildRecallBlock(routed, active.name);
    close = routed.close === true;
    routerReason = routed.reason || null;
  }

  const opts = { recallBlock: recall.block, toneDirective: T.buildToneDirective(cfg.user || {}) };
  if (crisis.flagged) opts.safetyDirective = safety.SAFETY_DIRECTIVE;

  const respondPrompt = assemble(session, userMessage, active, opts);
  const raw = await timedComplete("respond", respondPrompt, { provider: cfg.provider, config: cfg }, {
    activeLens: active.name, reference: active.reference, recall: recall.recalledSessionId, consult: recall.consulted, crisis: crisis.flagged,
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

  return { reply, activeSkill: active.name, reference: active.reference, safety: crisis.flagged, close, trace };
}

// ─── Session end / consolidate ───────────────────────────────────────────────

async function endSession() {
  const session = loadCurrent();
  if (!session || !session.messages.length) { clearCurrent(); return { ended: false, reason: "empty" }; }
  const cfg = loadConfig() || {};
  const transcript = renderTranscript(session.messages, 1000);

  let parsed = null;
  try {
    const raw = await timedComplete(
      "consolidate",
      T.buildConsolidatePrompt({ transcript, skillsUsed: session.skillsUsed, profileBlock: memory.profileContext() }),
      { provider: cfg.provider, config: cfg }
    );
    parsed = parseJsonLoose(raw);
  } catch (e) { console.error(`[consolidate] ${e.message}`); }

  if (!parsed) {
    const firstUser = session.messages.find((m) => m.role === "user");
    parsed = { title: "Session", summary: firstUser ? firstUser.content.slice(0, 160) : "(conversation)", presentingConcern: "", insights: [], profileUpdates: {} };
  }

  const node = memory.appendSession({ ...parsed, skills: session.skillsUsed });
  if (parsed.nextOpener) memory.setNextOpener(parsed.nextOpener);
  clearCurrent();
  return { ended: true, node };
}

// ─── Opener (pre-generated at consolidation; deterministic fallback otherwise) ─

function getOpener(cfg) {
  const style = (cfg && cfg.user && cfg.user.openerStyle) || "smart";
  const profile = memory.loadProfile();
  const name = profile.name || (cfg && cfg.user && cfg.user.name) || "";
  const sessions = memory.listSessions();

  if (style === "open") {
    return { style, blurb: `Hi${name ? " " + name : ""}. What's on your mind?`, options: [] };
  }

  if (style === "smart" && profile.nextOpener && profile.nextOpener.blurb) {
    return { style, ...profile.nextOpener };
  }

  if (sessions.length) {
    const last = sessions[0];
    const options = [`Pick up on “${last.title}”`];
    for (const c of (profile.presentingConcerns || []).slice(0, 2)) options.push(c.replace(/^["']|["']$/g, "").slice(0, 60));
    options.push("Something new today");
    return {
      style,
      blurb: `Hi${name ? " " + name : ""}. Last time we sat with “${last.title}.” We can pick that thread back up, or start somewhere new — whatever feels right.`,
      options: [...new Set(options)].slice(0, 3),
    };
  }

  // First-ever session.
  return {
    style,
    blurb: `Hi${name ? " " + name : ""}. There's no agenda here — we can start wherever you like. What's been sitting with you lately?`,
    options: [],
  };
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

  // Deterministic MC fields → profile / config (no LLM needed for these).
  // readiness is an ordered array (click order = priority); emotionalStyle is multi-select.
  const readinessArr = (Array.isArray(mc.readiness) ? mc.readiness : (mc.readiness ? [mc.readiness] : [])).filter(Boolean);
  const readiness = readinessArr.join(" > "); // preserves priority
  const esArr = (Array.isArray(mc.emotionalStyle) ? mc.emotionalStyle : (mc.emotionalStyle ? [mc.emotionalStyle] : [])).filter((x) => x && x !== "unsure");
  const emotionalStyleMC = esArr.join(", ");
  const topics = Array.isArray(mc.topics) ? mc.topics.filter((t) => t && t !== "Not sure yet") : [];

  const mcSummary = [
    topics.length ? `Bringing them here: ${topics.join(", ")}` : "",
    readinessArr.length ? `What they want, in priority order: ${readinessArr.join(" > ")}` : "",
    mc.tone ? `Preferred tone: ${mc.tone}` : "",
    esArr.length ? `Self-reported way(s) of handling feelings: ${esArr.join(", ")}` : "",
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
  if (hasConvo || topics.length) {
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
    people: Array.isArray(extracted.people) ? extracted.people : [],
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
    suspectedPatterns: extracted.suspectedPatterns || [],
    tone: mc.tone || "",
  };
  memory.seedFromOnboardingExtraction(data);
  return { ok: true, seeded: data };
}

// ─── Management ──────────────────────────────────────────────────────────────

function currentSessionView() {
  const s = loadCurrent();
  return s
    ? { active: true, id: s.id, turns: s.messages.filter((m) => m.role === "user").length, activeSkill: s.activeSkill, skillsUsed: s.skillsUsed, messages: s.messages }
    : { active: false, messages: [] };
}

module.exports = {
  ROOT,
  loadConfig,
  saveConfig,
  handleTurn,
  endSession,
  getOpener,
  onboardChat,
  onboardFinish,
  currentSessionView,
  clearCurrent,
  parseJsonLoose,
};
