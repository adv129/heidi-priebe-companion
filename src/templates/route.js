/*
 * Router prompt (src/templates/route.js).
 *
 * Step 1 of each turn. A cheap planning call: given the recent conversation, the
 * catalog of topical skills, and the person's memory, decide which single skill
 * (if any) is active, whether to pull a specific reference or a past session,
 * whether to consult a second framework, and whether the conversation has reached
 * a natural place to start wrapping up (the two-phase close: ask, then begin).
 * All the "machinery" lives here so the respond step can produce pure prose
 * (no leaked reasoning). Returns strict JSON.
 */

"use strict";

function buildRoutePrompt({ catalog, routingTable, transcriptTail, currentSkill, sessionHistory, mode, suggestedExploreAlready, timeLine, sessionStats, wrapAskedAgo, wrapPhase }) {
  const sessionLine = sessionStats
    ? `SESSION SO FAR: ${sessionStats.exchanges} exchange${sessionStats.exchanges === 1 ? "" : "s"}.`
    : "";
  // The person's configured conversation length (core.wrapAskThreshold) rides
  // along so the organic close judgment matches where the hard trigger will fire.
  const wrapAfter = (sessionStats && sessionStats.wrapAfter) || 45;
  // Wrap-up state: the 6-message tail may not include the ask, so the router is
  // told explicitly whether (and how recently) wrapping up came up.
  let wrapLine;
  if (wrapAskedAgo == null) {
    wrapLine = "WRAP-UP STATE: not asked yet this session.";
  } else if (wrapPhase === "begun") {
    wrapLine = `WRAP-UP STATE: you began winding down ${wrapAskedAgo} exchange${wrapAskedAgo === 1 ? "" : "s"} ago — if they're still engaging, keep going normally ("none"); ask or begin again only when things settle once more.`;
  } else if (wrapAskedAgo <= 2) {
    wrapLine = `WRAP-UP STATE: you asked about wrapping up ${wrapAskedAgo} exchange${wrapAskedAgo === 1 ? "" : "s"} ago — read their reply for assent or decline.`;
  } else {
    wrapLine = `WRAP-UP STATE: you asked about wrapping up ${wrapAskedAgo} exchanges ago and they kept going — don't ask again soon.`;
  }
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
- The skill decision and the close decision are INDEPENDENT. Never keep a skill because the
  conversation isn't ready to close, and never close because a skill ran out.
- Prefer "stay" for genuine continuations of the same thread — don't thrash between skills. But
  "stay" means the CURRENT thread still belongs to that skill's territory. Re-read the last 2-3
  exchanges on every turn: if what they're presenting NOW no longer matches the active skill,
  switch to the skill that does — or "none" if nothing clearly fits. Staying out of inertia is a
  routing failure, not caution.
- If they're just venting / greeting / small-talking, or no framework clearly fits yet → "none".
- Choose at most ONE active skill.
- "reference": each skill's catalog entry lists its loadable reference files. Set a reference filename
  ONLY when the conversation has narrowed to that sub-topic and deeper material would clearly help —
  and it must be one of the ACTIVE skill's listed filenames, verbatim. Otherwise null.
- Only "recall" a past session when it is clearly relevant to what they just said.
- Only "consult" a second framework when the active skill genuinely needs it (rare).
- "close" runs the two-phase wrap-up. Set "ask" when the exchange has reached a natural, settled
  stopping point (a resolution, a wind-down, a "thanks, that helps") — never mid-exploration. The
  reply will gently ASK whether this feels like a good place to start wrapping up: an invitation,
  not an ending.
  Set "begin" ONLY when (a) your previous turn asked about wrapping up and their new message
  assents, or (b) they themselves ask to wrap up or say they need to go — then skip the ask and
  go straight to "begin". The reply will properly wind the session down.
  If they decline an ask (not yet, keep going, a new thread opens), set "none" and do not ask
  again soon. Otherwise "none".
  Long sessions drift; helping them land well is part of care. Past roughly ${wrapAfter} exchanges, lean
  strongly toward "ask" at the first settled moment (the app will eventually force an ask anyway).
${explore}

TOPICAL SKILLS AVAILABLE:
${catalog}

AGENT-CORE ROUTING GUIDANCE (signals → skill, mixed presentations, when not to route):
${routingTable}

CURRENT ACTIVE SKILL: ${currentSkill || "(none)"}
${sessionLine}
${wrapLine}
${timeLine ? `TIME (server-computed): ${timeLine}` : ""}
${sessionHistory ? `\nPAST SESSIONS ON RECORD (id — title):\n${sessionHistory}` : ""}

RECENT CONVERSATION (most recent last):
${transcriptTail}

Respond with ONLY a JSON object, no prose, exactly this shape:
{"skill":"<skill-name|stay|none>","reference":"<reference-filename.md|null>","recall":"<past-session-id|null>","consult":"<skill-name|null>","close":"<none|ask|begin>","suggestExplore":<true|false>,"reason":"<one short sentence: why this lens>"}`;
}

module.exports = { buildRoutePrompt };
