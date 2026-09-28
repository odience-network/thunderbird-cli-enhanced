#!/usr/bin/env node

/**
 * Lint: `node --check` every source file, then run addons-linter on the built XPI.
 *
 * Usage: npm run build:xpi && npm run lint
 *
 * addons-linter targets Firefox, so Thunderbird-only permissions (messagesRead, …)
 * show up as warnings; only errors fail the lint. It also flags `experiment_apis` as
 * MANIFEST_FIELD_PRIVILEGED because that manifest key is normally reserved for Mozilla's
 * Firefox privileged-extension tier — that tier doesn't apply to Thunderbird, whose ATN
 * signing accepts Experiment APIs (with manual review; see docs/decisions/calendar-backend.md),
 * so this one error code is tolerated when it points at /experiment_apis specifically.
 */

import { execFileSync } from "child_process";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["cli/src", "bridge", "mcp/src", "extension/src", "scripts", "test"];
const ADDONS_LINTER = "addons-linter@7.20.0";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

let failed = 0;
const files = SOURCE_DIRS.flatMap((d) => walk(join(REPO_ROOT, d)));
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`✗ ${relative(REPO_ROOT, file)}\n${err.stderr}`);
  }
}
console.log(`${failed ? "✗" : "✓"} node --check: ${files.length - failed}/${files.length} files OK`);

const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "extension/manifest.json"), "utf-8"));
const xpiPath = join(REPO_ROOT, "dist", `thunderbird-cli-enhanced-${version}.xpi`);
if (!existsSync(xpiPath)) {
  console.error(`✗ ${relative(REPO_ROOT, xpiPath)} not found — run \`npm run build:xpi\` first`);
  process.exit(1);
}
function tolerated(error) {
  return error.code === "MANIFEST_FIELD_PRIVILEGED" && error.instancePath === "/experiment_apis";
}

// addons-linter exits non-zero whenever it finds any error, tolerated or not, so its JSON
// report (on stdout either way) has to be parsed before deciding whether this is a real failure.
let report;
try {
  report = execFileSync("npx", ["--yes", ADDONS_LINTER, "--output", "json", xpiPath], { stdio: "pipe" });
} catch (err) {
  report = err.stdout;
}
let errors;
try {
  errors = JSON.parse(report.toString("utf-8")).errors;
} catch {
  failed++;
  console.error(`✗ ${ADDONS_LINTER} failed to run`);
}
if (errors) {
  const blocking = errors.filter((e) => !tolerated(e));
  for (const e of errors) {
    console.log(`${tolerated(e) ? "⚠ (tolerated)" : "✗"} ${e.code} ${e.instancePath}: ${e.message}`);
  }
  if (blocking.length) {
    failed++;
    console.error(`✗ ${ADDONS_LINTER} reported ${blocking.length} error(s) in ${relative(REPO_ROOT, xpiPath)}`);
  } else {
    console.log(`✓ ${ADDONS_LINTER}: no blocking errors in ${relative(REPO_ROOT, xpiPath)}`);
  }
}

process.exit(failed ? 1 : 0);
