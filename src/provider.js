/*
 * Heidi Priebe Agent — Provider seam (src/provider.js).
 *
 * The whole app needs exactly one capability from an LLM:
 *     complete(prompt) -> text
 *
 * Each backend is a small adapter behind that interface. Default is Claude Code
 * headless (`claude -p`, no API key — uses the user's existing login). The core
 * loop never names a provider; it calls complete() and config picks the adapter.
 *
 * Ported from the Builder Log Agent's provider seam.
 */

"use strict";

const { spawn } = require("child_process");

// Run a CLI agent headlessly: pipe the prompt to stdin, capture stdout.
function runCli(cmd, args) {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited with code ${code}`))
      );
      child.stdin.write(prompt);
      child.stdin.end();
    });
}

// --- Adapter: Claude Code headless (`claude -p`) -------------------------
// Uses the user's existing Claude Code login. No API key, no SDK.
// Optional model pin via config["claude-p"]: a single { model } applies to every
// call, or { models: { <kind>: id } } overrides per call kind. With neither set,
// runs bare `claude -p` (whatever the login resolves — currently Opus 4.8).
function claudeP(prompt, opts = {}) {
  const conf = (opts.config && opts.config["claude-p"]) || {};
  const model = (conf.models && conf.models[opts.kind]) || conf.model;
  const args = ["-p"];
  if (model) args.push("--model", model);
  return runCli("claude", args)(prompt);
}

// --- Adapter: OpenRouter / raw API key ----------------------------------
// A single chat completion over HTTPS. Key from env OPENROUTER_API_KEY; model
// from config.openrouter.model. The core loop owns all orchestration, so one
// call is all we need.
async function openrouter(prompt, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  const model = opts.config?.openrouter?.model || "openai/gpt-4o-mini";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "Heidi Priebe Agent",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("openrouter: empty completion");
  return text.trim();
}

// --- Adapter: Anthropic Messages API (direct, per-call model) -----------
// A single non-streaming call to the Messages API. Unlike `claude -p`, this
// carries ONLY the app's own prompt — none of Claude Code's built-in agent
// system prompt or tool schemas (~27K tokens/call of pure overhead). It also
// picks a model per call KIND (opts.kind, threaded from core.timedComplete):
// routing/analysis/extraction get Opus 4.8, conversation gets Sonnet. Key from
// env ANTHROPIC_API_KEY. Zero-dependency raw fetch, matching openrouter above.
//
// JSON calls (route/consolidate/onboard-extract) still return JSON as text and
// are parsed by core.parseJsonLoose exactly as with the other providers — no
// structured-outputs schema needed here. (A future hardening step could add
// output_config.format for guaranteed-valid JSON.)

const ANTHROPIC_KINDS = {
  route:              { model: "claude-opus-4-8", maxTokens: 1024 },
  respond:            { model: "claude-sonnet-5", maxTokens: 2048 },
  consolidate:        { model: "claude-opus-4-8", maxTokens: 8192 },
  "onboard-extract":  { model: "claude-opus-4-8", maxTokens: 4096 },
  "onboard-followup": { model: "claude-sonnet-5", maxTokens: 1024 },
};
const ANTHROPIC_DEFAULT = { model: "claude-sonnet-5", maxTokens: 2048 };

// Per-1M-token USD prices (sticker rates; Sonnet has a lower intro rate through
// 2026-08-31 not reflected here — telemetry is a conservative upper bound).
const ANTHROPIC_PRICES = {
  "claude-opus-4-8":   { in: 5, cacheWrite: 6.25, cacheRead: 0.5, out: 25 },
  "claude-opus-4-7":   { in: 5, cacheWrite: 6.25, cacheRead: 0.5, out: 25 },
  "claude-sonnet-5":   { in: 3, cacheWrite: 3.75, cacheRead: 0.3, out: 15 },
  "claude-sonnet-4-6": { in: 3, cacheWrite: 3.75, cacheRead: 0.3, out: 15 },
  "claude-haiku-4-5":  { in: 1, cacheWrite: 1.25, cacheRead: 0.1, out: 5 },
};

function anthropicCost(model, u) {
  const p = ANTHROPIC_PRICES[model];
  if (!p || !u) return null;
  return (
    (u.input_tokens || 0) * p.in +
    (u.cache_creation_input_tokens || 0) * p.cacheWrite +
    (u.cache_read_input_tokens || 0) * p.cacheRead +
    (u.output_tokens || 0) * p.out
  ) / 1e6;
}

async function anthropic(prompt, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const kindCfg = ANTHROPIC_KINDS[opts.kind] || ANTHROPIC_DEFAULT;
  const conf = (opts.config && opts.config.anthropic) || {};
  const model = (conf.models && conf.models[opts.kind]) || kindCfg.model;
  const maxTokens = (conf.maxTokens && conf.maxTokens[opts.kind]) || kindCfg.maxTokens;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    // Thinking off for snappy, predictable turns. No temperature/top_p — those
    // are rejected (400) on Opus 4.8 / Sonnet 5.
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();

  if (data.stop_reason === "refusal") throw new Error("anthropic: request refused");
  // Scan for text blocks (a thinking block can precede the text if ever enabled).
  const text = (data.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("anthropic: empty completion");

  // Real cost telemetry for the trace, if a sink was provided.
  if (opts.usageSink) {
    opts.usageSink.model = model;
    opts.usageSink.tokens = data.usage || null;
    opts.usageSink.costUsd = anthropicCost(model, data.usage);
  }
  return text;
}

const ADAPTERS = {
  "claude-p": claudeP,
  openrouter,
  anthropic,
};

/**
 * complete(prompt, opts) -> Promise<string>
 * opts.provider selects the adapter (default "claude-p").
 * opts.config is passed through so adapters can read model settings.
 */
function complete(prompt, opts = {}) {
  const provider = opts.provider || "claude-p";
  const fn = ADAPTERS[provider];
  if (!fn) throw new Error(`unknown provider: ${provider} (have: ${Object.keys(ADAPTERS).join(", ")})`);
  return fn(prompt, opts);
}

module.exports = { complete, ADAPTERS };
