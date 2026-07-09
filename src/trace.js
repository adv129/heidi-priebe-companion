/*
 * Debug trace log (src/trace.js).
 *
 * Appends one JSON line per LLM call (and a per-turn summary) to logs/trace.jsonl
 * so you can analyze exactly what's sent to the model, what comes back, which
 * lens/recall/consult was chosen, and how long each call took.
 *
 * On by default; set HP_TRACE=0 to disable. The log contains conversation text,
 * so it's gitignored (same sensitivity as memory/).
 *
 * Inspect it:  tail -f logs/trace.jsonl | jq
 *              jq 'select(.label=="respond")' logs/trace.jsonl
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_PATH = path.join(LOG_DIR, "trace.jsonl");
const ENABLED = process.env.HP_TRACE !== "0";

function log(record) {
  if (!ENABLED) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n");
  } catch { /* tracing must never break a turn */ }
}

module.exports = { log, ENABLED, LOG_DIR, LOG_PATH };
