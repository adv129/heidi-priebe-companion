/*
 * Heidi Priebe Agent — Skill loader (src/skills.js).
 *
 * The skills/ directory is the knowledge base: one folder per skill, each with
 * a SKILL.md (YAML frontmatter: name + description) and a references/ folder of
 * deep-dive files. agent-core is the always-loaded orchestrator.
 *
 * This module reads skills from disk (the single source of truth — no drift)
 * and can emit a machine-readable skills.json snapshot for external consumers.
 * Progressive loading (Level 0 agent-core → Level 1 one skill → Level 2 a
 * reference) is enforced by the caller (core.js), which only reads what it needs.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const AGENT_CORE = "agent-core";

// --- Frontmatter -----------------------------------------------------------

/** Parse leading `--- ... ---` YAML-ish frontmatter. Returns {meta, body}. */
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) meta[key] = val;
  }
  return { meta, body: m[2] };
}

// --- Path guards -----------------------------------------------------------

function skillDir(name) {
  const dir = path.join(SKILLS_DIR, name);
  const rel = path.relative(SKILLS_DIR, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`invalid skill name: ${name}`);
  return dir;
}

// --- Manifest --------------------------------------------------------------

let _manifestCache = null;

/**
 * Scan skills/ and build the manifest.
 * Returns { skills: [{ name, description, dir, references: [file], hasReferences }] }.
 * agent-core is included but flagged isCore.
 */
function loadManifest({ fresh = false } = {}) {
  if (_manifestCache && !fresh) return _manifestCache;
  const entries = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const skills = [];
  for (const name of entries) {
    const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
    let references = [];
    const refDir = path.join(SKILLS_DIR, name, "references");
    if (fs.existsSync(refDir)) {
      references = fs.readdirSync(refDir).filter((f) => f.endsWith(".md")).sort();
    }
    // One-liners from the SKILL.md "References index" table (| Need | `references/file.md` |)
    // — these are what the router sees when deciding whether to pull a reference.
    const referenceDescriptions = {};
    for (const row of body.matchAll(/\|\s*([^|\n]+?)\s*\|\s*`references\/([\w.-]+\.md)`\s*\|/g)) {
      referenceDescriptions[row[2]] = row[1];
    }
    skills.push({
      name: meta.name || name,
      dir: name,
      isCore: name === AGENT_CORE,
      description: meta.description || "",
      references,
      referenceDescriptions,
      hasReferences: references.length > 0,
    });
  }
  _manifestCache = { skills };
  return _manifestCache;
}

/** The topical skills only (excludes agent-core) — what the router chooses among. */
function topicalSkills() {
  return loadManifest().skills.filter((s) => !s.isCore);
}

function skillExists(name) {
  return loadManifest().skills.some((s) => s.dir === name || s.name === name);
}

/** Resolve a name/dir to its dir folder, or null. */
function resolveDir(name) {
  const s = loadManifest().skills.find((x) => x.dir === name || x.name === name);
  return s ? s.dir : null;
}

// --- Readers ---------------------------------------------------------------

/** Full SKILL.md body (frontmatter stripped) for a skill. */
function readSkillBody(name) {
  const dir = resolveDir(name);
  if (!dir) throw new Error(`unknown skill: ${name}`);
  const { body } = parseFrontmatter(fs.readFileSync(path.join(skillDir(dir), "SKILL.md"), "utf8"));
  return body.trim();
}

/** agent-core's SKILL.md body — the always-loaded orchestrator (Level 0). */
function readAgentCore() {
  return readSkillBody(AGENT_CORE);
}

/** A single reference file's text (Level 2). Guards against traversal. */
function readReference(name, refFile) {
  const dir = resolveDir(name);
  if (!dir) throw new Error(`unknown skill: ${name}`);
  if (!/^[\w.-]+\.md$/.test(refFile)) throw new Error(`invalid reference: ${refFile}`);
  const p = path.join(skillDir(dir), "references", refFile);
  const rel = path.relative(path.join(skillDir(dir), "references"), p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`invalid reference path`);
  return fs.readFileSync(p, "utf8").trim();
}

/**
 * Compact catalog for the router prompt: one "name — description" line per
 * skill, plus its reference files (with their References-index one-liners) so
 * the router can actually pick a valid `reference` filename.
 */
function routerCatalog() {
  return topicalSkills()
    .map((s) => {
      const lines = [`- ${s.name}: ${s.description}`];
      if (s.references.length) {
        const refs = s.references
          .map((f) => (s.referenceDescriptions[f] ? `${f} — ${s.referenceDescriptions[f]}` : f))
          .join("\n    ");
        lines.push(`  references (loadable on demand):\n    ${refs}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

/** readReference, but returns null instead of throwing (for optional context). */
function tryReadReference(name, refFile) {
  try {
    return readReference(name, refFile);
  } catch {
    return null;
  }
}

// --- Manifest snapshot (for external consumers / debugging) ----------------

function emitManifestFile() {
  const manifest = loadManifest({ fresh: true });
  const out = path.join(ROOT, "skills.json");
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  return out;
}

// CLI: `node src/skills.js --emit-manifest`
if (require.main === module && process.argv.includes("--emit-manifest")) {
  const out = emitManifestFile();
  console.log(`Wrote ${out}`);
}

module.exports = {
  ROOT,
  SKILLS_DIR,
  AGENT_CORE,
  parseFrontmatter,
  loadManifest,
  topicalSkills,
  skillExists,
  resolveDir,
  readSkillBody,
  readAgentCore,
  readReference,
  tryReadReference,
  routerCatalog,
  emitManifestFile,
};
