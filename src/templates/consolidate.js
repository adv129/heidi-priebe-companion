/*
 * Consolidate prompt (src/templates/consolidate.js).
 *
 * Runs when a session ends. Summarizes the conversation into a session record
 * and extracts durable profile updates. Returns strict JSON that memory.js
 * folds into the graph + profile.
 */

"use strict";

function buildConsolidatePrompt({ transcript, skillsUsed, profileBlock }) {
  return `You are the memory-consolidation component of a therapeutic-companion agent. A conversation
session just ended. Summarize it and extract durable notes for the person's profile. Be faithful and
concise; do NOT diagnose or invent detail not present in the conversation.

SKILLS THAT WERE ACTIVE THIS SESSION: ${skillsUsed.length ? skillsUsed.join(", ") : "(none)"}

CURRENT PROFILE (for continuity — only add what's genuinely new or changed):
${profileBlock}

CONVERSATION TRANSCRIPT:
${transcript}

Respond with ONLY a JSON object in exactly this shape (no prose, no code fences):
{
  "title": "<=8 words naming what this session was about",
  "summary": "1-3 sentences, factual, in plain language",
  "presentingConcern": "what the person actually came in with, in their words",
  "insights": ["short bullet the person seemed to reach or that landed", "..."],
  "profileUpdates": {
    "relationalContext": "<string or omit>",
    "emotionalStyle": "<string or omit>",
    "readiness": "<venting|wants insight|wants tools|wants challenge or omit>",
    "people": [{ "name": "<a person newly mentioned or updated>", "relationship": "<role>", "notes": "<what's true about them now>" }],
    "values": ["<a value that surfaced, if new>"],
    "goals": ["<a goal that surfaced, if new>"],
    "history": ["<a turning point they shared, if new>"],
    "whatHelps": ["<something that helped, if mentioned>"],
    "suspectedPatterns": ["<hypothesis, tentative>"],
    "childhoodSignals": ["<only what they volunteered>"],
    "redFlags": ["<crisis/abuse/etc. only if clearly present>"]
  },
  "nextOpener": {
    "blurb": "1-2 warm sentences to greet them NEXT time, gently referencing where you left off (no pressure, gives permission to go elsewhere)",
    "options": ["a short tappable starting point", "another", "Something new today"]
  }
}
Omit any profileUpdates field you have nothing new for. Keep arrays short (0-3 items). The nextOpener
options should be 2-3 short phrases the person could tap to start next time.`;
}

module.exports = { buildConsolidatePrompt };
