/*
 * Heidi Priebe Agent — Local web server (src/server.js).
 *
 * Zero-dependency Node http server bound to 127.0.0.1 only (single-user,
 * sensitive personal data — never 0.0.0.0). Serves the SPA in public/ and a
 * small JSON API over the engine in core.js.
 *
 * Start:   node src/server.js
 * Options: --no-open   skip auto-opening the browser
 * Env:     PORT        override default port (4180)
 *          CI          skip auto-open when set
 */

"use strict";

// ─── .env loader (before any other require reads process.env) ────────────────

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

if (fs.existsSync(ENV_PATH)) {
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* non-fatal */ }
}

// ─── Requires ────────────────────────────────────────────────────────────────

const http = require("http");
const { spawn } = require("child_process");

const core = require("./core");
const skills = require("./skills");
const memory = require("./memory");
const journey = require("./journey");
const brief = require("./brief");
const T = require("./templates");

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = parseInt(process.env.PORT || "4180", 10);
const MAX_PORT_TRIES = 10;
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
};

const NO_OPEN = process.argv.includes("--no-open");
let busy = false; // serialize chat/consolidate so turns don't race on current.json

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function apiError(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) {
      deepMerge(dst[k], v);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Static files ─────────────────────────────────────────────────────────
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    const filePath =
      pathname === "/" || pathname === ""
        ? path.join(PUBLIC_DIR, "index.html")
        : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ""));
    const rel = path.relative(PUBLIC_DIR, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) { apiError(res, 400, "invalid path"); return; }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": content.length,
        // Local single-user app: never let the browser hold stale app code —
        // a plain reload must always pick up the latest js/css.
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      apiError(res, 404, "not found");
    }
    return;
  }

  // ── GET /api/config ────────────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/config") {
    json(res, 200, core.loadConfig() || {});
    return;
  }

  // ── POST /api/config — onboarding save + validate + seed profile ────────────
  if (req.method === "POST" && pathname === "/api/config") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
    if (typeof body !== "object" || body === null || Array.isArray(body)) { apiError(res, 400, "body must be an object"); return; }

    const cfg = core.loadConfig() || {};
    deepMerge(cfg, body);

    // Conversation length (user.wrapAfter) is clamped on write so the stored
    // value is always the one the engine will actually use (20–60, default 45).
    if (cfg.user && cfg.user.wrapAfter !== undefined) cfg.user.wrapAfter = core.wrapAskThreshold(cfg);

    const REQUIRED = [!!(cfg.user && cfg.user.name), cfg.consentAcknowledged === true];
    const complete = REQUIRED.every(Boolean);
    if (complete) cfg.setupComplete = true;
    core.saveConfig(cfg);

    // Seed / refresh the profile from intake whenever we have a name.
    if (cfg.user && cfg.user.name) memory.seedProfileFromOnboarding(cfg.user);

    json(res, 200, { ok: true, config: cfg, setupComplete: !!cfg.setupComplete });
    return;
  }

  // ── GET /api/providers ───────────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/providers") {
    json(res, 200, [
      { id: "claude-p", label: "Claude Code (claude -p)", needsKey: false, available: true, recommended: true },
      { id: "openrouter", label: "OpenRouter", needsKey: true, available: !!process.env.OPENROUTER_API_KEY },
    ]);
    return;
  }

  // ── GET /api/skills — the manifest (debug / "what I know") ───────────────────
  if (req.method === "GET" && pathname === "/api/skills") {
    json(res, 200, skills.loadManifest({ fresh: true }));
    return;
  }

  // ── GET /api/session — current session status ────────────────────────────────
  if (req.method === "GET" && pathname === "/api/session") {
    json(res, 200, core.currentSessionView());
    return;
  }

  // ── GET /api/onboard/options — MC options + conversational section defs ───────
  if (req.method === "GET" && pathname === "/api/onboard/options") {
    json(res, 200, { mc: T.MC, sections: T.SECTIONS });
    return;
  }

  // ── GET /api/opener — the opening message/chips for a new chat ────────────────
  if (req.method === "GET" && pathname === "/api/opener") {
    json(res, 200, core.getOpener(core.loadConfig() || {}));
    return;
  }

  // ── POST /api/onboard/chat — one warm follow-up in a conversational section ────
  if (req.method === "POST" && pathname === "/api/onboard/chat") {
    if (busy) { apiError(res, 409, "busy"); return; }
    busy = true;
    try {
      let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
      const reply = await core.onboardChat(body.title || body.section, body.messages || [], body.final === true);
      json(res, 200, { reply });
    } catch (e) { if (!res.headersSent) apiError(res, 500, e.message); }
    finally { busy = false; }
    return;
  }

  // ── POST /api/onboard/finish — extract onboarding into the profile ─────────────
  if (req.method === "POST" && pathname === "/api/onboard/finish") {
    if (busy) { apiError(res, 409, "busy"); return; }
    busy = true;
    try {
      let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
      const result = await core.onboardFinish(body || {});
      json(res, 200, result);
    } catch (e) { if (!res.headersSent) apiError(res, 500, e.message); }
    finally { busy = false; }
    return;
  }

  // ── POST /api/chat — one conversation turn ────────────────────────────────────
  // With `Accept: text/event-stream` the reply streams as SSE bubbles:
  //   event: chunk {i,text} per bubble → event: done {full result} → end.
  // Pre-checks still return plain JSON errors before any SSE headers go out.
  // Without the Accept header it's the original single JSON blob (now
  // including `chunks`).
  if (req.method === "POST" && pathname === "/api/chat") {
    if (busy) { apiError(res, 409, "busy"); return; }
    busy = true;
    try {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) { apiError(res, 400, "message required"); return; }
      const cfg = core.loadConfig();
      if (!cfg || !cfg.setupComplete) { apiError(res, 400, "setup incomplete"); return; }

      if ((req.headers.accept || "").includes("text/event-stream")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
        });
        res.write(": ok\n\n"); // flush headers immediately (proves the stream is live)
        // Late writes after a client disconnect are no-ops via this guard;
        // handleTurn still runs to completion and saves the session either way.
        const sse = (event, data) => {
          if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
          const result = await core.handleTurn(message, { onChunk: (text, i) => sse("chunk", { i, text }) });
          sse("done", result);
        } catch (e) {
          sse("error", { error: e.message });
        } finally {
          if (!res.writableEnded) res.end();
        }
      } else {
        const result = await core.handleTurn(message);
        json(res, 200, result);
      }
    } catch (e) {
      if (!res.headersSent) apiError(res, 500, e.message);
    } finally {
      busy = false;
    }
    return;
  }

  // ── POST /api/session/mode — switch talk↔explore (fresh explore gets an opener) ─
  if (req.method === "POST" && pathname === "/api/session/mode") {
    if (busy) { apiError(res, 409, "busy"); return; }
    busy = true;
    try {
      let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
      const mode = body.mode === "explore" ? "explore" : "talk";
      if (mode === "explore") {
        // A deliberate explore start on an empty session opens with a real
        // question, persisted into the transcript so the model sees it.
        const r = await core.startExploreSession();
        json(res, 200, { ok: true, ...r });
      } else {
        core.setSessionMode(mode);
        json(res, 200, { ok: true, mode });
      }
    } catch (e) { if (!res.headersSent) apiError(res, 500, e.message); }
    finally { busy = false; }
    return;
  }

  // ── POST /api/session/end — snapshot now, consolidate in the background ───────
  // The synchronous part (pending-save snapshot, deterministic closing-ritual
  // writes, clearCurrent) runs under `busy`; the slow consolidate model call is
  // kicked off WITHOUT awaiting and tracked via GET /api/session/save-status.
  // Body (optional): { takeaway, experiment } from the closing ritual — trimmed
  // and length-capped in core. A save already in flight → 409.
  if (req.method === "POST" && pathname === "/api/session/end") {
    if (busy) { apiError(res, 409, "busy"); return; }
    busy = true;
    try {
      let body = {};
      try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch { apiError(res, 400, "invalid JSON"); return; }
      const result = core.endSession({ takeaway: body.takeaway, experiment: body.experiment });
      if (!result.ended && result.reason === "save-in-progress") { apiError(res, 409, "save in progress"); return; }
      if (result.ended) {
        // Fire-and-forget: finishSave records its outcome in the save status
        // and never rejects for normal failures; this catch is a backstop.
        core.finishSave(result.snapshot).catch((e) => console.error(`[save] ${e.message}`));
        json(res, 200, { ended: true, saving: true });
      } else {
        json(res, 200, result);
      }
    } catch (e) {
      if (!res.headersSent) apiError(res, 500, e.message);
    } finally {
      busy = false;
    }
    return;
  }

  // ── GET /api/session/save-status — background-save indicator ──────────────────
  if (req.method === "GET" && pathname === "/api/session/save-status") {
    json(res, 200, core.saveStatusView());
    return;
  }

  // ── GET /api/memory — profile + session graph + journey stores ────────────────
  if (req.method === "GET" && pathname === "/api/memory") {
    json(res, 200, { ...memory.memoryView(), ...journey.journeyView() });
    return;
  }

  // ── GET /api/timeline — the composed journey timeline ─────────────────────────
  if (req.method === "GET" && pathname === "/api/timeline") {
    json(res, 200, { entries: journey.composeTimeline() });
    return;
  }

  // ── POST /api/profile/add — direct additions from the fill-in exercises ──────
  if (req.method === "POST" && pathname === "/api/profile/add") {
    let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
    json(res, 200, memory.addDirect({ people: body.people, goals: body.goals }));
    return;
  }

  // ── POST /api/memory/hypothesis/:id/vote — up ("fits") / down ("doesn't fit")
  const hypMatch = pathname.match(/^\/api\/memory\/hypothesis\/([\w.:-]+)\/vote$/);
  if (req.method === "POST" && hypMatch) {
    let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
    const h = memory.voteHypothesis(hypMatch[1], body.vote);
    if (!h) { apiError(res, 404, "no such hypothesis or invalid vote"); return; }
    json(res, 200, { ok: true, hypothesis: h });
    return;
  }

  // ── GET /api/memory/session/:id ───────────────────────────────────────────────
  const sessMatch = pathname.match(/^\/api\/memory\/session\/([\w.:-]+)$/);
  if (req.method === "GET" && sessMatch) {
    const r = memory.recallSession(sessMatch[1]);
    if (!r) { apiError(res, 404, "no such session"); return; }
    json(res, 200, r);
    return;
  }

  // ── DELETE /api/memory/session/:id ────────────────────────────────────────────
  if (req.method === "DELETE" && sessMatch) {
    json(res, 200, memory.deleteSession(sessMatch[1]));
    return;
  }

  // ── DELETE /api/memory — wipe everything (privacy) ────────────────────────────
  if (req.method === "DELETE" && pathname === "/api/memory") {
    core.clearCurrent();
    journey.wipe();
    brief.wipe();
    json(res, 200, memory.deleteAll());
    return;
  }

  // ── Therapist briefs ──────────────────────────────────────────────────────────

  // GET /api/briefs — meta list for the briefs home (+ the default window)
  if (req.method === "GET" && pathname === "/api/briefs") {
    json(res, 200, { briefs: brief.listBriefs(), defaultWindow: brief.defaultWindowStart() });
    return;
  }

  // POST /api/brief/preview — compose the full (unexcluded) dataset, no persist
  if (req.method === "POST" && pathname === "/api/brief/preview") {
    let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
    const composed = brief.composeBrief({ preset: body.preset, windowStart: body.windowStart || null });
    if (!composed) { apiError(res, 400, "invalid preset"); return; }
    json(res, 200, composed);
    return;
  }

  // POST /api/brief/narrative — one model call over the user-filtered selection
  if (req.method === "POST" && pathname === "/api/brief/narrative") {
    if (busy) { apiError(res, 409, "busy"); return; }
    busy = true;
    try {
      let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
      const narrative = await core.generateBriefNarrative({
        preset: body.preset,
        windowStart: body.windowStart || null,
        sections: body.sections,
        excluded: body.excluded,
      });
      json(res, 200, { narrative });
    } catch (e) { if (!res.headersSent) apiError(res, 502, e.message); }
    finally { busy = false; }
    return;
  }

  // POST /api/brief — persist (data snapshot re-composed server-side)
  if (req.method === "POST" && pathname === "/api/brief") {
    let body; try { body = JSON.parse(await readBody(req)); } catch { apiError(res, 400, "invalid JSON"); return; }
    const saved = brief.saveBrief({
      preset: body.preset,
      windowStart: body.windowStart || null,
      sections: body.sections,
      excluded: body.excluded,
      narrative: body.narrative,
      narrativeEdited: body.narrativeEdited === true,
    });
    if (!saved) { apiError(res, 400, "invalid preset"); return; }
    json(res, 200, { ok: true, id: saved.id });
    return;
  }

  // GET /api/brief/:id — a saved brief (immutable snapshot)
  const briefMatch = pathname.match(/^\/api\/brief\/([\w.:-]+)$/);
  if (req.method === "GET" && briefMatch) {
    const b = brief.getBrief(briefMatch[1]);
    if (!b) { apiError(res, 404, "no such brief"); return; }
    json(res, 200, b);
    return;
  }

  // DELETE /api/brief/:id
  if (req.method === "DELETE" && briefMatch) {
    json(res, 200, brief.deleteBrief(briefMatch[1]));
    return;
  }

  apiError(res, 404, `no route: ${req.method} ${pathname}`);
}

// ─── Browser opener + startup ──────────────────────────────────────────────────

function openBrowser(u) {
  if (process.env.CI || NO_OPEN) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", u] : [u];
  try { spawn(opener, args, { stdio: "ignore", detached: true }).unref(); } catch { /* non-fatal */ }
}

function startServer(port, triesLeft) {
  const server = http.createServer(async (req, res) => {
    try { await handleRequest(req, res); }
    catch (e) { if (!res.headersSent) apiError(res, 500, `internal error: ${e.message}`); }
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && triesLeft > 0) startServer(port + 1, triesLeft - 1);
    else { console.error(`[heidi-agent] Failed to start on port ${port}: ${e.message}`); process.exitCode = 1; }
  });
  server.listen(port, "127.0.0.1", () => {
    const u = `http://127.0.0.1:${port}`;
    console.log(`Heidi Priebe Agent running at ${u}`);
    openBrowser(u);
  });
}

startServer(DEFAULT_PORT, MAX_PORT_TRIES);

// Crash recovery: a leftover memory/pending-save.json means the process died
// mid-save — resume the consolidate in the background (see core.resumePendingSave).
core.resumePendingSave();
