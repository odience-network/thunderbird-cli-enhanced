#!/usr/bin/env node
/**
 * IDs spliced into bridge request paths (cli/src/client.js and mcp/src/client.js).
 * An ID like "1/../../compose" must never reach a route the caller didn't name:
 * pathId() rejects it per argument, and api() rejects dot segments before any network call.
 */

import * as cliClient from "../cli/src/client.js";
import * as mcpClient from "../mcp/src/client.js";
import { tools } from "../mcp/src/tools.js";

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

function codeOf(fn) {
  try {
    return { ok: fn() };
  } catch (err) {
    return { code: err.code };
  }
}

async function asyncCodeOf(fn) {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { code: err.code };
  }
}

const VALID = [
  [42, "42"],
  ["42", "42"],
  ["account1", "account1"],
  ["0f8c1d2e-1234-4abc-9def-0123456789ab", "0f8c1d2e-1234-4abc-9def-0123456789ab"],
  ["a+b@c", "a%2Bb%40c"],
];
const INVALID = ["", null, undefined, ".", "..", "1/../../compose", "..%2fcompose", "%2e%2e", "1?x=1", "1#frag", "a\\b", "a b", "1\n"];

for (const [name, client] of [["cli", cliClient], ["mcp", mcpClient]]) {
  console.log(`\n${name}: pathId`);
  for (const [input, encoded] of VALID) {
    test(`accepts ${JSON.stringify(input)}`, codeOf(() => client.pathId(input)), { ok: encoded });
  }
  for (const input of INVALID) {
    test(`rejects ${JSON.stringify(input)}`, codeOf(() => client.pathId(input)), { code: "INVALID_ARGS" });
  }

  console.log(`\n${name}: assertSafePath / api`);
  test("plain path passes", codeOf(() => client.assertSafePath("/messages/42/full")), { ok: undefined });
  test("query string is not checked as a path", codeOf(() => client.assertSafePath("/bridge/events?wait=a/../b")), { ok: undefined });
  for (const path of ["/messages/1/../../compose", "/messages/./42", "/messages/%2e%2e/compose", "/messages/%2E/42", "/messages/1\\..\\compose", "/messages/%5c", "/messages/%zz"]) {
    test(`rejects ${path}`, codeOf(() => client.assertSafePath(path)), { code: "INVALID_ARGS" });
  }
  // Rejected before ensureBridge(), so no bridge is contacted or spawned.
  test("api() rejects a traversal path without a network call",
    await asyncCodeOf(() => client.api("GET", "/messages/1/../../compose")), { code: "INVALID_ARGS" });
}

console.log("\nmcp: tool handlers");
const calls = [];
const stubApi = async (method, path) => { calls.push(path); return {}; };
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
test("email_read rejects a traversal messageId",
  await asyncCodeOf(() => byName.email_read.handler({ messageId: "1/../../compose" }, stubApi)), { code: "INVALID_ARGS" });
test("email_thread rejects a traversal messageId",
  await asyncCodeOf(() => byName.email_thread.handler({ messageId: ".." }, stubApi)), { code: "INVALID_ARGS" });
test("no request reached the bridge", calls, []);
await byName.email_read.handler({ messageId: 42 }, stubApi);
test("a numeric messageId still builds the usual path", calls, ["/messages/42"]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
