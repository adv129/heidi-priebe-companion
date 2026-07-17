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
//
// Every spawn gets `--no-session-persistence --tools ""`: the app never uses
// CLI tools, and dropping the tool schemas cuts per-spawn cache-write from
// ~27K to ~6.9K tokens — the single biggest latency/cost lever on this path.
// (Do NOT use --bare: it breaks OAuth and would require an API key.)
function claudePArgs(opts = {}) {
  const conf = (opts.config && opts.config["claude-p"]) || {};
  const model = (conf.models && conf.models[opts.kind]) || conf.model;
  const args = ["-p"];
  if (model) args.push("--model", model);
  return { args, model };
}

function claudeP(prompt, opts = {}) {
  const { args } = claudePArgs(opts);
  return runCli("claude", [...args, "--no-session-persistence", "--tools", ""])(prompt);
}

// Streaming variant: `--output-format stream-json --include-partial-messages`
// emits JSONL — text deltas as they're written plus a final authoritative
// {"type":"result","result":"…"} line. Thinking deltas DO occur and are
// filtered out; only text_delta reaches onDelta. Per-line JSON.parse is
// try/caught so shape drift across CLI versions degrades to the result line
// (or the accumulated deltas) instead of breaking the turn.
function claudePStream(prompt, opts = {}, onDelta) {
  const { args, model } = claudePArgs(opts);
  const fullArgs = [
    ...args,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
    "--tools", "",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", fullArgs, { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";          // trailing partial line kept across data events
    let accumulated = "";  // all text deltas, fallback if no result line
    let resultText = null; // the authoritative final result
    let resultError = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // skip non-JSON / partial lines
      if (msg.type === "stream_event") {
        const delta = msg.event && msg.event.delta;
        if (delta && delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          accumulated += delta.text;
          if (onDelta) { try { onDelta(delta.text); } catch { /* consumer errors never kill the stream */ } }
        }
      } else if (msg.type === "result") {
        if (msg.is_error) resultError = new Error(`claude -p: ${typeof msg.result === "string" ? msg.result : msg.subtype || "error result"}`);
        else if (typeof msg.result === "string") resultText = msg.result;
        if (opts.usageSink) {
          if (model) opts.usageSink.model = model;
          if (msg.usage) opts.usageSink.tokens = msg.usage;
          if (typeof msg.total_cost_usd === "number") opts.usageSink.costUsd = msg.total_cost_usd;
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf) handleLine(buf);
      if (resultError) return reject(resultError);
      const text = (resultText != null ? resultText : accumulated).trim();
      if (code !== 0 && !text) return reject(new Error(`claude exited with code ${code}`));
      if (!text) return reject(new Error("claude -p: empty completion"));
      resolve(text);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
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
  "explore-respond":  { model: "claude-sonnet-5", maxTokens: 2048 },
  "explore-opener":   { model: "claude-opus-4-8", maxTokens: 1024 },
  consolidate:        { model: "claude-opus-4-8", maxTokens: 8192 },
  "onboard-extract":  { model: "claude-opus-4-8", maxTokens: 4096 },
  "onboard-followup": { model: "claude-sonnet-5", maxTokens: 1024 },
  brief:              { model: "claude-opus-4-8", maxTokens: 2048 },
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

// --- Adapter: Anthropic Messages API, streaming ---------------------------
// Identical request body to anthropic() plus stream:true; hand-parsed SSE
// (zero-dependency: getReader + TextDecoder, frames split on \n\n).
async function anthropicStream(prompt, opts = {}, onDelta) {
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
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const usage = {}; // message_start carries input/cache tokens; message_delta carries output tokens

  const handleFrame = (frame) => {
    const payload = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!payload || payload === "[DONE]") return;
    let ev;
    try { ev = JSON.parse(payload); } catch { return; }
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
      text += ev.delta.text;
      if (onDelta) { try { onDelta(ev.delta.text); } catch { /* consumer errors never kill the stream */ } }
    } else if (ev.type === "message_start" && ev.message && ev.message.usage) {
      Object.assign(usage, ev.message.usage);
    } else if (ev.type === "message_delta") {
      if (ev.usage) Object.assign(usage, ev.usage);
      if (ev.delta && ev.delta.stop_reason === "refusal") throw new Error("anthropic: request refused");
    } else if (ev.type === "error") {
      throw new Error(`anthropic stream: ${(ev.error && ev.error.message) || "unknown error"}`);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleFrame(buf);

  if (opts.usageSink) {
    opts.usageSink.model = model;
    opts.usageSink.tokens = Object.keys(usage).length ? usage : null;
    opts.usageSink.costUsd = anthropicCost(model, usage);
  }
  const out = text.trim();
  if (!out) throw new Error("anthropic: empty completion");
  return out;
}

const ADAPTERS = {
  "claude-p": claudeP,
  openrouter,
  anthropic,
};

// Providers with a real streaming path. Everything else (openrouter, …) falls
// back to complete() + a single onDelta carrying the whole reply.
const STREAM_ADAPTERS = {
  "claude-p": claudePStream,
  anthropic: anthropicStream,
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

/**
 * completeStream(prompt, opts, onDelta) -> Promise<fullText>
 * onDelta(textFragment) fires per text delta as the model writes. Providers
 * without a streaming adapter resolve via complete() and fire onDelta once
 * with the whole reply, so callers can treat every provider uniformly.
 */
async function completeStream(prompt, opts = {}, onDelta) {
  const provider = opts.provider || "claude-p";
  const fn = STREAM_ADAPTERS[provider];
  if (fn) return fn(prompt, opts, onDelta);
  const text = await complete(prompt, opts);
  if (onDelta) { try { onDelta(text); } catch { /* consumer errors never kill the call */ } }
  return text;
}

module.exports = { complete, completeStream, ADAPTERS };
