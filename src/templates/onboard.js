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

// Multiple-choice options for Phase A (served to the front-end).
//
// The intake QUESTIONNAIRE — how Heidi actually maps a person: a handful of
// broad, easy questions anyone can answer in one tap, each sweeping one of her
// territories (life overall, love, family, the relationship with feelings,
// self-talk/shame, loss, boundaries, direction). No option requires
// self-awareness or self-diagnosis — the answers just locate where it hurts.
//
// Options carry a `signal` (0-3, how much this answer lights the territory up)
// and, when lit, the `title` + `seed` of the conversational section that answer
// turns into. Seeds echo the person's own answer ("You said…") and ask for a
// story, not an insight.
const QUESTIONNAIRE = [
  {
    id: "overall",
    q: "How's life feeling lately, overall?",
    options: [
      { label: "Pretty good", signal: 0 },
      { label: "Up and down", signal: 0 },
      { label: "Heavy", signal: 1, title: "The heaviness", seed: "You said life's been feeling heavy. Where does the weight sit, if you had to point at it?" },
      { label: "Numb — not much of anything", signal: 2, title: "The numbness", seed: "You said things feel numb. When did you last really feel something — good or bad?" },
      { label: "Chaotic", signal: 1, title: "The chaos", seed: "You said things feel chaotic. What's the loudest part right now?" },
    ],
  },
  {
    id: "love",
    q: "And your love life — partner, dating, or nothing at all — how's that part?",
    options: [
      { label: "Warm, solid", signal: 0 },
      { label: "It's fine", signal: 0 },
      { label: "Complicated", signal: 2, title: "The complicated part", seed: "You said your love life is complicated. What's the complication, in plain words?" },
      { label: "Painful right now", signal: 3, title: "What hurts", seed: "You said it's painful right now. What happened — as much or as little as you want." },
      { label: "Not part of my life right now", signal: 1, title: "On your own", seed: "Is being on your own right now a choice, a relief, a sore spot — or some mix?" },
    ],
  },
  {
    id: "family",
    q: "How are things with your family?",
    options: [
      { label: "Easy, mostly", signal: 0 },
      { label: "We're not close", signal: 1, title: "The distance", seed: "You said you're not close with family. Is that a peaceful distance, or the other kind?" },
      { label: "Complicated", signal: 2, title: "Family", seed: "You said family's complicated. Who's the complicated part with?" },
      { label: "Draining", signal: 3, title: "Family", seed: "You said family's draining. What happens on a typical call or visit?" },
      { label: "Rather not say yet", signal: 0 },
    ],
  },
  {
    id: "feelings",
    q: "When a hard feeling shows up, what usually happens?",
    options: [
      { label: "I feel it, and it passes", signal: 0 },
      { label: "I get busy with something", signal: 2, title: "Staying busy", seed: "You said you get busy when a hard feeling shows up. What do you usually reach for?" },
      { label: "I go quiet and pull away", signal: 2, title: "Going quiet", seed: "You said you go quiet. What's happening on the inside while you're quiet?" },
      { label: "It takes over", signal: 2, title: "The wave", seed: "You said feelings can take over. What does that look like from the inside?" },
      { label: "Honestly, I'm not sure", signal: 1, title: "Noticing feelings", seed: "Totally fair. When did you last notice a feeling clearly — even a small one?" },
    ],
  },
  {
    id: "selftalk",
    q: "When you mess something up, how do you talk to yourself?",
    options: [
      { label: "Kindly enough", signal: 0 },
      { label: "Fair, but firm", signal: 0 },
      { label: "Harshly", signal: 2, title: "The inner voice", seed: "You said you're harsh with yourself. What does that voice actually say — word for word, if you can?" },
      { label: "Brutally", signal: 3, title: "The inner voice", seed: "You said you're brutal with yourself. What does that voice actually say — word for word, if you can?" },
    ],
  },
  {
    id: "loss",
    q: "Are you carrying a loss right now — a person, a relationship, a chapter of life?",
    options: [
      { label: "No", signal: 0 },
      { label: "Maybe", signal: 1, title: "The maybe", seed: "You said maybe there's a loss in the picture. What's the maybe?" },
      { label: "Yes — a recent one", signal: 3, title: "Loss", seed: "Who or what — in whatever words come easily." },
      { label: "Yes — an old one that still aches", signal: 2, title: "An old loss", seed: "Tell me about it — whatever wants to be said." },
    ],
  },
  {
    id: "others",
    q: "How often do you go along with things you don't really want, to keep the peace?",
    options: [
      { label: "Rarely", signal: 0 },
      { label: "Sometimes", signal: 0 },
      { label: "A lot", signal: 2, title: "Keeping the peace", seed: "You said you go along with things a lot. Where does that happen most — work, home, friends?" },
      { label: "Constantly — it's my default", signal: 3, title: "Keeping the peace", seed: "You said keeping the peace is your default. Where does it cost you the most?" },
    ],
  },
  {
    id: "direction",
    q: "Do you feel like you know what you want right now — in life, roughly?",
    options: [
      { label: "Yes", signal: 0 },
      { label: "Mostly", signal: 0 },
      { label: "Not really", signal: 2, title: "What you want", seed: "You said you don't really know what you want right now. If nothing changed for a year, what would bother you most?" },
      { label: "I've stopped asking", signal: 3, title: "What you want", seed: "You said you've stopped asking what you want. When did you stop, roughly?" },
    ],
  },
];

const MC = {
  quiz: QUESTIONNAIRE,
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
  "suspectedPatterns": ["<at most 1-2 gentle, tentative hypotheses — ONLY about something the person talked about IN SOME DETAIL in the conversational sections (multiple sentences of their own words you could quote). A passing mention is not enough; multiple-choice taps are preferences, NOT evidence. When in doubt, return [] — patterns are earned in real sessions, not at the door>"],
  "firstOpener": {
    "blurb": "1-2 warm plain-text sentences to open their FIRST conversation, picking up the most alive thread from this intake (no pressure, gives permission to start anywhere else; NO markdown)",
    "options": ["<=5 words, a tappable starting point grounded in what they shared", "<=5 words, another", "Something else today"]
  }
}
Capture EVERY person they named in "people". Keep other arrays to 0-3 items each. Be faithful and
concise. Always include "firstOpener".`;
}

module.exports = { SECTIONS, MC, buildOnboardFollowupPrompt, buildOnboardExtractionPrompt };
