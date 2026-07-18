/*
 * Respond prompt (src/templates/respond.js).
 *
 * Step 2 of each turn. Assembles the full single-shot prompt from the layered
 * context: system preamble + agent-core + (one) active skill + (optional)
 * reference + memory blocks + conversation + the new user message. Any
 * on-demand recall/consult material from a second pass is appended too.
 */

"use strict";

function section(title, body) {
  if (!body || !String(body).trim()) return "";
  return `\n\n===== ${title} =====\n${String(body).trim()}`;
}

function buildRespondPrompt({
  system,
  safetyDirective, // when set, prepended prominently (crisis mode)
  toneDirective, // the person's 1–5 tone dials rendered as delivery guidance
  agentCore,
  activeSkillName,
  skillBody,
  referenceName,
  referenceBody,
  profileBlock,
  timeBlock, // server-computed time context (dates, gaps, aging items)
  understandingBlock, // working hypotheses (test, don't confirm)
  assignmentsBlock, // open homework items
  experimentsBlock, // running/proposed experiments + the propose-gate line
  skillHistoryBlock,
  transcript, // full conversation so far, rendered
  userMessage,
  recallBlock, // optional material from a [[recall]]/[[consult]] second pass
  wrapAskNote, // when set, this reply should ASK about wrapping up (close phase "ask")
  closingNote, // when set, this reply should wind the exchange down (close phase "begin")
}) {
  const parts = [];

  if (safetyDirective) {
    parts.push(`!!!!! ${safetyDirective} !!!!!`);
  }

  parts.push(system);
  if (toneDirective) parts.push(section("TONE CALIBRATION (how the person wants you to deliver)", toneDirective));
  parts.push(section("AGENT-CORE (your operating manual)", agentCore));

  if (skillBody) {
    parts.push(section(`ACTIVE SKILL: ${activeSkillName}`, skillBody));
  } else {
    parts.push(
      section(
        "ACTIVE SKILL",
        "(none active this turn — stay in the warm agent-core stance; reflect and listen, don't force a framework)"
      )
    );
  }
  if (referenceBody) {
    parts.push(section(`REFERENCE (${activeSkillName}/${referenceName})`, referenceBody));
  }

  parts.push(section("WHAT YOU KNOW ABOUT THIS PERSON (profile)", profileBlock));
  parts.push(section("TIME CONTEXT (server-computed — trust these dates, never recompute them)", timeBlock));
  parts.push(section("WHAT WE'RE NOTICING TOGETHER (working hypotheses — hold lightly, test, don't confirm)", understandingBlock));
  parts.push(section("HOMEWORK THEY'RE CARRYING (things they agreed to notice, try, or reflect on — and whether offering more is appropriate)", assignmentsBlock));
  parts.push(section("EXPERIMENTS (running / proposed — and whether proposing is appropriate)", experimentsBlock));
  parts.push(
    section(
      "PAST SESSIONS TOUCHING THIS LENS (the referential network — follow a thread only if it helps)",
      skillHistoryBlock
    )
  );

  if (recallBlock) {
    parts.push(section("RELEVANT PAST CONTEXT (woven in silently if it helps)", recallBlock));
  }

  parts.push(section("CONVERSATION SO FAR", transcript));
  parts.push(section("THE PERSON'S NEW MESSAGE", userMessage));
  if (wrapAskNote) parts.push(section("WRAP-UP CHECK (ask, don't wind down)", wrapAskNote));
  if (closingNote) parts.push(section("CLOSING NOTE (wind this reply down)", closingNote));
  parts.push(
    "\n\nReply now as the companion — speak DIRECTLY to them in the second person (\"you\"), warm and plain," +
      " one idea at a time. Your first words are the actual thing you'd say. Never describe them in the third" +
      " person and never narrate your plan or intentions; output only what you'd say aloud." +
      " Break the reply into 1–4 short messages separated by a line containing only [NEXT]."
  );

  return parts.filter(Boolean).join("");
}

module.exports = { buildRespondPrompt };
