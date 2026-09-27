#!/usr/bin/env node
/**
 * npm package tests (no network, no install).
 *
 * - `npm pack --dry-run` ships exactly the runtime files: the three bins, their
 *   sources and package.json files, LICENSE/README/CHANGELOG, server.json and the
 *   agent skill. No tests, extension sources, XPIs, node_modules, docs or secrets.
 * - Only the scoped root package is publishable; the workspaces stay private so
 *   nothing leaks under upstream's unscoped names.
 * - Versions and MCP registry names agree across package.json files and server.json.
 * - The root package carries every runtime dependency the workspaces import.
 */

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "@odience-network/thunderbird-cli-enhanced";
const REPO = "https://github.com/odience-network/thunderbird-cli-enhanced";

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

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const root = readJson("package.json");
const workspaces = Object.fromEntries(["cli", "bridge", "mcp"].map((w) => [w, readJson(`${w}/package.json`)]));
const server = readJson("server.json");

// ─── Manifest ──────────────────────────────────────────────────────

console.log("\nManifest");
test("root package is the scoped name", root.name === NAME, root.name);
test("root package is publishable", root.private !== true);
test("publishConfig.access is public", root.publishConfig?.access === "public");
test("repository points at the fork", root.repository?.url?.includes("odience-network/thunderbird-cli-enhanced"), root.repository?.url);
test("homepage points at the fork", root.homepage?.startsWith(REPO), root.homepage);
test("bugs points at the fork", root.bugs?.url === `${REPO}/issues`, root.bugs?.url);
test("license is MIT", root.license === "MIT");
test("bins: tb, tb-bridge, tb-mcp", JSON.stringify(Object.keys(root.bin || {}).sort()) === JSON.stringify(["tb", "tb-bridge", "tb-mcp"]));

for (const [ws, pkg] of Object.entries(workspaces)) {
  test(`${ws}/ workspace is private`, pkg.private === true);
  test(`${ws}/ version matches root`, pkg.version === root.version, `${pkg.version} vs ${root.version}`);
  for (const [dep, range] of Object.entries(pkg.dependencies || {})) {
    test(`root depends on ${dep} (${ws}/)`, root.dependencies?.[dep] === range, `${root.dependencies?.[dep]} vs ${range}`);
  }
}

console.log("\nMCP registry metadata");
test("server.json name matches mcpName", server.name === root.mcpName, `${server.name} vs ${root.mcpName}`);
test("mcpName is in the fork's namespace", root.mcpName?.startsWith("io.github.odience-network/"), root.mcpName);
test("server.json version matches root", server.version === root.version);
test("server.json npm identifier is the scoped package", server.packages?.[0]?.identifier === NAME);
test("server.json package version matches root", server.packages?.[0]?.version === root.version);
test("server.json repository is the fork", server.repository?.url === REPO);

// ─── Tarball contents ──────────────────────────────────────────────

console.log("\nTarball (npm pack --dry-run)");
const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: ROOT,
  encoding: "utf8",
  shell: process.platform === "win32",
});
let files = [];
try {
  files = JSON.parse(r.stdout)[0].files.map((f) => f.path.replace(/\\/g, "/"));
} catch {
  test("npm pack --dry-run succeeds", false, r.stderr.trim());
}

const required = [
  "package.json", "README.md", "LICENSE", "CHANGELOG.md", "server.json",
  "cli/package.json", "cli/src/cli.js", "cli/src/client.js",
  "bridge/package.json", "bridge/bridge.js",
  "mcp/package.json", "mcp/src/server.js", "mcp/src/tools.js", "mcp/src/client.js",
  "skills/thunderbird-cli/SKILL.md",
];
for (const f of required) test(`includes ${f}`, files.includes(f));
for (const bin of Object.values(root.bin || {})) {
  test(`includes bin target ${bin}`, files.includes(bin.replace(/^\.\//, "")));
}

const forbidden = [
  [/(^|\/)node_modules\//, "node_modules"],
  [/^test\/|\/test\//, "tests"],
  [/\.test\.m?js$/, "test files"],
  [/\.xpi$/, "XPIs"],
  [/^dist\//, "dist/"],
  [/^extension\//, "extension sources"],
  [/^scripts\//, "build scripts"],
  [/^docs\//, "docs/"],
  [/^\.github\//, ".github/"],
  [/(^|\/)\.env/, ".env files"],
  [/(^|\/)cli\/config\.json$/, "local CLI config"],
  [/access\.local\.json$/, "local access policy"],
  [/\.(pem|key|p12|npmrc)$|(^|\/)\.npmrc$/, "keys / .npmrc"],
];
for (const [re, label] of forbidden) {
  const hits = files.filter((f) => re.test(f));
  test(`excludes ${label}`, hits.length === 0, hits.join(", "));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
