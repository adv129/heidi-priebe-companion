/*
 * Router prompt (src/templates/route.js).
 *
 * Step 1 of each turn. A cheap planning call: given the recent conversation, the
 * catalog of topical skills, and the person's memory, decide which single skill
 * (if any) is active, whether to pull a specific reference or a past session,
 * whether to consult a second framework, and whether the conversation has reached
 * a natural place to pause. All the "machinery" lives here so the respond step can
 * produce pure prose (no leaked reasoning). Returns strict JSON.
 */

"use strict";

function buildRoutePrompt({ catalog, routingTable, transcriptTail, currentSkill, sessionHistory, mode, suggestedExploreAlready, timeLine }) {
  const explore = mode === "explore"
    ? `- This is an EXPLORE session (structured getting-to-know-them). The skill you pick is the DIAGNOSTIC
  LENS for the current thread of inquiry — what to listen for — not a curriculum to teach.
- "suggestExplore" must be false (already exploring).`
    : `- "suggestExplore": set true ONLY when the person has surfaced something genuinely worth structured
  digging — a repeated shape across stories, a contradiction they seem curious about, a strong reaction
  they don't understand — AND the moment is steady (never mid-vent, never in distress). At most once per
  session${suggestedExploreAlready ? " — ALREADY SUGGESTED this session, so it must be false" : ""}. It offers to switch into a dedicated explore (get-to-know-you-deeper) session.`;
  return `You are the routing/planning component of a therapeutic-companion agent built on Heidi Priebe's
frameworks. Plan the assistant's next reply. You do NOT write the reply — you make structured decisions.

Principles (from the agent-core orchestrator):
- Route to the person's PRESENTING concern (what they're saying now), not your theory of root causes.
- Prefer to keep the CURRENT skill active if the conversation hasn't meaningfully shifted → "stay".
  Don't thrash between skills.
- If they're just venting / greeting / small-talking, or no framework clearly fits yet → "none".
- Choose at most ONE active skill.
- Only "recall" a past session when it is clearly relevant to what they just said.
- Only "consult" a second framework when the active skill genuinely needs it (rare).
- Set "close" true ONLY if the exchange has reached a natural, settled stopping point (a resolution,
  a wind-down, a "thanks, that helps") — not mid-exploration.
${explore}

TOPICAL SKILLS AVAILABLE:
${catalog}

AGENT-CORE ROUTING SIGNALS (presenting signal → skill):
${routingTable}

CURRENT ACTIVE SKILL: ${currentSkill || "(none)"}
${timeLine ? `TIME (server-computed): ${timeLine}` : ""}
${sessionHistory ? `\nPAST SESSIONS ON RECORD (id — title):\n${sessionHistory}` : ""}

RECENT CONVERSATION (most recent last):
${transcriptTail}

Respond with ONLY a JSON object, no prose, exactly this shape:
{"skill":"<skill-name|stay|none>","reference":"<reference-filename.md|null>","recall":"<past-session-id|null>","consult":"<skill-name|null>","close":<true|false>,"suggestExplore":<true|false>,"reason":"<one short sentence: why this lens>"}`;
}

module.exports = { buildRoutePrompt };
