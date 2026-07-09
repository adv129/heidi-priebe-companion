/*
 * Heidi Priebe Agent — Safety layer (src/safety.js).
 *
 * A conservative pre-check for acute-crisis signals. This does NOT replace the
 * model's judgment — the agent-core safety protocol is always in the system
 * prompt. Its job is to catch the highest-stakes cases early and force the
 * respond step into "safety mode": suspend framework/skill application, prepend
 * an explicit crisis directive, and surface resources. False positives are
 * acceptable here; a missed crisis is not.
 */

"use strict";

// Phrases that strongly indicate acute risk. Kept intentionally broad.
const CRISIS_PATTERNS = [
  /\bkill (?:myself|him|her|them|someone)\b/i,
  /\bkilling myself\b/i,
  /\bwant(?:ing)? to die\b/i,
  /\bdon'?t want to (?:be alive|live|exist|wake up|be here|be around|go on|keep going)\b/i,
  /\bdon'?t want to be here (?:any ?more|anymore)\b/i,
  /\bcan'?t (?:go on|do this any ?more|keep going|take it any ?more)\b/i,
  /\bend(?:ing)? (?:it all|my life|things)\b/i,
  /\btak(?:e|ing) my (?:own )?life\b/i,
  /\bsuicid(?:e|al)\b/i,
  /\bself[-\s]?harm(?:ing)?\b/i,
  /\b(?:cut|cutting|hurt|hurting) myself\b/i,
  /\bhurt (?:someone|somebody|others|him|her|them)\b/i,
  /\bno (?:reason|point) (?:to|in)? ?(?:live|living|go on|going on|be here|being here)\b/i,
  /\b(?:everyone|everybody|they'?d all) (?:would )?be better off (?:without me|if i (?:was|were) (?:gone|dead))\b/i,
  /\bbetter off (?:dead|without me)\b/i,
  /\bwant(?:ing)? to (?:disappear|not exist|vanish)\b/i,
  /\b(?:nothing|life) (?:matters|is worth it) any ?more\b/i,
  /\boverdos(?:e|ing)\b/i,
];

const RESOURCES = [
  "If you're in immediate danger, please call your local emergency number now.",
  "US: call or text 988 (Suicide & Crisis Lifeline). UK & ROI: Samaritans 116 123.",
  "You can find international crisis lines at https://findahelpline.com.",
].join(" ");

/**
 * crisisCheck(text) -> { flagged, matched: [pattern strings] }
 */
function crisisCheck(text) {
  if (!text || typeof text !== "string") return { flagged: false, matched: [] };
  const matched = [];
  for (const re of CRISIS_PATTERNS) {
    if (re.test(text)) matched.push(re.source);
  }
  return { flagged: matched.length > 0, matched };
}

// Directive injected into the respond prompt when a crisis is detected.
const SAFETY_DIRECTIVE = [
  "SAFETY OVERRIDE — POSSIBLE CRISIS DETECTED.",
  "Set aside all frameworks, skills, routing, and psychoeducation. Do not analyze,",
  "reframe, or teach. Respond as a warm, calm, present human being who takes this",
  "seriously. Reflect what you heard without alarm or judgment. Gently and clearly",
  "encourage reaching out to crisis support and trusted people, and share the",
  "resources below verbatim near the end. Ask if they are safe right now. Stay with",
  "them; keep the reply focused only on their safety and connection to real help.",
  "You are not a crisis service or a therapist — say so plainly and kindly.",
  "",
  `RESOURCES TO SHARE: ${RESOURCES}`,
].join("\n");

module.exports = { crisisCheck, RESOURCES, SAFETY_DIRECTIVE };
