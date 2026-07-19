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

// Two-phase wrap-up hard trigger: once a session EXCEEDS this many user
// messages, force the "ask" phase even if the router never senses a pause —
// and, if declined, re-ask every WRAP_REASK_EVERY further user messages.
// WRAP_ASK_THRESHOLD is the DEFAULT: the person can tune it (20–60) via
// config user.wrapAfter — see wrapAskThreshold() — from Settings or the
// in-chat Length pill. Config is re-read every turn, so it applies to the
// next message with no restart.
const WRAP_ASK_THRESHOLD = 45;
const WRAP_REASK_EVERY = 10;
const WRAP_AFTER_MIN = 20;
const WRAP_AFTER_MAX = 60;

/**
 * Effective wrap-up ask threshold: user-configurable via config user.wrapAfter,
 * clamped to 20–60; anything unset/unparsable falls back to WRAP_ASK_THRESHOLD.
 */
function wrapAskThreshold(cfg) {
  const n = parseInt(cfg && cfg.user && cfg.user.wrapAfter, 10);
  const v = Number.isFinite(n) ? n : WRAP_ASK_THRESHOLD;
  return Math.min(WRAP_AFTER_MAX, Math.max(WRAP_AFTER_MIN, v));
}

// ─── Config ────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return null; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

// ─── Current session (persisted so a restart doesn't lose it) ────────────────

// wrap = two-phase close state: askedAt is the exchange count (user turns) at
// the last wrap-up move (ask OR begin), phase is "none" | "asked" | "begun".
function newWrapState() { return { askedAt: null, phase: "none" }; }

