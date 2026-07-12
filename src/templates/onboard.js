/*
 * Onboarding prompts + section definitions (src/templates/onboard.js).
 *
 * Onboarding is two phases: a quick client-side multiple-choice pass, then one or
 * more short CONVERSATIONAL sections where the companion genuinely gets to know
 * the person in that area (skippable at any time). This module holds the section
 * defs, the per-turn follow-up prompt, and the final extraction prompt.
 */

"use strict";

// Conversational sections, in order. Keep short to avoid fatigue.
const SECTIONS = [
  {
    id: "relationships",
    title: "Relationships",
    seed: "To start getting to know you a little — who are the most important and impactful relationships in your life right now?",
    maxTurns: 3, // companion follow-ups before auto-advancing
  },
];

// Multiple-choice options for Phase A (mirrored in the front-end).
const MC = {
  // Covers Heidi Priebe's full range (maps loosely onto the 9 topical skills).
  topics: [
    "Relationships & dating",
    "Anxious or avoidant patterns in love",
    "Family & how I was raised",
    "Feeling flawed, not enough, or ashamed",
    "People-pleasing & losing myself",
    "Understanding & actually feeling my emotions",
    "A hard childhood / healing old wounds",
    "Grief, a breakup, or letting go",
    "Boundaries & codependency",
    "Being honest with myself / feeling stuck",
    "Personality & self-understanding",
    "Anxiety",
    "Not sure yet",
  ],
  readiness: [
    { value: "venting", label: "I mostly want to be heard" },
    { value: "wants insight", label: "I want to understand myself better" },
    { value: "wants tools", label: "I want practical tools" },
    { value: "wants challenge", label: "I want to be gently challenged" },
  ],
  tone: [
    { value: "support", label: "Gentle & supportive" },
    { value: "balanced", label: "Balanced" },
    { value: "challenge", label: "Direct — challenge me" },
  ],
  emotionalStyle: [
    { value: "analyze", label: "I analyze / think them through" },
    { value: "push through", label: "I push through and stay busy" },
    { value: "numb", label: "I go numb or shut down" },
    { value: "feel intensely", label: "I feel them intensely" },
    { value: "unsure", label: "Not sure" },
  ],
};

/** One warm follow-up within a section. Pure prose out — never meta. */
function buildOnboardFollowupPrompt({ sectionTitle, transcript, final }) {
  const task = final
    ? `This is the END of this short section. Do NOT ask another question. Give a brief, warm ONE-LINE
acknowledgment that gently wraps up this topic (no question mark, no "ready to keep going").`
    : `Ask ONE short, warm, genuinely curious follow-up. MATCH THEIR ENERGY — this is the most important
rule: if their answer was short, guarded, flat, or effortful, do NOT dig deeper; reflect once, keep it
light and concrete, or simply make it easy to move on. Only go one layer deeper — toward the specifics,
the feeling, or what it's like for them — when they gave you something with detail or life in it.
This is a first meeting, not a session: easy and concrete beats deep. Never ask about childhood or
wounds they didn't raise themselves. If they named a person or a goal, that's a good thread. Reflect
briefly before you ask. One or two sentences.`;
  return `You are a warm, grounded companion gently getting to know someone during a light intake, focused
right now on ONE area: "${sectionTitle}". This is not therapy and you are not diagnosing.

${task} Do NOT list options, do NOT use headings or bullets, do NOT use any markdown (no asterisks,
no lists — it renders as literal symbols), do NOT mention frameworks or that this is intake. Output
ONLY what you'd say to them, in plain flowing text.

CONVERSATION IN THIS SECTION SO FAR:
${transcript}

Your ${final ? "brief closing line" : "next short reflection + question"}:`;
}

/** Fold the whole onboarding (MC + section transcripts) into profile dimensions. Strict JSON out. */
function buildOnboardExtractionPrompt({ mcSummary, transcripts }) {
  return `You are the intake-consolidation component of a therapeutic-companion agent. Below is a short
multiple-choice intake plus guided conversational sections. Build a faithful, concise starting profile
that captures who this person is. Use ONLY what's present — do NOT diagnose or invent detail.

MULTIPLE-CHOICE INTAKE:
${mcSummary}

CONVERSATIONAL SECTIONS:
${transcripts}

Respond with ONLY a JSON object (no prose, no code fences), omitting any field you have nothing for:
{
  "lifeContext": "<1-2 sentences: who they are / their current situation — school, work, living, etc.>",
  "people": [{ "name": "<name>", "relationship": "<e.g. sister, mom, ex-partner>", "notes": "<what they said about this relationship>" }],
  "values": ["<what matters to them / what they want out of life>"],
  "goals": ["<what they're hoping to get from this work>"],
  "relationalContext": "<1-2 sentences on their relational world overall>",
  "emotionalStyle": "<how they tend to handle feelings, if it came up>",
  "history": ["<key turning points they shared, e.g. a move, a divorce, a breakup>"],
  "whatHelps": ["<anything that has helped them before, if mentioned>"],
  "presentingConcerns": ["<what's bringing them here, in their words>"],
  "suspectedPatterns": ["<at most 1-2 gentle, tentative hypotheses — ONLY if grounded in something THEY actually said here; never a stock guess>"],
  "firstOpener": {
    "blurb": "1-2 warm plain-text sentences to open their FIRST conversation, picking up the most alive thread from this intake (no pressure, gives permission to start anywhere else; NO markdown)",
    "options": ["<=5 words, a tappable starting point grounded in what they shared", "<=5 words, another", "Something else today"]
  }
}
Capture EVERY person they named in "people". Keep other arrays to 0-3 items each. Be faithful and
concise. Always include "firstOpener".`;
}

module.exports = { SECTIONS, MC, buildOnboardFollowupPrompt, buildOnboardExtractionPrompt };
