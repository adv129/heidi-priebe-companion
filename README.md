# Heidi Priebe Agent

A **local-first therapeutic companion**. It holds a natural conversation and applies Heidi
Priebe's psychoeducational frameworks (attachment, toxic shame, self-abandonment, emotional
processing, complex-trauma reparenting, grief, boundaries, self-honesty, personality typology) as
*lenses* — never labels — while remembering you across sessions through a **referential memory
network**.

Modeled on the Builder Log Agent: zero dependencies, no build step, a vanilla-JS front-end served
by a built-in Node HTTP server, and a pluggable LLM provider (defaults to your local Claude Code —
no API key).

> **Not therapy.** This is psychoeducation and self-reflection support, not diagnosis or crisis
> care. In crisis, call your local emergency number (US: 988; UK & ROI: Samaritans 116 123;
> international: findahelpline.com). It is a supplement to — never a substitute for — a licensed
> professional.

## Run it

```bash
cd Heidi_Priebe_Agent
npm start          # boots http://127.0.0.1:4180 and opens your browser
```

Requirements: **Node ≥ 18** and one provider. The default (`claude-p`) needs no key — it uses your
existing Claude Code login. To use OpenRouter instead, `cp .env.example .env`, add
`OPENROUTER_API_KEY`, and pick "OpenRouter" in Settings.

To use the Anthropic API directly (per-token billing, but far cheaper per call than `claude-p` —
it drops the Claude Code agent scaffolding and picks a model per call kind), set
`"provider": "anthropic"` in `config.json` and add `ANTHROPIC_API_KEY` to `.env`. Models are
configurable per call kind under `config.anthropic.models` (defaults: Opus 4.8 for
routing/consolidation/extraction where analysis matters, Sonnet 5 for conversation).

First launch drops you into a short onboarding (provider → consent → name → what brings you →
review), then into **Talk**.

## How it works

- **Progressive skill loading.** `agent-core` (the orchestrator) is always in context. Each turn a
  cheap *router* call picks at most one topical skill; only that skill's `SKILL.md` is loaded, and a
  `references/` deep-dive only when the conversation narrows to it.
- **Referential memory network** (`memory/graph.json` + `memory/sessions/*.md`). When a skill
  activates, the companion sees prior sessions that used the same lens — each tagged with the *other*
  skills that session touched, so linked threads (e.g. a past relationship chat that also touched
  shame) surface and can be followed on demand.
- **An understanding loop.** Besides regular Talk sessions there are **Explore sessions** —
  deliberate get-to-know-you conversations (start one from the chip on the Talk home, or accept the
  companion's mid-chat offer). What it learns becomes **transparent working hypotheses** ("things
  we're noticing together") with visible evidence for *and against*, revision history, and a
  "that's not me" veto — plus small **noticing assignments** you can report back on next session.
- **A time sense.** Every prompt carries server-computed time context (days since last session,
  dated life events you mentioned, aging assignments), so the companion can ask how the interview
  went — once, lightly — and the **Journey** tab shows the whole arc on a timeline.
- **An experiments loop.** Once a pattern is confirmed *with you* and you want change, you co-design
  small experiments (a new response in place of the old pattern) with honest check-ins — tracked on
  the Journey tab, framed as curiosity, never pass/fail.
- **Therapist briefs.** The Therapist view composes a print-ready document to send to a real-world
  therapist: pick a preset (**First meeting intro** or a windowed **Pre-session update**, defaulting
  to "since your last brief"), untick any section or individual item you'd rather keep private, and
  an AI narrative opens the document — built only from what you ticked, reviewed and editable before
  anything is saved. Saved briefs are immutable snapshots (`memory/briefs.json`) you can reopen and
  reprint. (Chromium's Save-as-PDF gives the cleanest output; the per-page footer may print
  last-page-only in Firefox.)
- **Safety first.** A crisis pre-check plus always-on safety instructions suspend framework work and
  surface real-world resources when needed.

## Layout

```
src/       server.js · core.js (turn pipeline) · provider.js · skills.js · memory.js
           journey.js (experiments + timeline stores) · brief.js (therapist briefs)
           timeaware.js (time context) · safety.js · templates/
public/    index.html · app.js · style.css   (the SPA: Talk · Journey · Settings · Therapist)
skills/    the knowledge base (one folder per skill: SKILL.md + references/)
skills.json  machine-readable manifest (regenerate: npm run manifest)
memory/    profile.json (incl. hypotheses + assignments) · graph.json · sessions/
           experiments.json · timeline.json · briefs.json   (local, gitignored, sensitive)
```

## Privacy

Everything you share is stored **locally** under `memory/` so the companion can remember across
sessions. The server binds to `127.0.0.1` only. Delete any session — or wipe everything — from the
Memory and Settings screens. Your conversation text is sent to whichever model provider you choose
(with `claude-p`, that's your own Claude Code).