function newSession(mode = "talk") {
  return { id: memory.stamp().id, startedAt: memory.stamp().id, mode, messages: [], skillsUsed: [], activeSkill: null, wrap: newWrapState() };
}
function loadCurrent() {
  try {
    const s = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
    s.messages = s.messages || [];
    s.skillsUsed = s.skillsUsed || [];
    s.mode = s.mode === "explore" ? "explore" : "talk";
    // Older current.json files predate the wrap state — default it on load.
    const w = s.wrap;
    s.wrap = w && typeof w === "object"
      ? { askedAt: Number.isFinite(w.askedAt) ? w.askedAt : null, phase: ["asked", "begun"].includes(w.phase) ? w.phase : "none" }
      : newWrapState();
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

/**
 * True when text ends on a question — "?" possibly followed by closing
 * quotes/parens (e.g. `He said "why?"`, `Right?)`). Used as the deterministic
 * backstop for the close nudge: it must never render under a question.
 */
function endsWithQuestion(text) {
  return /\?["'”’)\]]*$/.test(String(text || "").trim());
}

function renderTranscript(messages, limit = MAX_HISTORY_MSGS) {
  return messages
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "Person" : "Companion"}: ${m.content}`)
    .join("\n\n");
}

function agentCoreRoutingTable() {
  // ALL router-facing agent-core machinery (routing signals, the routing
  // table, mixed presentations) lives in routing-map.md; agent-core's
  // SKILL.md is respond-facing only and never reaches the route prompt.
  return skills.tryReadReference(skills.AGENT_CORE, "routing-map.md") || skills.readAgentCore();
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
 * Streaming twin of timedComplete: onDelta(fragment) fires as the model writes.
 * Traces the FULL raw output (including [NEXT] delimiters) with the same record
 * shape, so trace analysis doesn't care which path a call took.
 */
async function timedCompleteStream(label, prompt, opts, extra, onDelta) {
  const start = Date.now();
  let output = "", error = null;
  const usage = {}; // adapters may fill { model, tokens, costUsd } via this sink
  try {
    output = await provider.completeStream(prompt, { ...opts, kind: label, usageSink: usage }, onDelta);
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

/**
 * Trim accidental meta leakage from one chat-bubble chunk. The prompt already
 * forbids it; this is backup. Every chunk gets the meta-line drop, markdown
 * strip, wikilink/blank-line cleanup, and a [NEXT] leak-strip. stripPlanning
 * runs on the FIRST chunk only — a planning preamble leaks at the start of the
 * reply, and running it on later chunks would mangle legitimate short bubbles
 * like "I'll be here."
 */
function sanitizeChunk(text, { first = false } = {}) {
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
    .replace(/\[NEXT\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return first ? stripPlanning(out) : out;
}

/** Trim accidental meta leakage from a whole reply (openers, onboarding, …). */
function sanitizeReply(text) {
  return sanitizeChunk(text, { first: true });
}

const MAX_CHUNKS = 6;

/** Split a raw reply on the [NEXT] delimiter: trim, drop empties, cap 6. */
function splitChunks(text) {
  return String(text || "")
    .split(/\s*\[NEXT\]\s*/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CHUNKS);
}

const PLANNING_FALLBACK = "I'm right here with you. Take whatever time you need — we don't have to force anything.";

/**
 * Incremental [NEXT] splitter + per-chunk sanitizer — the single chunking code
 * path for both the streaming and blocking respond flows (the only difference
 * is whether onChunk fires as chunks complete or all at the end).
 *
 * feed(delta) buffers text and cuts a raw chunk each time the buffer contains
 * the complete delimiter — nothing is emitted until the whole "[NEXT]" (or
 * stream end) arrives, which handles the delimiter being split across deltas.
 * end() flushes the remainder as the last chunk and returns the state.
 *
 * The FIRST sanitized chunk is gated by looksLikePlanning: if it trips, the
 * canned fallback becomes the only chunk (leaked=true) and every subsequent
 * chunk is dropped while the stream is left to finish.
 */
function makeChunkStream(onChunk) {
  let buf = "";
  const state = { chunks: [], leaked: false };
  const emit = (raw) => {
    if (state.leaked || state.chunks.length >= MAX_CHUNKS) return;
    const text = sanitizeChunk(raw, { first: state.chunks.length === 0 });
    if (!text) return; // skip empty-after-sanitize
    if (state.chunks.length === 0 && looksLikePlanning(text)) {
      state.leaked = true;
      state.chunks.push(PLANNING_FALLBACK);
      if (onChunk) { try { onChunk(PLANNING_FALLBACK, 0); } catch { /* hook errors never break the turn */ } }
      return;
    }
    state.chunks.push(text);
    if (onChunk) { try { onChunk(text, state.chunks.length - 1); } catch { /* hook errors never break the turn */ } }
  };
  return {
    state,
    feed(delta) {
      buf += String(delta == null ? "" : delta);
      let m;
      while ((m = buf.match(/\[NEXT\]/)) !== null) {
        emit(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
    },
    end() {
      const rest = buf;
      buf = "";
      emit(rest);
      return state;
    },
  };
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

async function route(cfg, session, userMessage, exchanges) {
  const tailMsgs = [...session.messages, { role: "user", content: userMessage }];
  const sessionHistory = memory.listSessions().slice(0, 12).map((s) => `${s.id} — ${s.title}`).join("\n");
  // The router can't feel a long session (or a pending wrap-up ask) from a
  // 6-message tail, so the exchange count (user turns incl. this one) and the
  // wrap-up state ride along and feed the two-phase close rules.
  const wrap = session.wrap || newWrapState();
  const prompt = T.buildRoutePrompt({
    sessionStats: { exchanges, wrapAfter: wrapAskThreshold(cfg) },
    wrapAskedAgo: wrap.askedAt != null ? exchanges - wrap.askedAt : null,
    wrapPhase: wrap.phase,
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
  return { skill: "stay", reference: null, recall: null, consult: null, close: "none", suggestExplore: false, reason: "router-fallback" };
}

/**
 * Normalize the router's "close" field to a wrap-up move. Tolerates the legacy
 * boolean contract (true meant "sensed a pause" → the modern "ask") and any
 * malformed value (→ "none").
 */
function normalizeCloseMove(v) {
  if (v === "ask" || v === "begin" || v === "none") return v;
  if (v === true || v === "true") return "ask";
  return "none";
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

// Two-phase wrap-up directives threaded into the respond prompt.
//
// Phase "ask": the reply checks in about wrapping up — one woven-in question,
// no winding down yet, no UI nudge.
const WRAP_ASK_NOTE =
  "This exchange feels like it may be reaching a settling point. Within your reply, gently ask whether" +
  " this feels like a good place to start wrapping up — one natural sentence woven into what you're" +
  " already saying, not a formal checkpoint. Do NOT start winding down yet: if they'd rather keep" +
  " going, nothing changes.";

// Phase "begin": they've assented (or asked to wrap) — the reply lands the
// session. Written to end WITHOUT a question, otherwise the responder
// (especially on a high inquisitive dial) opens a fresh thread and the
// wrap-up nudge renders under it.
const CLOSING_NOTE =
  "They're ready to wrap up. Let this reply land the session: briefly reflect the arc of what they" +
  " worked through today, and mention anything they're carrying between sessions — open homework, a" +
  " running experiment (only what's real in the context above; nothing if there's nothing). End warmly," +
  " and do NOT ask a new question or open a new thread. A complete close.";

function assemble(session, userMessage, active, opts = {}) {
  const skillBody = active.name ? skills.readSkillBody(active.name) : null;
  const referenceBody = active.reference ? skills.readReference(active.name, active.reference) : null;
  const exploring = session.mode === "explore";
  // agent-core's stance/question references ride along with its body: the
  // respond model can't open files, so anything it should know must be inlined.
  const agentCore = [
    skills.readAgentCore(),
    skills.tryReadReference(skills.AGENT_CORE, "conversational-stance.md"),
    exploring ? skills.tryReadReference(skills.AGENT_CORE, "intake-questions.md") : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  return T.buildRespondPrompt({
    system: exploring ? T.EXPLORE_PREAMBLE : T.SYSTEM_PREAMBLE,
    safetyDirective: opts.safetyDirective || null,
    toneDirective: opts.toneDirective || null,
    agentCore,
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
    wrapAskNote: opts.closeMove === "ask" ? WRAP_ASK_NOTE : null,
    closingNote: opts.closeMove === "begin" ? CLOSING_NOTE : null,
  });
}

async function handleTurn(userMessage, hooks = {}) {
  const cfg = loadConfig() || {};
  const session = ensureSession();
  const crisis = safety.crisisCheck(userMessage);
  const wrap = session.wrap || (session.wrap = newWrapState());
  const exchanges = session.messages.filter((m) => m.role === "user").length + 1; // incl. this one

  // Post-begun cooldown: a wind-down happened but the person kept talking well
  // past it (WRAP_REASK_EVERY exchanges) without ending — treat the wrap-up as
  // abandoned so the flow (incl. the hard trigger) can start over from "none".
  if (wrap.phase === "begun" && wrap.askedAt != null && exchanges - wrap.askedAt >= WRAP_REASK_EVERY) {
    wrap.phase = "none";
  }

  let active = { name: null, reference: null };
  let recall = { block: null, recalledSessionId: null, consulted: null };
  let closeMove = "none";
  let wrapForced = false;
  let routerReason = null;

  if (!crisis.flagged) {
    const routed = await route(cfg, session, userMessage, exchanges);
    active = resolveActiveSkill(routed, session);
    recall = buildRecallBlock(routed, active.name);
    closeMove = normalizeCloseMove(routed.close);
    routerReason = routed.reason || null;
    // Explore entry points are dormant for now: the router may still emit
    // suggestExplore, but it's deliberately not propagated to the UI.

    // Hard trigger: past the (user-configurable) wrap-up threshold the ask is
    // forced even when the router senses no pause — and re-forced every
    // WRAP_REASK_EVERY further messages if declined. Never while a wind-down
    // is already underway ("begun"; the cooldown above resets that).
    if (
      closeMove === "none" && exchanges > wrapAskThreshold(cfg) && wrap.phase !== "begun" &&
      (wrap.askedAt == null || exchanges - wrap.askedAt >= WRAP_REASK_EVERY)
    ) {
      closeMove = "ask";
      wrapForced = true;
    }
  }

  const opts = { recallBlock: recall.block, toneDirective: T.buildToneDirective(cfg.user || {}), closeMove };
  if (crisis.flagged) opts.safetyDirective = safety.SAFETY_DIRECTIVE;

  const respondPrompt = assemble(session, userMessage, active, opts);
  const respondLabel = session.mode === "explore" ? "explore-respond" : "respond";
  const respondOpts = { provider: cfg.provider, config: cfg };
  const respondExtra = {
    activeLens: active.name, reference: active.reference, recall: recall.recalledSessionId, consult: recall.consulted, crisis: crisis.flagged, mode: session.mode,
  };

  // One chunking code path for both flows: split the RAW respond output on
  // [NEXT], sanitize per chunk. With hooks.onChunk the splitter is fed deltas
  // as the model writes (bubbles stream out); without it the same splitter is
  // fed the finished text — identical chunks either way.
  const splitter = makeChunkStream(hooks.onChunk || null);
  let raw;
  if (hooks.onChunk) {
    raw = await timedCompleteStream(respondLabel, respondPrompt, respondOpts, respondExtra, (delta) => splitter.feed(delta));
    splitter.end();
    // Safety net: the authoritative result can exist even when no deltas
    // surfaced (adapter fallback edge). Re-feed the full text once.
    if (!splitter.state.chunks.length && raw) { splitter.feed(raw); splitter.end(); }
  } else {
    raw = await timedComplete(respondLabel, respondPrompt, respondOpts, respondExtra);
    splitter.feed(raw);
    splitter.end();
  }

  let chunks = splitter.state.chunks;
  const leaked = splitter.state.leaked;
  if (!chunks.length) {
    chunks = ["I'm here. Tell me a little more about what's on your mind."];
    if (hooks.onChunk) { try { hooks.onChunk(chunks[0], 0); } catch { /* hook errors never break the turn */ } }
  }
  const reply = chunks.join("\n\n");

  // Advance the wrap-up state now that the reply exists. askedAt records the
  // exchange count of the LAST wrap move (ask or begin) — it drives both the
  // re-ask cadence and the post-begun cooldown.
  if (closeMove === "ask") { wrap.askedAt = exchanges; wrap.phase = "asked"; }
  else if (closeMove === "begin") { wrap.askedAt = exchanges; wrap.phase = "begun"; }

  // The nudge renders only for the "begin" phase (the wind-down reply), and a
  // deterministic backstop keeps it from ever landing under a question: if the
  // begin reply still ends on one (the CLOSING NOTE is guidance, not a
  // guarantee), suppress it for the UI. An "ask" reply legitimately ends on a
  // question — no nudge there by design. The trace keeps the resolved move so
  // Show thinking can still explain it.
  let close = closeMove === "begin";
  const closeSuppressed = close && endsWithQuestion(chunks[chunks.length - 1]);
  if (closeSuppressed) close = false;

  const trace = {
    activeLens: active.name,
    routerReason,
    reference: active.reference,
    recalledSessionId: recall.recalledSessionId,
    consulted: recall.consulted,
    closeMove,
    ...(wrapForced ? { wrapForced: true } : {}),
    ...(closeSuppressed ? { closeSuppressed: true } : {}),
    mode: session.mode,
    safety: crisis.flagged,
  };
  tracer.log({ label: "turn", sessionId: session.id, userMessage, rawReply: raw, reply, leaked, ...trace });

  session.messages.push({ role: "user", content: userMessage });
  // `content` stays the joined prose (renderTranscript and prompts read it);
  // `chunks` preserves the bubble boundaries for the UI to restore.
  session.messages.push({ role: "assistant", content: reply, chunks, trace });
  if (active.name) {
    session.activeSkill = active.name;
    if (!session.skillsUsed.includes(active.name)) session.skillsUsed.push(active.name);
  }
  saveCurrent(session);

  return { reply, chunks, activeSkill: active.name, reference: active.reference, safety: crisis.flagged, close, mode: session.mode, trace };
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
      lines.push(`- (${x.id}) experiment "${x.theReplacement}"${x.thePattern ? ` instead of "${x.thePattern}"` : ""} — ${x.status}${day ? `, day ${day}` : ""}${x.checkIns.length ? `, last check-in ${timeaware.relPhrase(x.checkIns[x.checkIns.length - 1].at, now)}` : ""}`);
    }
    for (const g of memory.loadProfile().goals.filter((g) => g.status !== "achieved").slice(0, 5)) {
      lines.push(`- (${g.id}) goal "${g.text}" — ${g.status}`);
    }
  } catch (e) { console.error(`[open-items] ${e.message}`); }
  return lines.join("\n");
}

const PENDING_SAVE_PATH = path.join(memory.MEM_DIR, "pending-save.json");
const RITUAL_MAX_CHARS = 500;

// Save-status state machine for the background-save indicator. Single-user
// app, so one module-level slot is enough: idle → saving → done | error.
// Nothing resets on read — terminal states keep their timestamp and the UI
// decides how long to show them (it only polls while a save it started is in
// flight, so a stale "done" never resurfaces as a fresh pill).
let saveStatus = { state: "idle", at: null };

function setSaveStatus(next) { saveStatus = { ...next, at: memory.stamp().id }; }
function saveStatusView() { return saveStatus; }

function cleanRitualText(v) {
  return typeof v === "string" ? v.trim().slice(0, RITUAL_MAX_CHARS).trim() : "";
}

// Early-consolidate head start (the closing card). While the person types their
// takeaway/experiment the transcript is already final, so the slow consolidate
// model call can run NOW — a pure read; every write (folds, appendSession,
// setNextOpener) waits for finalize. Single-user app: one module-level slot.
// { sessionId, promise, cancelled } — promise resolves { parsed, consolidateError }
// and never rejects.
let earlyConsolidate = null;

/**
 * The consolidate model call on a snapshot — the slow part of a save, and a
 * pure READ (no memory writes). Never rejects: model/parse failures come back
 * as { parsed: null, consolidateError }.
 */
async function runConsolidate(snapshot) {
  const cfg = loadConfig() || {};
  const now = new Date();
  try {
    const raw = await timedComplete(
      "consolidate",
      T.buildConsolidatePrompt({
        transcript: renderTranscript(snapshot.messages, 1000),
        skillsUsed: snapshot.skillsUsed,
        profileBlock: memory.profileContext(),
        mode: snapshot.mode,
        hypothesesBlock: memory.hypothesesContext({ mode: "consolidate" }),
        assignmentsBlock: memory.assignmentsContext(now),
        openItemsBlock: buildOpenItemsBlock(now),
        todayLine: timeaware.longNow(now),
        calendarBlock: timeaware.calendarTable(now),
      }),
      { provider: cfg.provider, config: cfg }
    );
    const parsed = parseJsonLoose(raw);
    return { parsed, consolidateError: parsed ? null : "consolidate returned no parseable JSON" };
  } catch (e) {
    console.error(`[consolidate] ${e.message}`);
    return { parsed: null, consolidateError: e.message };
  }
}

/**
 * The closing card just opened: start the consolidate on a snapshot of the
 * CURRENT session, in the background. current.json is NOT cleared and no
 * ritual write happens — "Keep talking" must still be able to cancel with
 * nothing written. The pending snapshot (phase "close-start") is crash
 * insurance only; resumePendingSave discards it while the session is live.
 *
 * Idempotent for the same session; a DIFFERENT session's save in flight →
 * { ok: false, reason: "save-in-progress" } (the server turns that into 409).
 */
function closeStart() {
  const session = loadCurrent();
  if (!session || !session.messages.length) return { ok: false, reason: "empty" };
  if (earlyConsolidate && !earlyConsolidate.cancelled && earlyConsolidate.sessionId === session.id) {
    return { ok: true, already: true };
  }
  if (saveStatus.state === "saving") return { ok: false, reason: "save-in-progress" };

  const snapshot = {
    phase: "close-start",
    id: session.id,
    mode: session.mode,
    messages: session.messages,
    skillsUsed: session.skillsUsed,
    takeaway: null,
    experimentId: null,
  };
  memory.ensureDirs();
  fs.writeFileSync(PENDING_SAVE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  setSaveStatus({ state: "saving" });
  earlyConsolidate = { sessionId: session.id, cancelled: false, promise: runConsolidate(snapshot) };
  return { ok: true, started: true };
}

/**
 * "Keep talking" / × / Escape while the closing card is open: discard the head
 * start. Nothing was written, so cancel is just: drop the result, delete the
 * pending snapshot, status back to idle. The in-flight model call itself is
 * left to finish and be ignored — killing it would need cancellation plumbing
 * through the provider layer for a rare path, and the cost is bounded (one
 * wasted consolidate call).
 */
function closeCancel() {
  if (!earlyConsolidate) return { ok: true, cancelled: false }; // nothing early in flight — leave real saves alone
  earlyConsolidate.cancelled = true;
  earlyConsolidate = null;
  try { fs.unlinkSync(PENDING_SAVE_PATH); } catch {}
  setSaveStatus({ state: "idle" });
  return { ok: true, cancelled: true };
}

/**
 * Synchronous part of ending a session — NO model call, returns immediately.
 *
 * 1. Guards double-saves (a consolidate already in flight → save-in-progress;
 *    this session's own close-start head start is not a double-save).
 * 2. Applies the deterministic closing-ritual writes: the self-authored
 *    experiment lands NOW (it must survive an LLM failure), and the takeaway
 *    rides in the snapshot for appendSession to fold in later.
 * 3. Snapshots the session to memory/pending-save.json (crash insurance),
 *    clears current.json so a fresh session can start immediately, and flips
 *    saveStatus to "saving".
 *
 * The caller kicks off finishSave(result.snapshot) WITHOUT awaiting it.
 * ritual: optional { takeaway, experiment } strings from the closing card.
 */
function endSession(ritual = {}) {
  const session = loadCurrent();
  const ownEarly = earlyConsolidate && !earlyConsolidate.cancelled && session && earlyConsolidate.sessionId === session.id;
  if (saveStatus.state === "saving" && !ownEarly) return { ended: false, reason: "save-in-progress" };
  if (!session || !session.messages.length) { clearCurrent(); return { ended: false, reason: "empty" }; }

  const takeaway = cleanRitualText(ritual.takeaway);
  const experimentText = cleanRitualText(ritual.experiment);

  let experiment = null;
  if (experimentText) {
    try { experiment = journey.addRitualExperiment(experimentText, session.id); }
    catch (e) { console.error(`[ritual-experiment] ${e.message}`); }
  }

  const snapshot = {
    phase: "finalize",
    id: session.id,
    mode: session.mode,
    messages: session.messages,
    skillsUsed: session.skillsUsed,
    takeaway: takeaway || null,
    experimentId: experiment ? experiment.id : null, // already written — resume never re-creates it
    endedAt: memory.stamp().id,
  };
  memory.ensureDirs();
  fs.writeFileSync(PENDING_SAVE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  clearCurrent();
  setSaveStatus({ state: "saving" });
  return { ended: true, saving: true, snapshot, experiment };
}

/**
 * Async part of the save: the consolidate result + folds + appendSession +
 * setNextOpener. When closeStart already ran the consolidate for this session,
 * its result is consumed here (ready → folds land immediately; still running →
 * they land when it does) instead of a second model call. Never throws for the
 * normal failure modes:
 *
 * - Model/parse failure → the session node is STILL written, with a
 *   deterministic fallback title (the first user line) and the ritual takeaway
 *   intact; saveStatus becomes "error" so the UI says "session kept, saving
 *   hit a snag". pending-save.json is deleted (the data landed).
 * - Even the fallback write failing → saveStatus "error" and pending-save.json
 *   is RETAINED for startup recovery (resumePendingSave).
 */
async function finishSave(snapshot) {
  const now = new Date();

  // The close-start head start: same session's consolidate already in flight
  // (or done) — await that instead of running it again.
  let head = null;
  if (earlyConsolidate && !earlyConsolidate.cancelled && earlyConsolidate.sessionId === snapshot.id) {
    head = earlyConsolidate;
    earlyConsolidate = null; // consumed
  }
  const { parsed: rawParsed, consolidateError } = head ? await head.promise : await runConsolidate(snapshot);
  let parsed = rawParsed;

  if (!parsed) {
    // Deterministic fallback: the session (and the ritual data) is never lost
    // to a failed model call.
    const firstUser = snapshot.messages.find((m) => m.role === "user");
    const firstLine = firstUser ? String(firstUser.content).split(/\r?\n/)[0].trim() : "";
    const title = firstLine ? (firstLine.length > 64 ? firstLine.slice(0, 64).trim() + "…" : firstLine) : "Session";
    parsed = { title, summary: firstUser ? firstUser.content.slice(0, 160) : "(conversation)", presentingConcern: "", insights: [], profileUpdates: {} };
    tracer.log({ label: "consolidate-fallback", sessionId: snapshot.id, error: consolidateError, fallbackTitle: title });
  }

  try {
    const node = memory.appendSession({ ...parsed, skills: snapshot.skillsUsed, mode: snapshot.mode, takeaway: snapshot.takeaway });
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
    try { fs.unlinkSync(PENDING_SAVE_PATH); } catch {}
    if (consolidateError) setSaveStatus({ state: "error", title: node.title, error: consolidateError });
    else setSaveStatus({ state: "done", title: node.title });
    return { ended: true, node, degraded: !!consolidateError };
  } catch (e) {
    console.error(`[finish-save] ${e.message}`);
    setSaveStatus({ state: "error", error: e.message });
    return { ended: false, error: e.message };
  }
}

/**
 * Crash recovery: pending-save.json existing at startup means a save never
 * finished (the process died mid-consolidate). Chosen behavior: RESUME —
 * re-run the full finishSave (fresh consolidate attempt) rather than folding
 * straight to the fallback title, since the transcript is intact and one more
 * model call is cheap; finishSave's own fallback still catches a second
 * failure. The ritual experiment was written in the sync part, so a resume
 * never duplicates it. An unreadable snapshot is discarded (logged).
 */
function resumePendingSave() {
  let snapshot = null;
  try {
    if (!fs.existsSync(PENDING_SAVE_PATH)) return null;
    snapshot = JSON.parse(fs.readFileSync(PENDING_SAVE_PATH, "utf8"));
  } catch (e) { console.error(`[save] unreadable pending-save.json — discarding (${e.message})`); try { fs.unlinkSync(PENDING_SAVE_PATH); } catch {} return null; }
  if (!snapshot || !Array.isArray(snapshot.messages) || !snapshot.messages.length) {
    try { fs.unlinkSync(PENDING_SAVE_PATH); } catch {}
    return null;
  }
  // A "close-start" snapshot is only a head start — if the session is still
  // live in current.json the person never finished the closing card, so the
  // snapshot is discarded and the session simply continues. Only when
  // current.json is gone too (a crash squeezed between end's pending write and
  // clearCurrent can't produce this phase) does it fall through to a real
  // resume, ending the session without ritual data.
  if (snapshot.phase === "close-start") {
    const cur = loadCurrent();
    if (cur && cur.id === snapshot.id) {
      console.log(`[save] discarding close-start snapshot for live session ${snapshot.id}`);
      try { fs.unlinkSync(PENDING_SAVE_PATH); } catch {}
      return null;
    }
  }
  console.log(`[save] resuming interrupted save for session ${snapshot.id}`);
  setSaveStatus({ state: "saving" });
  return finishSave(snapshot).catch((e) => { console.error(`[save] resume failed: ${e.message}`); });
}

// ─── Opener (pre-generated at consolidation; deterministic fallback otherwise) ─

function getOpener(cfg) {
  // Styles: "pickup" (default) | "homework" | "patterns". Legacy values
  // (smart/blurb/open) and anything unknown normalize to "pickup" on read —
  // config files are never rewritten.
  const requested = (cfg && cfg.user && cfg.user.openerStyle) || "pickup";
  const style = ["pickup", "homework", "patterns"].includes(requested) ? requested : "pickup";
  const profile = memory.loadProfile();
  const name = profile.name || (cfg && cfg.user && cfg.user.name) || "";
  const hi = `Hi${name ? " " + name : ""}`;
  const sessions = memory.listSessions();
  const trim = (s, n) => (s.length > n ? s.slice(0, n).trim() + "…" : s);

  // These ride along for every style: report-back chips for open homework
  // items and deterministic journey starters (passed event / experiment
  // check-in — at most one).
  const chipByType = {
    notice: { label: "Report back", message: (t) => `I want to report back on what I was noticing: "${t}"` },
    action: { label: "How it went", message: (t) => `I want to tell you how it went — the thing I said I'd try: "${t}"` },
    reflection: { label: "What came up", message: (t) => `I want to share what came up when I sat with: "${t}"` },
  };
  const toReportBack = (a) => {
    const chip = chipByType[a.type] || chipByType.notice;
    return { id: a.id, label: `${chip.label}: ${trim(a.text, 44)}`, message: chip.message(a.text) };
  };
  const openItems = memory.openAssignments();
  const reportBacks = openItems.slice(0, 2).map(toReportBack);
  const starters = journey.openerCandidates();
  // Profile exercises: the depth onboarding deliberately skips (people, goals,
  // patterns) surfaces here as light invitations once the person is in the app.
  const exercises = [];
  if (!(profile.people && profile.people.length)) exercises.push({ kind: "people", label: "Add the people in your life" });
  if (!(profile.goals && profile.goals.length)) exercises.push({ kind: "goal", label: "Name something you're working toward" });
  const base = { style, reportBacks, starters, exercises: exercises.slice(0, 2) };

  if (style === "homework") {
    const dueExperiment = starters.find((s) => s.kind === "experiment") || null;
    if (openItems.length || dueExperiment) {
      const verbByType = { notice: "notice", action: "try", reflection: "sit with" };
      const first = openItems[0];
      const blurb = first
        ? `${hi}. Before anything new — you agreed to ${verbByType[first.type] || "notice"} "${trim(first.text, 80)}". How's that been?`
        : `${hi}. Before anything new — I want to hear how that experiment's been going.`;
      // Every open item gets its report-back chip here; exercises stay off (focus).
      return { ...base, reportBacks: openItems.map(toReportBack), starters: dueExperiment ? [dueExperiment] : [], exercises: [], blurb, options: [] };
    }
    // Nothing to check in on — fall through to the pickup behavior.
  }

  if (style === "patterns") {
    const rank = { supported: 0, testing: 1, forming: 2 };
    const active = (profile.hypotheses || [])
      .filter((h) => h.status in rank)
      .sort((a, b) => (rank[a.status] - rank[b.status]) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 4);
    if (active.length) {
      return {
        ...base,
        blurb: `${hi}. We've been noticing a few patterns together. Want to take one apart and see if it holds up?`,
        options: active.map((h) => `Dig into: ${trim(h.statement, 70)}`),
      };
    }
    // No active patterns yet — fall through to the pickup behavior.
  }

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seen = new Set(starters.map((s) => norm(s.label)));
  const dedupe = (arr) => arr.filter((o) => {
    const n = norm(o);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  // pickup: fresh, consolidation-generated opener when one is waiting.
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
  closeStart,
  closeCancel,
  endSession,
  finishSave,
  resumePendingSave,
  saveStatusView,
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
  splitChunks,
  sanitizeChunk,
  makeChunkStream,
  endsWithQuestion,
  WRAP_ASK_THRESHOLD,
  WRAP_REASK_EVERY,
  wrapAskThreshold,
};
