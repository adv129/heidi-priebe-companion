/*
 * Skills knowledge-base linter (scripts/lint-skills.js).
 *
 * Enforces the invariants the runtime silently depends on (see src/skills.js
 * and src/core.js): routing works by exact string match between agent-core's
 * prose and the folder names, and the router only learns about reference
 * files through each SKILL.md's "References index" table. Drift in any of
 * these fails silently at runtime — so it must fail loudly here.
 *
 * Usage: node scripts/lint-skills.js [skillsDir]   (npm run lint:skills)
 * Exits 1 with a list of errors; warnings don't fail the run.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.resolve(process.argv[2] || path.join(__dirname, "..", "skills"));
const AGENT_CORE = "agent-core";

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: null, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const eq = line.indexOf(":");
    if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    meta[line.slice(0, eq).trim()] = val;
  }
  return { meta, body: m[2] };
}

const dirs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const skillNames = new Set(dirs);

// Per-skill: frontmatter, References-index table ↔ references/ dir.
const refFilesBySkill = {};
for (const dir of dirs) {
  const rel = `skills/${dir}/SKILL.md`;
  const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    err(`skills/${dir}/`, "missing SKILL.md");
    continue;
  }
  const { meta, body } = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
  if (!meta) err(rel, "missing YAML frontmatter (--- name/description ---)");
  else {
    if (!meta.name) err(rel, "frontmatter missing name:");
    else if (meta.name !== dir) err(rel, `frontmatter name "${meta.name}" != folder name "${dir}" (router resolves by exact match)`);
    if (!meta.description) err(rel, "frontmatter missing description: (the router catalog line)");
  }

  const refDir = path.join(SKILLS_DIR, dir, "references");
  const onDisk = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith(".md")).sort() : [];
  refFilesBySkill[dir] = new Set(onDisk);

  // Rows in the "| Need | `references/file.md` |" table — the router's only
  // source of reference descriptions (parsed the same way as src/skills.js).
  const indexed = [...body.matchAll(/\|\s*([^|\n]+?)\s*\|\s*`references\/([\w.-]+\.md)`\s*\|/g)].map((m) => m[2]);
  for (const f of indexed) {
    if (!refFilesBySkill[dir].has(f)) err(rel, `References index lists references/${f}, which does not exist on disk`);
  }
  for (const f of onDisk) {
    if (!indexed.includes(f)) err(rel, `references/${f} exists but has no References-index row — the router gets no description for it`);
  }
}

// Stale numeric-ID scheme (the abandoned 00–09 prefixes) anywhere in skills/.
for (const dir of dirs) {
  const files = [path.join(SKILLS_DIR, dir, "SKILL.md")];
  const refDir = path.join(SKILLS_DIR, dir, "references");
  if (fs.existsSync(refDir)) for (const f of fs.readdirSync(refDir)) if (f.endsWith(".md")) files.push(path.join(refDir, f));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rel = path.relative(path.join(SKILLS_DIR, ".."), file);
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (/\b0[0-9]-[a-z]/.test(line)) err(`${rel}:${i + 1}`, `stale numeric-prefixed skill name: "${line.trim().slice(0, 80)}"`);
      else if (/(?:→|route to|routes to|load|stay in)\s+0[0-9]\b/i.test(line)) err(`${rel}:${i + 1}`, `stale bare numeric skill ID: "${line.trim().slice(0, 80)}"`);
    });
  }
}

// agent-core routing table: heading must exist (core.js regex-extracts it for
// the route prompt) and every backticked name in it must be a real folder.
{
  const rel = `skills/${AGENT_CORE}/SKILL.md`;
  const coreFile = path.join(SKILLS_DIR, AGENT_CORE, "SKILL.md");
  if (fs.existsSync(coreFile)) {
    const { body } = parseFrontmatter(fs.readFileSync(coreFile, "utf8"));
    const table = body.match(/###?\s*Routing table[\s\S]*?(?=\n##\s|\n---|\s*$)/i);
    if (!table) {
      err(rel, 'no "Routing table" heading — agentCoreRoutingTable() in src/core.js extracts it by that name (if the table moved on purpose, update core.js and this linter together)');
    } else {
      for (const m of table[0].matchAll(/`([a-z][\w-]*)`/g)) {
        if (!skillNames.has(m[1])) err(rel, `routing table loads \`${m[1]}\` — no such folder in skills/`);
      }
    }
  }
}

// Cross-reference pointers. Conventions: "→ skill-name" | "→ skill-name/file.md" | "→ file.md" (same skill).
// For bare kebab tokens that aren't skill names, warn only when they share a
// word with a real skill name (likely typo) — prose arrows ("testing →
// guilt-tripping") stay quiet.
const skillWords = new Set([...skillNames].flatMap((n) => n.split("-")));
for (const dir of dirs) {
  const files = [["SKILL.md", path.join(SKILLS_DIR, dir, "SKILL.md")]];
  const refDir = path.join(SKILLS_DIR, dir, "references");
  if (fs.existsSync(refDir)) for (const f of fs.readdirSync(refDir)) if (f.endsWith(".md")) files.push([`references/${f}`, path.join(refDir, f)]);
  for (const [relName, file] of files) {
    if (!fs.existsSync(file)) continue;
    const rel = `skills/${dir}/${relName}`;
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(/→\s*([\w-]+\/[\w-]+\.md|[\w-]+\.md|[\w-]+)/g)) {
        const target = m[1];
        if (target.includes("/")) {
          const [skill, refFile] = target.split("/");
          if (!skillNames.has(skill)) err(`${rel}:${i + 1}`, `pointer "→ ${target}": no skill folder "${skill}"`);
          else if (!refFilesBySkill[skill].has(refFile)) err(`${rel}:${i + 1}`, `pointer "→ ${target}": ${skill} has no references/${refFile}`);
        } else if (target.endsWith(".md")) {
          // "→ SKILL.md" points at the skill's own body — always valid.
          if (target !== "SKILL.md" && !refFilesBySkill[dir].has(target)) err(`${rel}:${i + 1}`, `pointer "→ ${target}": no references/${target} in this skill`);
        } else if (!skillNames.has(target) && target.includes("-") && target.split("-").some((w) => skillWords.has(w))) {
          warn(`${rel}:${i + 1}`, `pointer "→ ${target}" doesn't match any skill folder (typo?)`);
        }
      }
    });
  }
}

for (const w of warnings) console.warn(`warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`\n${errors.length} error(s) in ${SKILLS_DIR}`);
  process.exit(1);
}
console.log(`skills lint OK — ${dirs.length} skills, ${Object.values(refFilesBySkill).reduce((n, s) => n + s.size, 0)} reference files checked${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
