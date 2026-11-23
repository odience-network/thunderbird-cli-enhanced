#!/usr/bin/env node
/**
 * Error handling in the bridge clients (cli/src/client.js, mcp/src/client.js) and the CLI:
 * a body that stalls past --timeout is a TIMEOUT, a body that isn't JSON gets a code,
 * an HTTP-200 { error } payload exits non-zero, and a bad --timeout is INVALID_ARGS.
 */

import { createServer } from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const PORT = 19760;
process.env.TB_BRIDGE_HOST = "127.0.0.1";
process.env.TB_BRIDGE_PORT = String(PORT);
delete process.env.TB_AUTH_TOKEN;

const CLI = fileURLToPath(new URL("../cli/src/cli.js", import.meta.url));

let passed = 0, failed = 0;
function test(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

async function asyncCodeOf(fn) {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { code: err.code };
  }
}

const server = createServer((req, res) => {
  if (req.url === "/bridge/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ bridge: "running", extension: "connected" }));
  } else if (req.url === "/stalled") {
    // Headers and half a body, then nothing.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"messages": [');
  } else if (req.url === "/html") {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html>Bad Gateway</html>");
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Thunderbird said no", code: "THUNDERBIRD_ERROR" }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const cliClient = await import("../cli/src/client.js");
const mcpClient = await import("../mcp/src/client.js");

for (const [name, client] of [["cli", cliClient], ["mcp", mcpClient]]) {
  console.log(`\n${name}: api() response bodies`);
  test("a body that stalls past the timeout is TIMEOUT",
    await asyncCodeOf(() => client.api("GET", "/stalled", null, 300)), { code: "TIMEOUT" });
  test("a body that isn't JSON is THUNDERBIRD_ERROR",
    await asyncCodeOf(() => client.api("GET", "/html")), { code: "THUNDERBIRD_ERROR" });
}

function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

console.log("\ncli: exit codes");
let r = await runCli(["health"]);
test("an HTTP-200 { error } payload exits 1", r.status, 1);
test("...and still prints the ok:false envelope", JSON.parse(r.stdout), { ok: false, error: "Thunderbird said no", code: "THUNDERBIRD_ERROR" });
r = await runCli(["--output-version", "2", "health"]);
test("the same under --output-version 2", r.status, 1);
r = await runCli(["access"]);
test("a normal response exits 0", r.status, 0);
for (const bad of ["-5", "0", "abc", "30s"]) {
  r = await runCli(["--timeout", bad, "access"]);
  test(`--timeout ${bad} exits 1 with INVALID_ARGS`, [r.status, JSON.parse(r.stderr).code], [1, "INVALID_ARGS"]);
}
r = await runCli(["--timeout", "5000", "access"]);
test("--timeout 5000 is accepted", r.status, 0);

server.closeAllConnections();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
