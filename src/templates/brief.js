/*
 * Therapist-brief narrative prompt (src/templates/brief.js).
 *
 * One call composes the opening narrative of a brief the person sends to their
 * real-world therapist. The digest below is built from the SAME filtered data
 * the document renders — the model may reference nothing beyond it, so items
 * the person excluded can never surface in prose. Plain paragraphs out.
 */

"use strict";

function buildBriefNarrativePrompt({ preset, clientName, todayLine, windowLine, digest }) {
  const name = clientName || "The client";
  const task = preset === "pre-session"
    ? `This is a PRE-SESSION UPDATE: summarize what has moved ${windowLine || "recently"} — sessions,
pattern movement, goal movement, experiments, life events. Lead with the most clinically useful
change, not a chronology. Close with what seems most alive walking into the next session.`
    : `This is a FIRST-MEETING INTRODUCTION: introduce who ${name} is, their presenting picture,
what they're working toward, and what a therapist would want to know walking into a first
session. Lead with the person, not the app.`;

  return `You are composing the opening narrative of a written brief that a person is sending to
their (human) therapist, prepared from the person's self-reported data in a reflective companion
app. The person will review and may edit this text before sending it.

${task}

TODAY IS: ${todayLine}

EVERYTHING YOU MAY DRAW ON (the person chose exactly what to share — reference NOTHING beyond this):
${digest}

Write 3-4 short paragraphs of plain prose. Rules:
- Plain text only: no markdown, no headings, no bullets, no preamble or sign-off — start directly
  with the first paragraph.
- Third person, by first name ("${name} reports…", "${name} describes…"). Clinical-but-warm
  register: direct and information-dense, never cold, never flowery.
- Faithful to the data above: attribute everything to self-report; NEVER diagnose, and never
  invent severity, frequency, or detail not present. Working observations are hypotheses the
  person co-holds with the app, not conclusions — word them that way.
- If items appear under "For the therapist's awareness", mention them plainly in one sentence —
  do not dramatize and do not bury them.
- Do not mention the app's internal machinery (lenses, skills, hypotheses ids, votes,
  consolidation) by jargon; translate to plain language a clinician outside the app understands.
- Do not evaluate or praise the person ("impressive", "remarkable growth") — describe.

Your 3-4 paragraphs:`;
}

module.exports = { buildBriefNarrativePrompt };
