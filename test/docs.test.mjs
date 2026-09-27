#!/usr/bin/env node
/**
 * Docs consistency tests.
 *
 * - Every `tb` command and long flag from `tb --help` is documented in docs/COMMANDS.md.
 * - Every `tb` command and flag used in code blocks of README.md / docs/COMMANDS.md exists.
 * - Every diagram IR in docs/diagrams/src/ has its delivered HTML and light/dark PNGs,
 *   and every docs/diagrams/ asset referenced from Markdown exists.
 *
 * Runs the real CLI's --help (no bridge needed). Does not need archify or Chrome.
 */

import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, basename, resolve } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "cli", "src", "cli.js");
const DIAGRAMS = join(ROOT, "docs", "diagrams");
const DIAGRAM_TYPES = new Set(["architecture", "workflow", "sequence", "dataflow", "lifecycle"]);

let passed = 0, failed = 0;

function test(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function help(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--help"], { encoding: "utf8" });
  return r.stdout;
}

// "Commands:" section → names; "Options:" section → long flags
function section(text, title) {
  const m = text.match(new RegExp(`\\n${title}:\\n([\\s\\S]*?)(\\n\\n|$)`));
  return m ? m[1].split("\n") : [];
}
const commandsOf = (text) =>
  section(text, "Commands").map((l) => l.trim().split(/\s/)[0]).filter((c) => c && c !== "help");
const flagsOf = (text) =>
  section(text, "Options").flatMap((l) => l.match(/--[a-z][a-z-]*/g) || []).filter((f) => f !== "--help");

// ─── Collect the real CLI surface ──────────────────────────────────

const top = help();
const globalFlags = new Set([...flagsOf(top), "-f", "-h", "-V", "--version", "--help"]);
const cli = new Map(); // "bulk move" → Set(flags)
for (const cmd of commandsOf(top)) {
  const text = help(cmd);
  const subs = commandsOf(text);
  if (subs.length) {
    for (const sub of subs) cli.set(`${cmd} ${sub}`, new Set(flagsOf(help(cmd, sub))));
    // A parent command can also have its own action (e.g. `tb contacts` lists,
    // `tb contacts create` is a subcommand) — register it too when it has its own flags.
    const ownFlags = flagsOf(text);
    if (ownFlags.length) cli.set(cmd, new Set(ownFlags));
  } else cli.set(cmd, new Set(flagsOf(text)));
}

console.log("\nCLI surface");
test(`tb --help lists commands (${cli.size} incl. subcommands)`, cli.size > 30);

// ─── docs/COMMANDS.md covers every command and flag ────────────────

console.log("\ndocs/COMMANDS.md covers tb --help");
const commandsDoc = readFileSync(join(ROOT, "docs", "COMMANDS.md"), "utf8").split("\n");
for (const [cmd, flags] of cli) {
  const re = new RegExp(`tb ${cmd}(\\s|$|\`)`);
  const hits = commandsDoc.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  // A command's section runs from each mention to the next "## " heading.
  let sec = "";
  for (const i of hits) {
    let j = i + 1;
    while (j < commandsDoc.length && !/^## /.test(commandsDoc[j])) j++;
    sec += commandsDoc.slice(i, j).join("\n");
  }
  const missing = [...flags].filter((f) => !sec.includes(f) && !(f === "--limit" && sec.includes("-l <n>")));
  test(`tb ${cmd}`, hits.length > 0 && missing.length === 0, hits.length ? `undocumented: ${missing.join(" ")}` : "command not documented");
}

// ─── Docs only use real commands and flags ─────────────────────────

function codeBlocks(md) {
  return [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\\\n\s*/g, " ")).join("\n");
}

for (const doc of ["README.md", "docs/COMMANDS.md"]) {
  console.log(`\n${doc} uses only real commands and flags`);
  const code = codeBlocks(readFileSync(join(ROOT, doc), "utf8"));
  const bad = [];
  for (const m of code.matchAll(/(?:^|[\s(`])tb ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?([^\n#]*)/g)) {
    const cmd = cli.has(`${m[1]} ${m[2]}`) ? `${m[1]} ${m[2]}` : m[1];
    if (!cli.has(cmd)) { bad.push(`unknown command: tb ${m[1]}`); continue; }
    for (const f of m[3].match(/(?<=\s)--?[a-z][a-z-]*/g) || []) {
      const flags = cli.get(cmd);
      if (!flags.has(f) && !globalFlags.has(f) && !(f === "-l" && flags.has("--limit"))) bad.push(`tb ${cmd}: unknown flag ${f}`);
    }
  }
  test(`${doc} commands/flags exist`, bad.length === 0, [...new Set(bad)].join("; "));
}

// ─── Diagrams ──────────────────────────────────────────────────────

console.log("\nDiagrams");
const PNG_MAGIC = "89504e470d0a1a0a";
const irs = readdirSync(join(DIAGRAMS, "src")).filter((f) => f.endsWith(".json"));
test("at least five diagram IRs", irs.length >= 5, `found ${irs.length}`);
for (const file of irs) {
  const name = basename(file, ".json");
  let ir;
  try { ir = JSON.parse(readFileSync(join(DIAGRAMS, "src", file), "utf8")); } catch { ir = null; }
  test(`${name}: IR is JSON with a known diagram_type`, ir && DIAGRAM_TYPES.has(ir.diagram_type));
  const html = join(DIAGRAMS, `${name}.html`);
  test(`${name}: delivered HTML contains the IR title`,
    existsSync(html) && !!ir?.meta?.title && readFileSync(html, "utf8").includes(ir.meta.title));
  for (const png of [`${name}.png`, `${name}-dark.png`]) {
    const p = join(DIAGRAMS, png);
    test(`${name}: ${png} is a PNG`, existsSync(p) && readFileSync(p).subarray(0, 8).toString("hex") === PNG_MAGIC);
  }
}

console.log("\nMarkdown references to docs/diagrams/ resolve");
const mdFiles = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "SPEC.md", "AGENTS.md",
  ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
for (const md of mdFiles) {
  const path = join(ROOT, md);
  if (!existsSync(path)) continue;
  const refs = [...readFileSync(path, "utf8").matchAll(/(?:src|srcset|href)="([^"]*diagrams\/[^"]+)"|\]\(([^)]*diagrams\/[^)]+)\)/g)]
    .map((m) => m[1] || m[2]).filter((r) => !/^https?:/.test(r));
  if (!refs.length) continue;
  const missing = refs.filter((r) => !existsSync(resolve(dirname(path), r)));
  test(`${md} (${refs.length} refs)`, missing.length === 0, `missing: ${missing.join(", ")}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
