#!/usr/bin/env node
/**
 * Packed-tarball smoke test: what `npm i -g @odience-network/thunderbird-cli-enhanced`
 * would give a user.
 *
 * Packs the repo, installs the tarball into a throwaway global prefix (needs the
 * npm registry for runtime deps), then runs the installed bins through their
 * npm shims:
 *   - tb --version / --help
 *   - tb-bridge --version / --help, then a real start on free ports + /bridge/status
 *   - tb-mcp --version, then an MCP initialize + tools/list over stdio
 */

import { spawn, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createServer } from "net";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const WIN = process.platform === "win32";

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

function npm(args, cwd) {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", shell: WIN });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const work = mkdtempSync(join(tmpdir(), "tb-pack-smoke-"));
const prefix = join(work, "prefix");
const binDir = WIN ? prefix : join(prefix, "bin");
const bin = (name) => join(binDir, WIN ? `${name}.cmd` : name);
const run = (name, ...args) => spawnSync(bin(name), args, { encoding: "utf8", shell: WIN, timeout: 30000 });
const children = [];

try {
  console.log("\nPack + install");
  const [{ filename }] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", work], ROOT));
  test(`packed ${filename}`, !!filename);
  npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(work, filename)], work);
  test("installed into a temp global prefix", true);

  console.log("\ntb");
  let r = run("tb", "--version");
  test("tb --version prints the package version", r.stdout.trim() === version, r.stdout + r.stderr);
  r = run("tb", "--help");
  test("tb --help lists commands", r.status === 0 && /Commands:/.test(r.stdout), r.stderr);

  console.log("\ntb-bridge");
  r = run("tb-bridge", "--version");
  test("tb-bridge --version prints the package version", r.stdout.trim() === version, r.stdout + r.stderr);
  r = run("tb-bridge", "--help");
  test("tb-bridge --help prints usage", r.status === 0 && /Usage: tb-bridge/.test(r.stdout), r.stderr);

  const [port, wsPort] = [await freePort(), await freePort()];
  const bridge = spawn(bin("tb-bridge"), ["--port", String(port), "--ws-port", String(wsPort)], {
    shell: WIN,
    stdio: "ignore",
  });
  children.push(bridge);
  let status = null;
  for (let i = 0; i < 50 && !status; i++) {
    await new Promise((res) => setTimeout(res, 100));
    status = await fetch(`http://127.0.0.1:${port}/bridge/status`).then((res) => res.json()).catch(() => null);
  }
  test("tb-bridge starts and answers /bridge/status", !!status, JSON.stringify(status));

  console.log("\ntb-mcp");
  r = run("tb-mcp", "--version");
  test("tb-mcp --version prints the package version", r.stdout.trim() === version, r.stdout + r.stderr);

  const mcp = spawn(bin("tb-mcp"), [], { shell: WIN, stdio: ["pipe", "pipe", "ignore"] });
  children.push(mcp);
  const replies = new Map();
  let buf = "";
  mcp.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line); replies.set(msg.id, msg); } catch { /* not JSON-RPC */ }
    }
  });
  const send = (msg) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const reply = async (id) => {
    for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((res) => setTimeout(res, 100));
    return replies.get(id);
  };
  send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pack-smoke", version: "0" } },
  });
  const init = await reply(1);
  test("tb-mcp answers initialize", init?.result?.serverInfo?.version === version, JSON.stringify(init));
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const list = await reply(2);
  test("tb-mcp lists tools", (list?.result?.tools?.length ?? 0) > 0, JSON.stringify(list));
} catch (err) {
  test("smoke run", false, err.message);
} finally {
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
