#!/usr/bin/env node
/**
 * Access-policy tests.
 *
 * Loads the real extension scripts (manifest order) into a vm with a given TB_ACCESS_CONFIG
 * and a minimal mocked `messenger`, then checks that deletion routes are refused before any
 * side effect unless the build-time policy enables them.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "vm";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf-8"));

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
}

function load(config) {
  const calls = { messagesDelete: [], foldersDelete: [] };
  const messenger = {
    runtime: { getManifest: () => manifest },
    folders: {
      get: async (id) => ({ id, accountId: "acct1" }),
      delete: async (f) => { calls.foldersDelete.push(f.id); },
    },
    messages: {
      list: async () => ({ id: null, messages: [{ id: 1, read: true, flagged: false, tags: [] }] }),
      delete: async (ids, permanent) => { calls.messagesDelete.push({ ids, permanent }); },
      listTags: async () => [],
    },
  };
  class NoSocket { constructor() { throw new Error("offline"); } }
  const ctx = vm.createContext({
    console: { log() {}, error() {} },
    WebSocket: NoSocket,
    messenger,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });
  for (const script of manifest.background.scripts) {
    const file = join(EXT, script);
    vm.runInContext(readFileSync(file, "utf-8"), ctx, { filename: file });
    // Stand-in for the builder rewriting access-config.js inside the XPI.
    if (script === "src/access-config.js" && config !== undefined) ctx.TB_ACCESS_CONFIG = config;
  }
  const handle = (method, path, body) => ctx.handleRequest({ method, path, body });
  return { ctx, calls, handle };
}

async function rejects(promise, pattern) {
  try { await promise; return false; } catch (e) { return pattern.test(e.message); }
}

console.log("\n\x1b[1m=== access policy tests ===\x1b[0m");

// ─── Manifest ───────────────────────────────────────────────────────

console.log("\n\x1b[1mManifest\x1b[0m");
const scripts = manifest.background.scripts;
test("access scripts load before background.js",
  scripts.indexOf("src/access-config.js") < scripts.indexOf("src/access-control.js") &&
  scripts.indexOf("src/access-control.js") < scripts.indexOf("src/background.js"));
test("source manifest does not request messagesDelete", !manifest.permissions.includes("messagesDelete"));

// ─── Defaults: deletion disabled ────────────────────────────────────

console.log("\n\x1b[1mDefault policy\x1b[0m");
{
  const { calls, handle } = load();
  const access = await handle("GET", "/access");
  test("GET /access reports delete/folderDelete off",
    access.policy.delete === false && access.policy.folderDelete === false);
  test("message delete refused", await rejects(handle("POST", "/messages/delete", { messageIds: [1] }), /^FORBIDDEN: 'delete'/));
  test("permanent delete refused", await rejects(handle("POST", "/messages/delete", { messageIds: [1], permanent: true }), /^FORBIDDEN/));
  test("bulk delete refused", await rejects(handle("POST", "/bulk/delete", { folderId: "f1" }), /^FORBIDDEN: 'delete'/));
  test("folder delete refused", await rejects(handle("POST", "/folders/delete", { folderId: "f1" }), /^FORBIDDEN: 'folderDelete'/));
  test("no messenger delete call was made", calls.messagesDelete.length === 0 && calls.foldersDelete.length === 0);
  test("ungated routes still work", Array.isArray(await handle("GET", "/tags")));
}

// ─── Enabled by build-time config ───────────────────────────────────

console.log("\n\x1b[1mEnabled policy\x1b[0m");
{
  const { calls, handle } = load({ delete: true });
  const del = await handle("POST", "/messages/delete", { messageIds: [1, 2], permanent: true });
  test("message delete allowed with delete=true",
    del.deleted === 2 && calls.messagesDelete[0]?.permanent === true);
  const bulk = await handle("POST", "/bulk/delete", { folderId: "f1" });
  test("bulk delete allowed with delete=true", bulk.deleted === 1);
  test("folder delete still refused (separate switch)",
    await rejects(handle("POST", "/folders/delete", { folderId: "f1" }), /^FORBIDDEN: 'folderDelete'/));
}
{
  const { calls, handle } = load({ folderDelete: true });
  await handle("POST", "/folders/delete", { folderId: "f9" });
  test("folder delete allowed with folderDelete=true", calls.foldersDelete[0] === "f9");
  test("message delete still refused",
    await rejects(handle("POST", "/messages/delete", { messageIds: [1] }), /^FORBIDDEN: 'delete'/));
}

// ─── Validation and permissions ─────────────────────────────────────

console.log("\n\x1b[1mValidation\x1b[0m");
{
  const { ctx } = load();
  const normalize = (c) => { try { return vm.runInContext(`normalizeAccessPolicy(${JSON.stringify(c)})`, ctx); } catch (e) { return e.message; } };
  test("unknown key rejected", /unknown access setting 'delet'/.test(normalize({ delet: true })));
  test("non-boolean rejected", /must be boolean/.test(normalize({ delete: "yes" })));
  test("array rejected", /JSON object/.test(normalize([])));
  test("missing keys default to false", normalize({ delete: true }).folderDelete === false);

  const perms = (c) => vm.runInContext(
    `accessPermissions(normalizeAccessPolicy(${JSON.stringify(c)}), ${JSON.stringify([...manifest.permissions, "messagesDelete"])})`, ctx);
  test("messagesDelete stripped when delete=false", !perms({}).includes("messagesDelete"));
  test("messagesDelete granted when delete=true", perms({ delete: true }).filter((p) => p === "messagesDelete").length === 1);
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
