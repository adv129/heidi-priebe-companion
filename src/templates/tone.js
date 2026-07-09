/*
 * Tone calibration (src/templates/tone.js).
 *
 * The person can dial three independent aspects of the companion's delivery on a
 * 1–5 scale: how INQUISITIVE it is (asks / probes), how CHALLENGING it is (pushes
 * back, names contradictions), and how VALIDATING it is (affirms / reassures).
 *
 * These dials are turned into a prose block that rides in the respond prompt so
 * the model can calibrate its delivery. They never override safety, pacing, or
 * the person's readiness — they only shape HOW it speaks, not WHETHER it's safe.
 */

"use strict";

const DIALS = ["inquisitive", "challenging", "validating"];
const DEFAULT_DIALS = { inquisitive: 3, challenging: 3, validating: 3 };

// Legacy single-choice tone → dials, so configs created before the three-dial
// UI keep behaving sensibly until the person touches the new sliders.
const LEGACY_TONE_TO_DIALS = {
  support: { inquisitive: 3, challenging: 1, validating: 5 },
  balanced: { inquisitive: 3, challenging: 3, validating: 3 },
  challenge: { inquisitive: 4, challenging: 5, validating: 2 },
};

// Per-level guidance for each dial. Index 0 is unused; levels are 1–5.
const SCALES = {
  inquisitive: [
    null,
    "Rarely ask questions. Mostly reflect and let them lead; ask only when something is essential to understand.",
    "Ask sparingly. Favor reflecting back over probing; a question only when it clearly opens something.",
    "Ask a gentle, genuine question when it would open something up — usually one at a time.",
    "Be actively curious. Often follow up with a question that goes a layer deeper into what they said.",
    "Be highly inquisitive. Probe often and ask layered, exploratory questions to draw out the specifics and the feeling underneath.",
  ],
  challenging: [
    null,
    "Don't challenge. Accept their framing and stay alongside them; never push back.",
    "Rarely challenge. At most the gentlest nudge, and only when it clearly serves them.",
    "Occasionally offer a gentle alternative perspective when it would genuinely help.",
    "Be willing to push back. Name contradictions and blind spots directly, while staying kind.",
    "Challenge directly and persistently. Surface contradictions, question their assumptions, and hold them to what they said they want — always caring, never harsh.",
  ],
  validating: [
    null,
    "Keep reassurance minimal. Don't cushion; stay neutral and matter-of-fact.",
    "Validate lightly. Acknowledge feelings briefly, then move on.",
    "Validate what's real for them while staying honest — affirm feelings without inflating them.",
    "Warmly validate and affirm their feelings often; lead with empathy.",
    "Be strongly validating and reassuring throughout. Lead with empathy and affirmation, and make sure they feel deeply understood.",
  ],
};

function clampLevel(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 3;
  return Math.min(5, Math.max(1, v));
}

/** Normalize whatever is in config into a full {inquisitive, challenging, validating} 1–5 map. */
function resolveDials(user = {}) {
  const raw = user.toneDials;
  if (raw && typeof raw === "object") {
    const out = {};
    for (const k of DIALS) out[k] = clampLevel(raw[k] != null ? raw[k] : DEFAULT_DIALS[k]);
    return out;
  }
  // Fall back to the legacy single-choice tone if that's all we have.
  const legacy = LEGACY_TONE_TO_DIALS[user.tone];
  return legacy ? { ...legacy } : { ...DEFAULT_DIALS };
}

const LABELS = { inquisitive: "Inquisitiveness", challenging: "Challenge", validating: "Validation" };

/** Build the prose TONE CALIBRATION block from a resolved dials map. */
function buildToneDirective(user = {}) {
  const dials = resolveDials(user);
  const lines = DIALS.map((k) => {
    const lvl = dials[k];
    return `- ${LABELS[k]}: ${lvl}/5 — ${SCALES[k][lvl]}`;
  });
  return [
    "These are the person's stated preferences for how you deliver — calibrate your delivery to each level.",
    "Blend them naturally into warm, plain prose; they shape HOW you speak, never whether you keep them safe,",
    "paced, and in the lead. If a level ever conflicts with the non-negotiables or their readiness, safety and pacing win.",
    "",
    ...lines,
  ].join("\n");
}

module.exports = { DEFAULT_DIALS, DIALS, LABELS, resolveDials, buildToneDirective };
