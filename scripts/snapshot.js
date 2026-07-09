#!/usr/bin/env node
/*
 * Dev snapshot tool (scripts/snapshot.js) — NOT part of the app.
 *
 * Back up / restore the runtime state (config.json + memory/) so you can reset to
 * a clean slate for testing WITHOUT losing data. Snapshots live in _snapshots/
 * (gitignored). Zero dependencies.
 *
 *   node scripts/snapshot.js save [label]     # snapshot current state
 *   node scripts/snapshot.js list             # list snapshots
 *   node scripts/snapshot.js restore <name>   # restore a snapshot (auto-backs-up current first)
 *   node scripts/snapshot.js current          # show what's on disk now
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SNAP_DIR = path.join(ROOT, "_snapshots");
const ITEMS = ["config.json", "memory"]; // what counts as "state"

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyInto(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(destDir, item), { recursive: true });
    copied++;
  }
  return copied;
}

function save(label) {
  const name = `${stamp()}${label ? "__" + label.replace(/[^\w.-]/g, "-") : ""}`;
  const dest = path.join(SNAP_DIR, name);
  const n = copyInto(dest);
  if (!n) { console.log("Nothing to snapshot (no config.json or memory/ on disk)."); try { fs.rmdirSync(dest); } catch {} return; }
  console.log(`Saved snapshot: _snapshots/${name}  (${n} item(s))`);
}

function list() {
  if (!fs.existsSync(SNAP_DIR)) { console.log("No snapshots yet."); return; }
  const dirs = fs.readdirSync(SNAP_DIR).filter((d) => fs.statSync(path.join(SNAP_DIR, d)).isDirectory()).sort().reverse();
  if (!dirs.length) { console.log("No snapshots yet."); return; }
  console.log("Snapshots (newest first):");
  for (const d of dirs) {
    let sessions = 0;
    try { sessions = fs.readdirSync(path.join(SNAP_DIR, d, "memory", "sessions")).filter((f) => f.endsWith(".md")).length; } catch {}
    const hasCfg = fs.existsSync(path.join(SNAP_DIR, d, "config.json"));
    console.log(`  ${d}   [${hasCfg ? "config" : "no-config"}, ${sessions} session(s)]`);
  }
}

function restore(name) {
  if (!name) { console.error("Usage: node scripts/snapshot.js restore <name>"); process.exit(1); }
  const src = path.join(SNAP_DIR, name);
  if (!fs.existsSync(src)) {
    // allow prefix match
    const matches = fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR).filter((d) => d.startsWith(name)) : [];
    if (matches.length === 1) return restore(matches[0]);
    console.error(`No snapshot "${name}".` + (matches.length ? ` Did you mean: ${matches.join(", ")}` : " Run `list`.")); process.exit(1);
  }
  // Safety: back up whatever is currently on disk first.
  save("pre-restore");
  for (const item of ITEMS) {
    const from = path.join(src, item), to = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  console.log(`Restored snapshot: ${name}`);
}

function current() {
  const cfg = path.join(ROOT, "config.json");
  let sessions = 0;
  try { sessions = fs.readdirSync(path.join(ROOT, "memory", "sessions")).filter((f) => f.endsWith(".md")).length; } catch {}
  console.log(`config.json: ${fs.existsSync(cfg) ? "present" : "missing"} | saved sessions: ${sessions} | profile: ${fs.existsSync(path.join(ROOT, "memory", "profile.json")) ? "present" : "missing"}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "save") save(arg);
else if (cmd === "list") list();
else if (cmd === "restore") restore(arg);
else if (cmd === "current") current();
else { console.log("Usage: node scripts/snapshot.js <save [label] | list | restore <name> | current>"); }
