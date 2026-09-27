#!/usr/bin/env node
/**
 * Access-policy tests.
 *
 * Loads the real extension scripts (manifest order) into a vm with a given TB_ACCESS_CONFIG
 * and a minimal mocked `messenger`, then checks that every gated route is refused before any
 * side effect unless the build-time policy enables it, and that routes with no classification
 * in access-control.js are refused outright (deny-by-default).
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
  const calls = {
    messagesDelete: [], foldersDelete: [], messagesUpdate: [], messagesMove: [],
    messagesCopy: [], messagesArchive: [], tagsCreated: [], foldersCreated: [],
    foldersRenamed: [], composeSent: [], composeSaved: [],
  };
  const messenger = {
    runtime: { getManifest: () => manifest, reload: () => {} },
    folders: {
      get: async (id) => ({ id, accountId: "acct1" }),
      delete: async (f) => { calls.foldersDelete.push(f.id); },
      create: async (parent, name) => {
        const folder = { id: "f2", name, path: `/${name}` };
        calls.foldersCreated.push(folder);
        return folder;
      },
      rename: async (folder, newName) => {
        const renamed = { id: folder.id, name: newName, path: `/${newName}` };
        calls.foldersRenamed.push(renamed);
        return renamed;
      },
    },
    messages: {
      list: async () => ({ id: null, messages: [{ id: 1, read: true, flagged: false, tags: [] }] }),
      get: async (id) => ({ id, folder: { type: "drafts" } }),
      delete: async (ids, permanent) => { calls.messagesDelete.push({ ids, permanent }); },
      update: async (id, props) => { calls.messagesUpdate.push({ id, props }); },
      move: async (ids, folder) => { calls.messagesMove.push({ ids, folderId: folder.id }); },
      copy: async (ids, folder) => { calls.messagesCopy.push({ ids, folderId: folder.id }); },
      archive: async (ids) => { calls.messagesArchive.push(ids); },
      listTags: async () => [],
      createTag: async (key, tag, color) => { calls.tagsCreated.push({ key, tag, color }); },
      getFull: async () => ({ contentType: "multipart/mixed", parts: [] }),
      getAttachmentFile: async (id, partName) => ({
        name: "f.pdf", size: 3, type: "application/pdf",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    },
    compose: {
      beginNew: async () => ({ id: 1 }),
      getComposeDetails: async () => ({ isPlainText: true }),
      setComposeDetails: async () => {},
      sendMessage: async (tabId) => { calls.composeSent.push(tabId); },
      saveMessage: async (tabId) => { calls.composeSaved.push(tabId); return {}; },
    },
    tabs: {
      remove: async () => {},
    },
  };
  class NoSocket { constructor() { throw new Error("offline"); } }
  const ctx = vm.createContext({
    console: { log() {}, error() {} },
    WebSocket: NoSocket,
    messenger,
    btoa,
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

// ─── New switches: default open (unmodified install behaves as before this policy) ──

console.log("\n\x1b[1mNew switches — default open\x1b[0m");
{
  const { calls, handle } = load();
  const access = await handle("GET", "/access");
  test("GET /access reports full switch set",
    ["downloadAttachments", "compose", "send", "move", "copy", "archive", "mark",
      "tag", "tagCreate", "folderCreate", "folderRename"].every((k) => access.policy[k] === true));

  const archived = await handle("POST", "/messages/archive", { messageIds: [1, 2], keepUnread: true });
  test("archive allowed by default", archived.archived === 2 && calls.messagesArchive.length === 1);

  const moved = await handle("POST", "/messages/move", { messageIds: [1], destinationFolderId: "f2" });
  test("move allowed by default", moved.moved === 1 && calls.messagesMove.length === 1);

  const copied = await handle("POST", "/messages/copy", { messageIds: [1], destinationFolderId: "f2" });
  test("copy allowed by default", copied.copied === 1 && calls.messagesCopy.length === 1);

  const marked = await handle("POST", "/messages/update", { messageId: 1, read: true });
  test("mark allowed by default", marked.success === true && calls.messagesUpdate.length === 1);

  const tagged = await handle("POST", "/messages/update", { messageId: 1, tags: ["$label1"] });
  test("tag allowed by default", tagged.success === true && calls.messagesUpdate.length === 2);

  const tagCreated = await handle("POST", "/tags/create", { key: "$label9", tag: "Nine", color: "#fff" });
  test("tagCreate allowed by default", tagCreated.success === true && calls.tagsCreated.length === 1);

  const folderCreated = await handle("POST", "/folders/create", { parentFolderId: "f1", name: "New" });
  test("folderCreate allowed by default", folderCreated.success === true && calls.foldersCreated.length === 1);

  const folderRenamed = await handle("POST", "/folders/rename", { folderId: "f1", newName: "Renamed" });
  test("folderRename allowed by default", folderRenamed.success === true && calls.foldersRenamed.length === 1);

  const composed = await handle("POST", "/compose", { to: "a@b.com", subject: "s", body: "b" });
  test("compose allowed by default", composed.action === "draft_saved" && calls.composeSaved.length === 1);

  const sent = await handle("POST", "/compose", { to: "a@b.com", subject: "s", body: "b", send: true });
  test("send allowed by default", sent.action === "sent" && calls.composeSent.length === 1);

  const edited = await handle("POST", "/compose/edit", { messageId: 1, subject: "s2" });
  test("compose/edit allowed by default (shares compose switch)",
    edited.action === "draft_saved" && calls.composeSaved.length === 2);

  const editedAndSent = await handle("POST", "/compose/edit", { messageId: 1, subject: "s2", send: true });
  test("compose/edit send allowed by default (shares send switch)",
    editedAndSent.action === "sent" && calls.composeSent.length === 2);

  const attachment = await handle("POST", "/messages/1/attachment", { partName: "1.2" });
  test("downloadAttachments allowed by default", attachment.name === "f.pdf");
}

// ─── New switches: each can be disabled independently ───────────────

console.log("\n\x1b[1mNew switches — can be disabled\x1b[0m");
{
  const { handle } = load({ archive: false });
  test("archive refused when disabled",
    await rejects(handle("POST", "/messages/archive", { messageIds: [1] }), /^FORBIDDEN: 'archive'/));
  test("move unaffected by archive switch",
    (await handle("POST", "/messages/move", { messageIds: [1], destinationFolderId: "f2" })).moved === 1);
}
{
  const { handle } = load({ move: false });
  test("move refused when disabled",
    await rejects(handle("POST", "/messages/move", { messageIds: [1], destinationFolderId: "f2" }), /^FORBIDDEN: 'move'/));
}
{
  const { handle } = load({ copy: false });
  test("copy refused when disabled",
    await rejects(handle("POST", "/messages/copy", { messageIds: [1], destinationFolderId: "f2" }), /^FORBIDDEN: 'copy'/));
}
{
  const { handle } = load({ mark: false });
  test("mark refused when disabled",
    await rejects(handle("POST", "/messages/update", { messageId: 1, read: true }), /^FORBIDDEN: 'mark'/));
  const tagged = await handle("POST", "/messages/update", { messageId: 1, tags: ["$label1"] });
  test("tag unaffected by mark switch", tagged.success === true);
}
{
  const { handle } = load({ tag: false });
  test("tag refused when disabled",
    await rejects(handle("POST", "/messages/update", { messageId: 1, tags: ["$label1"] }), /^FORBIDDEN: 'tag'/));
  test("bulk tag also refused",
    await rejects(handle("POST", "/bulk/tag", { folderId: "f1", tagKey: "$label1" }), /^FORBIDDEN: 'tag'/));
  const marked = await handle("POST", "/messages/update", { messageId: 1, read: true });
  test("mark unaffected by tag switch", marked.success === true);
}
{
  const { handle } = load({ tagCreate: false });
  test("tagCreate refused when disabled",
    await rejects(handle("POST", "/tags/create", { key: "$label9", tag: "Nine" }), /^FORBIDDEN: 'tagCreate'/));
}
{
  const { handle } = load({ folderCreate: false });
  test("folderCreate refused when disabled",
    await rejects(handle("POST", "/folders/create", { parentFolderId: "f1", name: "New" }), /^FORBIDDEN: 'folderCreate'/));
}
{
  const { handle } = load({ folderRename: false });
  test("folderRename refused when disabled",
    await rejects(handle("POST", "/folders/rename", { folderId: "f1", newName: "R" }), /^FORBIDDEN: 'folderRename'/));
}
{
  const { handle } = load({ downloadAttachments: false });
  test("attachment download refused when disabled",
    await rejects(handle("POST", "/messages/1/attachment", { partName: "1.2" }), /^FORBIDDEN: 'downloadAttachments'/));
  test("attachment listing (GET) unaffected by downloadAttachments switch",
    Array.isArray((await handle("GET", "/messages/1/attachments"))));
}
{
  const { handle } = load({ compose: false, send: false });
  test("compose refused when disabled",
    await rejects(handle("POST", "/compose", { to: "a@b.com", body: "b" }), /^FORBIDDEN: 'compose'/));
  test("reply refused too (shares the compose switch)",
    await rejects(handle("POST", "/reply", { messageId: 1, body: "b" }), /^FORBIDDEN: 'compose'/));
  test("forward refused too (shares the compose switch)",
    await rejects(handle("POST", "/forward", { messageId: 1, to: "a@b.com", body: "b" }), /^FORBIDDEN: 'compose'/));
  test("compose/edit refused too (shares the compose switch)",
    await rejects(handle("POST", "/compose/edit", { messageId: 1, subject: "s2" }), /^FORBIDDEN: 'compose'/));
}
{
  const { handle } = load({ send: false });
  const draft = await handle("POST", "/compose", { to: "a@b.com", body: "b" });
  test("draft still allowed when only send is disabled", draft.action === "draft_saved");
  test("send refused when disabled",
    await rejects(handle("POST", "/compose", { to: "a@b.com", body: "b", send: true }), /^FORBIDDEN: 'send'/));

  const editDraft = await handle("POST", "/compose/edit", { messageId: 1, subject: "s2" });
  test("compose/edit draft still allowed when only send is disabled", editDraft.action === "draft_saved");
  test("compose/edit send refused when disabled",
    await rejects(handle("POST", "/compose/edit", { messageId: 1, subject: "s2", send: true }), /^FORBIDDEN: 'send'/));
}

// ─── Deny-by-default: routes with no access-control classification ──

console.log("\n\x1b[1mDeny-by-default\x1b[0m");
{
  const { handle } = load();
  test("unclassified POST route refused",
    await rejects(handle("POST", "/messages/undo-everything", {}), /^FORBIDDEN: unclassified operation POST/));
  test("unclassified GET route refused",
    await rejects(handle("GET", "/debug/dump", {}), /^FORBIDDEN: unclassified operation GET/));
  test("read-only routes remain ungated",
    Array.isArray((await handle("POST", "/messages/list", { folderId: "f1" })).messages));
  test("/extension/reload is ungated (dev-convenience, no mail-data access)",
    (await handle("POST", "/extension/reload", {})).ok === true);
}

// ─── Validation and permissions ─────────────────────────────────────

console.log("\n\x1b[1mValidation\x1b[0m");
{
  const { ctx } = load();
  const normalize = (c) => { try { return vm.runInContext(`normalizeAccessPolicy(${JSON.stringify(c)})`, ctx); } catch (e) { return e.message; } };
  test("unknown key rejected", /unknown access setting 'delet'/.test(normalize({ delet: true })));
  test("non-boolean rejected", /must be boolean/.test(normalize({ delete: "yes" })));
  test("array rejected", /JSON object/.test(normalize([])));
  test("missing destructive keys default to false", normalize({ delete: true }).folderDelete === false);
  test("missing non-destructive keys default to true", normalize({ delete: true }).archive === true);
  test("send without compose rejected",
    /'send' requires 'compose'/.test(normalize({ compose: false, send: true })));
  test("send with explicit compose accepted",
    normalize({ compose: true, send: true }).send === true);

  const perms = (c) => vm.runInContext(
    `accessPermissions(normalizeAccessPolicy(${JSON.stringify(c)}), ${JSON.stringify([...manifest.permissions, "messagesDelete"])})`, ctx);
  test("messagesDelete stripped when delete=false", !perms({}).includes("messagesDelete"));
  test("messagesDelete granted when delete=true", perms({ delete: true }).filter((p) => p === "messagesDelete").length === 1);
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
