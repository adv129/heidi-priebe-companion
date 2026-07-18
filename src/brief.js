/*
 * Heidi Priebe Agent — Therapist briefs (src/brief.js).
 *
 * A brief is a document the person composes and sends to their real-world
 * therapist: preset-based ("first-meeting" intro or windowed "pre-session"
 * update), section/item-toggleable, opened by an AI narrative they review.
 *
 * This module owns:
 *   memory/briefs.json        saved briefs (immutable snapshots of what was sent)
 *   composeBrief(selection)   the ONE place the shared dataset is filtered —
 *                             both the rendered document and the narrative
 *                             digest are built from the same composed object,
 *                             so an excluded item can never leak into prose.
 *   digestForNarrative(data)  plain-text digest of the composed (already
 *                             filtered) data for the narrative prompt.
 *
 * Reads are pure; the only write is saveBrief() when the person saves.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const memory = require("./memory");
const journey = require("./journey");
const ta = require("./timeaware");

const BRIEFS_PATH = path.join(memory.MEM_DIR, "briefs.json");

const PRESETS = ["first-meeting", "pre-session"];
const HORIZON_DAYS = 30;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const PROVENANCE = "Prepared by the client from self-reported data recorded in a reflective companion app. The opening narrative is AI-composed and was reviewed by the client. Nothing here is a diagnosis.";
const FOOTER = "Self-reported data via a companion app — not a clinical record.";

// --- Store -------------------------------------------------------------------

function loadBriefs() {
  try { return { version: 1, briefs: [], ...JSON.parse(fs.readFileSync(BRIEFS_PATH, "utf8")) }; }
  catch { return { version: 1, briefs: [] }; }
}
function saveBriefs(d) {
  memory.ensureDirs();
  fs.writeFileSync(BRIEFS_PATH, JSON.stringify(d, null, 2) + "\n");
  return d;
}

/** Meta list for the briefs home (no data/narrative bodies). */
function listBriefs() {
  return loadBriefs().briefs
    .map((b) => ({ id: b.id, at: b.at, preset: b.preset, windowStart: b.windowStart, sections: b.sections, hasNarrative: !!b.narrative }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function getBrief(id) {
  return loadBriefs().briefs.find((b) => b.id === id) || null;
}

/**
 * Persist a brief. `data` is re-composed HERE from the selection (never trusted
 * from the client) so the snapshot always matches what the filters produce.
 */
function saveBrief({ preset, windowStart = null, sections = [], excluded = {}, narrative = null, narrativeEdited = false } = {}, now = new Date()) {
  if (!PRESETS.includes(preset)) return null;
  const store = loadBriefs();
  const brief = {
    id: memory.newId("brief", store.briefs.map((b) => b.id)),
    at: memory.stamp().id,
    preset,
    windowStart: preset === "pre-session" ? windowStart : null,
    sections: Array.isArray(sections) ? sections : [],
    excluded: excluded && typeof excluded === "object" ? excluded : {},
    narrative: narrative ? String(narrative) : null,
    narrativeEdited: !!narrativeEdited,
    data: composeBrief({ preset, windowStart, sections, excluded }, now),
  };
  store.briefs.push(brief);
  saveBriefs(store);
  return brief;
}

function deleteBrief(id) {
  const store = loadBriefs();
  const before = store.briefs.length;
  store.briefs = store.briefs.filter((b) => b.id !== id);
  if (store.briefs.length !== before) saveBriefs(store);
  return { ok: store.briefs.length !== before };
}

function wipe() {
  try { fs.unlinkSync(BRIEFS_PATH); } catch {}
  return { ok: true };
}

/**
 * Default pre-session window: date of the most recent pre-session brief →
 * else most recent brief of any preset (a first-meeting brief is a legitimate
 * "the therapist is caught up to here" moment) → else one month back.
 */
function defaultWindowStart(now = new Date()) {
  const briefs = listBriefs();
  const last = briefs.find((b) => b.preset === "pre-session") || briefs[0] || null;
  if (last) return { windowStart: String(last.at).slice(0, 10), source: "last-brief", lastBriefAt: last.at };
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  return { windowStart: ta.shortDate(d), source: "default-month", lastBriefAt: null };
}

// --- Windowing ---------------------------------------------------------------

/** Stamps (2026-07-10T14-22-01) and YYYY-MM-DD both sort lexicographically by date. */
function inWindow(at, windowStart) {
  if (!windowStart) return true;
  if (!at) return false;
  return String(at).slice(0, 10) >= String(windowStart).slice(0, 10);
}

function longDate(when) {
  const d = ta.parseWhen(when);
  if (!d) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Trim to n chars on a soft edge, with an ellipsis. */
function trimTo(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

// --- Small renderers ----------------------------------------------------------

const READINESS_LABELS = {
  "venting": "space to be heard",
  "wants insight": "understanding themselves better",
  "wants tools": "practical tools",
  "wants challenge": "being gently challenged",
};

function humanizeReadiness(readiness) {
  if (!readiness) return "";
  const parts = String(readiness).split(/[>,]/).map((s) => s.trim()).filter(Boolean)
    .map((s) => READINESS_LABELS[s] || s);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return `first: ${parts[0]}; then: ${parts.slice(1).join(", ")}`;
}

const GOAL_STATUS_WORDS = { active: "active", progressing: "making progress", stalled: "stalled", achieved: "achieved" };
const MOVE_ARROWS = { forward: "↑", holding: "→", backward: "↓" };
const WORKING_ON_SUFFIX = /\s*\(a relationship they(?:'|’)re working on\)\s*$/i;

function goalMovementLine(g, now) {
  const arrows = (g.progress || []).map((pr) => MOVE_ARROWS[pr.movement] || "→").join(" ");
  const last = g.progress && g.progress.length ? g.progress[g.progress.length - 1] : null;
  if (!arrows) return "";
  return `${arrows} · last movement ${ta.relPhrase(last.at, now)}`;
}

function evLine(e) {
  return { note: e.note, date: String(e.at).slice(0, 10) };
}

const HYP_BRIEF_ORDER = { supported: 0, testing: 1, revised: 2, forming: 3 };

function prettySkill(s) {
  return String(s || "").replace(/-/g, " ");
}

// --- Section composers ---------------------------------------------------------

function hypothesisItem(h, now, windowStart) {
  const item = {
    id: h.id,
    statement: h.statement,
    status: h.status,
    confidence: h.confidence,
    sinceRel: ta.relPhrase(h.createdAt, now),
    votes: h.votes && (h.votes.up || h.votes.down) ? { up: h.votes.up || 0, down: h.votes.down || 0 } : null,
    evidenceFor: [],
    evidenceAgainst: [],
    change: null,
    revisionNote: null,
  };
  const ev = windowStart ? h.evidence.filter((e) => inWindow(e.at, windowStart)) : h.evidence;
  item.evidenceFor = ev.filter((e) => e.kind !== "against").slice(-2).reverse().map(evLine);
  item.evidenceAgainst = ev.filter((e) => e.kind === "against").slice(-2).reverse().map(evLine);
  const lastRev = h.revisions && h.revisions.length ? h.revisions[h.revisions.length - 1] : null;
  if (lastRev && (!windowStart || inWindow(lastRev.at, windowStart))) {
    item.revisionNote = `previously worded: "${lastRev.from}"${lastRev.why ? ` — revised because ${lastRev.why}` : ""}`;
  }
  if (windowStart) {
    if (inWindow(h.createdAt, windowStart)) item.change = "new this period";
    else if (h.statusChangedAt && inWindow(h.statusChangedAt, windowStart)) item.change = `status is now "${h.status}"`;
    else if (item.revisionNote) item.change = "rewritten this period";
  }
  return item;
}

// Pre-session line caps: the whole document should stay a 1–2 page read.
const UNDERSTANDING_CAP = 6;
const HAPPENED_CAP = 8;
const PROGRESS_CAP = 10;

/**
 * One line per hypothesis for the pre-session "How the picture has changed"
 * section: statement + status, confidence direction only if it moved this
 * period, and a revision clause only if the window contains one. No evidence
 * dumps, no votes — the therapist gets the movement, not the ledger.
 */
function understandingLine(h, win) {
  let line = `${h.statement} — ${h.status}`;
  if (h.confidenceTrend && h.confidenceChangedAt && inWindow(h.confidenceChangedAt, win)) {
    line += `, confidence ${h.confidenceTrend}`;
  }
  const revs = (h.revisions || []).filter((r) => inWindow(r.at, win));
  if (revs.length) {
    const r = revs[revs.length - 1];
    line += r.why ? ` · new: revised after “${trimTo(r.why, 80)}”` : ` · new: revised from “${trimTo(r.from, 80)}”`;
  }
  return line;
}

/** A hypothesis was touched in the window if anything on it is dated inside it. */
function hypTouched(h, windowStart) {
  return inWindow(h.createdAt, windowStart) ||
    (h.statusChangedAt && inWindow(h.statusChangedAt, windowStart)) ||
    (h.evidence || []).some((e) => inWindow(e.at, windowStart)) ||
    (h.revisions || []).some((r) => inWindow(r.at, windowStart));
}

function excludeIds(items, excludedList) {
  const ex = new Set(Array.isArray(excludedList) ? excludedList.map(String) : []);
  return items.filter((it) => !ex.has(String(it.id)));
}

/**
 * Compose the full brief dataset for a selection. This is the single filter
 * point: exclusions and the window are applied HERE, and everything downstream
 * (UI render, narrative digest, saved snapshot) consumes the result.
 *
 * selection: { preset, windowStart, sections (keys to include; empty = all),
 *              excluded: { <sectionKey>: [itemIds] } }
 *
 * Returns { preset, windowStart, header, provenance, footer, sections: [
 *   { key, title, defaultOn, ...data } ] } — sections in document order, with
 * empty ones included (the composer needs them to show "(nothing here)").
 */
function composeBrief({ preset, windowStart = null, sections = null, excluded = {} } = {}, now = new Date()) {
  if (!PRESETS.includes(preset)) return null;
  const win = preset === "pre-session" ? (windowStart || defaultWindowStart(now).windowStart) : null;
  excluded = excluded && typeof excluded === "object" ? excluded : {};

  const profile = memory.loadProfile();
  const allSessions = memory.listSessions();
  const jv = journey.journeyView();
  const today = ta.shortDate(now);

  const out = {
    preset,
    windowStart: win,
    header: {
      title: preset === "first-meeting" ? "Therapist brief — First-meeting introduction" : "Therapist brief — Pre-session update",
      clientName: profile.name || "",
      prepared: `Prepared ${longDate(now)}`,
      windowLine: win ? `Covering ${longDate(win)} – today (since ${ta.relPhrase(win, now)})` : "",
    },
    provenance: PROVENANCE,
    footer: `${FOOTER} Generated ${longDate(now)}.`,
    sections: [],
  };
  const add = (key, title, defaultOn, data) => out.sections.push({ key, title, defaultOn, ...data });

  // -- flags (shared shape) --
  const flagItems = [
    ...profile.redFlags.map((t, i) => ({ id: `red-${i}`, kind: "flag", text: t })),
    ...profile.childhoodSignals.map((t, i) => ({ id: `cs-${i}`, kind: "childhood", text: t })),
  ];

  if (preset === "first-meeting") {
    add("snapshot", "Who I am", true, {
      lifeContext: profile.lifeContext || "",
      emotionalStyle: profile.emotionalStyle || "",
      relationalContext: profile.relationalContext || "",
      readiness: humanizeReadiness(profile.readiness),
      values: profile.values.slice(),
    });

    add("concerns-goals", "Concerns & goals", true, {
      concerns: profile.presentingConcerns.slice(),
      goals: excludeIds(profile.goals.map((g) => ({
        id: g.id,
        text: g.text,
        statusWord: GOAL_STATUS_WORDS[g.status] || g.status,
        createdRel: ta.relPhrase(g.createdAt, now),
        movement: goalMovementLine(g, now),
      })), excluded["concerns-goals"]),
    });

    add("people", "People in my life", true, {
      people: excludeIds((profile.people || []).map((x) => ({
        id: x.name,
        name: x.name,
        relationship: x.relationship || "",
        notes: String(x.notes || "").replace(WORKING_ON_SUFFIX, ""),
        workingOn: WORKING_ON_SUFFIX.test(String(x.notes || "")),
      })), excluded.people),
    });

    add("history", "Turning points", true, {
      items: excludeIds(profile.history.map((t, i) => ({ id: `h-${i}`, text: t })), excluded.history),
    });

    add("patterns", "Patterns we've been noticing", true, {
      framing: "Working observations co-developed with the client — hypotheses, not conclusions.",
      items: excludeIds(profile.hypotheses
        .filter((h) => h.status !== "retired")
        .sort((a, b) => (HYP_BRIEF_ORDER[a.status] ?? 9) - (HYP_BRIEF_ORDER[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((h) => hypothesisItem(h, now, null)), excluded.patterns),
    });

    add("whathelps", "What helps", true, {
      items: profile.whatHelps.slice(),
      learned: jv.experiments.filter((e) => e.status === "concluded" && e.outcome).map((e) => ({
        id: e.id,
        pattern: e.thePattern,
        replacement: e.theReplacement,
        summary: e.outcome.summary,
        keeping: e.outcome.keeping === true ? "kept" : e.outcome.keeping === false ? "let go" : "adapted",
      })),
    });

    add("flags", "For your awareness", true, {
      note: "",
      items: excludeIds(flagItems, excluded.flags),
    });

    const themes = Object.entries(profile.skillsVisited || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    add("engagement", "How I've used the app", false, {
      sessionCount: allSessions.length,
      firstAt: allSessions.length ? longDate(allSessions[allSessions.length - 1].id) : "",
      lastAt: allSessions.length ? longDate(allSessions[0].id) : "",
      cadence: ta.cadence(allSessions, now),
      themes: themes.map(([name, count]) => ({ name: prettySkill(name), count })),
    });
  } else {
    // -- pre-session update: a 1–2 page, two-minute read with three concerns —
    // how the picture has changed, what happened, and where the movement is.
    // Every item is one line; caps keep the whole document short. No session
    // digests — the therapist gets the update, not the transcript.
    const winSessions = allSessions.filter((s) => inWindow(s.id, win));
    const occurred = jv.events
      .filter((e) => inWindow(e.date, win) && String(e.date) <= today && e.status !== "expired")
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    add("window-summary", "This period", true, {
      alwaysOn: true,
      line: `Since ${longDate(win)} (${ta.relPhrase(win, now)}): ${winSessions.length} session${winSessions.length === 1 ? "" : "s"} held.`,
    });

    add("understanding", "How the picture has changed", true, {
      framing: "Working observations co-developed with the client — hypotheses, not conclusions.",
      items: excludeIds(profile.hypotheses
        .filter((h) => h.status !== "retired" && hypTouched(h, win))
        .sort((a, b) => (HYP_BRIEF_ORDER[a.status] ?? 9) - (HYP_BRIEF_ORDER[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, UNDERSTANDING_CAP)
        .map((h) => ({ id: h.id, line: understandingLine(h, win) })), excluded.understanding),
    });

    const horizon = jv.events.filter((e) => {
      if (e.status !== "upcoming" || String(e.date) <= today) return false;
      const d = ta.dayDiff(e.date, now);
      return d !== null && d >= -HORIZON_DAYS;
    }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    add("happened", "What's happened", true, {
      items: excludeIds([
        ...occurred.map((e) => ({
          id: e.id,
          line: `${e.text} — ${longDate(e.date)}${e.followUp && e.followUp.note ? ` · “${trimTo(e.followUp.note, 80)}”` : ""}`,
        })),
        ...horizon.map((e) => ({
          id: e.id,
          line: `${e.text} — ${e.confidence === "approx" ? "around " : ""}${longDate(e.date)} (upcoming)`,
        })),
      ].slice(0, HAPPENED_CAP), excluded.happened),
    });

    const goalItems = profile.goals
      .filter((g) => (g.progress || []).some((pr) => inWindow(pr.at, win)))
      .map((g) => {
        const moves = g.progress.filter((pr) => inWindow(pr.at, win));
        const last = moves[moves.length - 1];
        return { id: g.id, line: `${g.text}: ${last.movement}${last.note ? ` — ${trimTo(last.note, 100)}` : ""}` };
      });
    const expItems = jv.experiments
      .filter((e) => inWindow(e.startedAt, win) || (e.checkIns || []).some((c) => inWindow(c.at, win)) || (e.outcome && inWindow(e.outcome.at, win)))
      .map((e) => {
        const cs = (e.checkIns || []).filter((c) => inWindow(c.at, win));
        const state = e.outcome && inWindow(e.outcome.at, win)
          ? `concluded: ${trimTo(e.outcome.summary, 100)}`
          : cs.length ? cs[cs.length - 1].verdict : "no check-in yet";
        return { id: e.id, line: `Trying ${e.theReplacement} instead of ${e.thePattern} — ${state}` };
      });
    const hwItems = memory.getAssignments()
      .filter((a) => inWindow(a.givenAt, win) || (a.report && inWindow(a.report.at, win)))
      .map((a) => ({
        id: a.id,
        line: `${a.type || "notice"}: “${a.text}” — ${a.report && a.report.findings ? `reported: ${trimTo(a.report.findings, 100)}` : a.status === "dropped" ? "set aside" : "still open"}`,
      }));
    add("progress", "Progress & practice", true, {
      items: excludeIds([...goalItems, ...expItems, ...hwItems].slice(0, PROGRESS_CAP), excluded.progress),
    });

    add("flags", "For your awareness", true, {
      note: "On record from the whole journey — these items aren't dated to this period.",
      items: excludeIds(flagItems, excluded.flags),
    });
  }

  // Apply the section selection last: keep only chosen sections (always-on ones stay).
  if (Array.isArray(sections) && sections.length) {
    const keep = new Set(sections);
    out.sections = out.sections.filter((s) => keep.has(s.key) || s.alwaysOn);
  }

  return out;
}

// --- Narrative digest -----------------------------------------------------------

/**
 * Plain-text digest of a COMPOSED (already filtered) brief for the narrative
 * prompt. Built only from what composeBrief returned — never from the stores —
 * so excluded items structurally cannot appear.
 */
function digestForNarrative(composed) {
  if (!composed) return "";
  const L = [];
  const S = (title) => L.push(`\n== ${title} ==`);

  for (const sec of composed.sections) {
    switch (sec.key) {
      case "snapshot": {
        S("Who they are");
        if (sec.lifeContext) L.push(`Life context: ${sec.lifeContext}`);
        if (sec.emotionalStyle) L.push(`How they handle feelings: ${sec.emotionalStyle}`);
        if (sec.relationalContext) L.push(`Relational world: ${sec.relationalContext}`);
        if (sec.readiness) L.push(`What they want from this work: ${sec.readiness}`);
        if (sec.values.length) L.push(`Values: ${sec.values.join("; ")}`);
        break;
      }
      case "concerns-goals": {
        S("Concerns and goals");
        for (const c of sec.concerns) L.push(`Concern: ${c}`);
        for (const g of sec.goals) L.push(`Goal: ${g.text} (${g.statusWord}${g.movement ? `; ${g.movement}` : ""})`);
        break;
      }
      case "people": {
        if (!sec.people.length) break;
        S("Key people");
        for (const x of sec.people) L.push(`- ${x.name}${x.relationship ? ` (${x.relationship})` : ""}${x.notes ? `: ${x.notes}` : ""}${x.workingOn ? " [a relationship they're actively working on]" : ""}`);
        break;
      }
      case "history": {
        if (!sec.items.length) break;
        S("Turning points");
        for (const it of sec.items) L.push(`- ${it.text}`);
        break;
      }
      case "patterns": {
        if (!sec.items.length) break;
        S("Working observations (hypotheses co-held with the client, NOT conclusions)");
        for (const h of sec.items) {
          L.push(`- "${h.statement}" (${h.status}, ${h.confidence} confidence${h.change ? `; ${h.change}` : ""})`);
          for (const e of h.evidenceFor) L.push(`    supporting: ${e.note} (${e.date})`);
          for (const e of h.evidenceAgainst) L.push(`    counter: ${e.note} (${e.date})`);
          if (h.votes) L.push(`    client's own read: endorsed ${h.votes.up}x, rejected ${h.votes.down}x`);
          if (h.revisionNote) L.push(`    ${h.revisionNote}`);
        }
        break;
      }
      case "whathelps": {
        if (!sec.items.length && !sec.learned.length) break;
        S("What helps");
        for (const it of sec.items) L.push(`- ${it}`);
        for (const e of sec.learned) L.push(`- Tried "${e.replacement}" instead of "${e.pattern}" — learned: ${e.summary} (${e.keeping})`);
        break;
      }
      case "flags": {
        if (!sec.items.length) break;
        S("For the therapist's awareness");
        for (const it of sec.items) L.push(`- ${it.kind === "childhood" ? "Childhood context they volunteered: " : ""}${it.text}`);
        break;
      }
      case "engagement": {
        S("App engagement");
        L.push(`${sec.sessionCount} sessions${sec.firstAt ? ` between ${sec.firstAt} and ${sec.lastAt}` : ""}${sec.cadence ? `, ${sec.cadence}` : ""}.`);
        if (sec.themes.length) L.push(`Themes most often touched: ${sec.themes.map((t) => `${t.name} (${t.count}x)`).join(", ")}`);
        break;
      }
      case "window-summary": {
        L.push(sec.line);
        break;
      }
      case "understanding": {
        if (!sec.items.length) break;
        S("How the picture has changed (working observations co-held with the client, NOT conclusions)");
        for (const it of sec.items) L.push(`- ${it.line}`);
        break;
      }
      case "happened": {
        if (!sec.items.length) break;
        S("What's happened in their life");
        for (const it of sec.items) L.push(`- ${it.line}`);
        break;
      }
      case "progress": {
        if (!sec.items.length) break;
        S("Progress & practice (goal movement, experiments, homework)");
        for (const it of sec.items) L.push(`- ${it.line}`);
        break;
      }
      case "sessions": { // legacy pre-session shape (kept for old saved briefs)
        if (!sec.weeks.length) break;
        S("Sessions this period");
        for (const wk of sec.weeks) {
          L.push(`${wk.label}:`);
          for (const s of wk.items) {
            L.push(`- ${s.date}${s.mode === "explore" ? " (explore session)" : ""}: ${s.title} — ${s.summary}`);
            for (const ins of s.insights) L.push(`    insight: ${ins}`);
          }
        }
        break;
      }
      case "goals": {
        if (!sec.items.length) break;
        S("Goal movement this period");
        for (const g of sec.items) {
          L.push(`- ${g.text} (${g.statusWord}${g.isNew ? "; new this period" : ""})`);
          for (const m of g.moves) L.push(`    ${m.movement}${m.note ? `: ${m.note}` : ""} (${m.date})`);
        }
        break;
      }
      case "experiments": {
        if (!sec.items.length) break;
        S("Experiments this period");
        for (const e of sec.items) {
          L.push(`- Trying "${e.replacement}" instead of "${e.pattern}"${e.startedThisPeriod ? " (started this period)" : ""} [${e.status}]`);
          for (const c of e.checkIns) L.push(`    check-in ${c.date}: ${c.note} (${c.verdict})`);
          if (e.outcome) L.push(`    concluded — learned: ${e.outcome.summary} (${e.outcome.keeping})`);
        }
        break;
      }
      case "assignments": {
        if (!sec.items.length) break;
        S("Homework / noticing assignments this period");
        for (const a of sec.items) {
          L.push(`- "${a.text}" (${a.type || "notice"}; given ${a.givenRel}; ${a.status})${a.findings ? ` — reported: ${a.findings}` : ""}`);
        }
        break;
      }
      case "events": {
        if (!sec.occurred.length && !sec.horizon.length) break;
        S("Life events");
        for (const e of sec.occurred) L.push(`- ${e.text} (${e.rel}${e.note ? `; they said: ${e.note}` : ""})`);
        for (const e of sec.horizon) L.push(`- Coming up: ${e.text} (${e.approx ? "around " : ""}${e.date})`);
        break;
      }
    }
  }
  return L.join("\n").trim();
}

module.exports = {
  PRESETS,
  listBriefs,
  getBrief,
  saveBrief,
  deleteBrief,
  wipe,
  defaultWindowStart,
  inWindow,
  composeBrief,
  digestForNarrative,
};
