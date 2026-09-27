#!/usr/bin/env node
/**
 * Draft routing tests.
 *
 * Loads the real extension background scripts (in manifest order) into a vm with a mock
 * `messenger` shaped like a multi-account mailbox: account1 has a single /Drafts, account3 is a
 * Gmail account with both a bare /Drafts and the real /[Gmail]/Drafts.
 *
 * Guards the bugs that made `--draft` look like a no-op:
 *   1. reply/forward composed under the default identity, so drafts for an account3 message
 *      were filed into account1's Drafts.
 *   2. drafts filed into the bare /Drafts instead of /[Gmail]/Drafts, which is the only one
 *      Gmail shows as a draft.
 *   3. "draft_saved" reported for a save that returned no message.
 * plus the reply body/subject/compose-mode handling around beginReply.
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

// ─── Mock mailbox ───────────────────────────────────────────────────

function folder(accountId, path, name, type, subFolders = []) {
  return { id: `${accountId}:/${path}`, accountId, path, name, type, subFolders };
}

const ACCOUNTS = [
  {
    id: "account1", name: "work", type: "imap",
    identities: [{ id: "id1", email: "me@work.example" }],
    rootFolder: folder("account1", "/", "Root", undefined, [
      folder("account1", "/INBOX", "Inbox", "inbox"),
      folder("account1", "/Drafts", "Drafts", "drafts"),
    ]),
  },
  {
    id: "account3", name: "gmail", type: "imap",
    identities: [{ id: "id2", email: "me@gmail.example" }],
    rootFolder: folder("account3", "/", "Root", undefined, [
      folder("account3", "/INBOX", "Inbox", "inbox"),
      folder("account3", "/Drafts", "Drafts", "drafts"),
      folder("account3", "/[Gmail]", "[Gmail]", undefined, [
        folder("account3", "/[Gmail]/Drafts", "Drafts", "drafts"),
      ]),
    ]),
  },
];

// 2506 lives in account3's inbox, 900 in account1's.
const MESSAGES = {
  2506: { id: 2506, subject: "Devis pour la sortie scolaire", recipients: ["me@gmail.example"],
          folder: { accountId: "account3", path: "/INBOX", type: "inbox" } },
  900: { id: 900, subject: "Re: contrat signé", recipients: ["me@work.example"],
         folder: { accountId: "account1", path: "/INBOX", type: "inbox" } },
};

let calls;

/**
 * @param savedInto  path the composing identity files drafts into, or null to simulate
 *                   saveMessage returning no message.
 * @param generated  what Thunderbird's own beginReply leaves in the compose tab.
 */
function mailbox({
  savedInto = "/Drafts", savedAccount = "account1",
  generated = { subject: null, isPlainText: true, plainTextBody: "> quoted original" },
} = {}) {
  calls = { begin: null, setDetails: [], removedTab: null };
  let tab = null;
  ctx.messenger = {
    runtime: { getManifest: () => manifest },
    accounts: {
      list: async () => ACCOUNTS,
      get: async (id) => ACCOUNTS.find((a) => a.id === id) || null,
    },
    messages: {
      get: async (id) => {
        if (!MESSAGES[id]) throw new Error(`Message ${id} not found`);
        return MESSAGES[id];
      },
      getFull: async () => ({ contentType: "text/plain", body: "original", headers: {} }),
      query: async () => ({ messages: [] }),
    },
    tabs: { remove: async (id) => { calls.removedTab = id; } },
    compose: {
      beginNew: async (_id, details) => {
        calls.begin = { kind: "new", details };
        tab = { ...details };
        return { id: 7 };
      },
      beginReply: async (messageId, type, details) => {
        calls.begin = { kind: "reply", messageId, type, details };
        tab = { ...generated, identityId: details.identityId, type: "reply", relatedMessageId: messageId };
        return { id: 7 };
      },
      beginForward: async (messageId, type, details) => {
        calls.begin = { kind: "forward", messageId, type, details };
        tab = { ...details };
        return { id: 7 };
      },
      getComposeDetails: async () => ({ ...tab }),
      setComposeDetails: async (_id, details) => {
        calls.setDetails.push(details);
        Object.assign(tab, details);
      },
      saveMessage: async () => (savedInto === null
        ? {}
        : { messages: [{ id: 555, folder: { accountId: savedAccount, path: savedInto, name: "Drafts" } }] }),
      sendMessage: async () => ({}),
    },
  };
  return () => tab;
}

// ─── Load background scripts ────────────────────────────────────────

class NoSocket { constructor() { throw new Error("offline"); } }
const ctx = vm.createContext({
  console: { log() {}, error() {} },
  WebSocket: NoSocket,
  messenger: {
    runtime: { getManifest: () => manifest },
    idle: { onStateChanged: { addListener() {} } },
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
});
for (const script of manifest.background.scripts) {
  const file = join(EXT, script);
  vm.runInContext(readFileSync(file, "utf-8"), ctx, { filename: file });
}
const call = (path, body) => ctx.handleRequest({ method: "POST", path, body });

console.log("\n\x1b[1m=== draft routing tests ===\x1b[0m");

// ─── Identity resolution ────────────────────────────────────────────

console.log("\n\x1b[1mIdentity resolution\x1b[0m");
{
  mailbox({ savedAccount: "account3", savedInto: "/[Gmail]/Drafts" });
  const res = await call("/reply", { messageId: 2506, body: "hi" });
  test("reply uses the source message's own identity", calls.begin.details.identityId === "id2", calls.begin.details.identityId);
  test("action is draft_saved", res.action === "draft_saved");
  test("response reports the folder the draft landed in", res.folder?.path === "/[Gmail]/Drafts", JSON.stringify(res.folder));
  test("response reports the draft message id", res.messageId === 555, res.messageId);
  test("compose tab was closed", calls.removedTab === 7);
}
{
  mailbox({ savedAccount: "account3", savedInto: "/[Gmail]/Drafts" });
  const res = await call("/forward", { messageId: 2506, to: "x@y.example", body: "fwd" });
  test("forward uses the source message's own identity", calls.begin.details.identityId === "id2", calls.begin.details.identityId);
  test("forward reports the identity it used", res.identityId === "id2", res.identityId);
  test("forwardAsAttachment preserved", calls.begin.type === "forwardAsAttachment", calls.begin.type);
  test("forward recipient preserved", JSON.stringify(calls.begin.details.to) === JSON.stringify(["x@y.example"]));
}
{
  mailbox({ savedAccount: "account1", savedInto: "/Drafts" });
  const res = await call("/reply", { messageId: 900, body: "hi" });
  test("account1 message resolves account1's identity", calls.begin.details.identityId === "id1");
  test("draft in the right folder carries no warning", res.warning === undefined, res.warning);
}

// ─── --from ─────────────────────────────────────────────────────────

console.log("\n\x1b[1m--from\x1b[0m");
{
  mailbox({ savedAccount: "account1", savedInto: "/Drafts" });
  const res = await call("/reply", { messageId: 2506, body: "hi", identityId: "id1" });
  test("cross-account identity honoured on reply", calls.begin.details.identityId === "id1");
  test("placement judged against the identity's account, not the message's", res.warning === undefined, res.warning);
  test("folder reported as account1's /Drafts",
    res.folder?.path === "/Drafts" && res.folder?.accountId === "account1", JSON.stringify(res.folder));
}
{
  mailbox({ savedAccount: "account1", savedInto: "/Drafts" });
  const res = await call("/forward", { messageId: 2506, to: "x@y.example", body: "b", identityId: "id1" });
  test("cross-account identity honoured on forward", calls.begin.details.identityId === "id1");
  test("forward --from raises no false warning", res.warning === undefined, res.warning);
}
{
  mailbox();
  let err = null;
  try { await call("/forward", { messageId: 2506, to: "x@y.example", identityId: "nope" }); }
  catch (e) { err = e; }
  test("unknown forward identity rejected", /does not belong to any account/.test(err?.message || ""), err?.message);
}

// ─── Draft placement ────────────────────────────────────────────────

console.log("\n\x1b[1mDraft placement\x1b[0m");
{
  mailbox({ savedAccount: "account3", savedInto: "/Drafts" });
  const res = await call("/reply", { messageId: 2506, body: "hi" });
  test("draft filed into Gmail's bare /Drafts is flagged", /\/\[Gmail\]\/Drafts/.test(res.warning || ""), res.warning);
  test("reports the folder it actually landed in", res.folder?.path === "/Drafts", JSON.stringify(res.folder));
  test("still reports the draft id so it can be retrieved", res.messageId === 555);
}
{
  mailbox({ savedAccount: "account3", savedInto: "/Drafts" });
  const res = await call("/compose", { to: "x@y.example", subject: "s", body: "b", identityId: "id2" });
  test("compose passes identity through", calls.begin.details.identityId === "id2");
  test("compose warning resolved against the identity's account", /\/\[Gmail\]\/Drafts/.test(res.warning || ""), res.warning);
}
{
  mailbox({ savedInto: null });
  for (const [path, body] of [
    ["/reply", { messageId: 2506, body: "hi" }],
    ["/forward", { messageId: 2506, to: "x@y.example" }],
    ["/compose", { to: "x@y.example", subject: "s", body: "b" }],
  ]) {
    let err = null;
    try { await call(path, body); } catch (e) { err = e; }
    test(`${path}: unconfirmed save is an error, not draft_saved`, /nothing was written/i.test(err?.message || ""), err?.message);
  }
}

// ─── Reply body, subject and compose mode ───────────────────────────

console.log("\n\x1b[1mReply body and subject\x1b[0m");
{
  const tab = mailbox();
  await call("/reply", { messageId: 2506, body: "hi" });
  test("no body handed to beginReply (it would discard the quote)", calls.begin.details.plainTextBody === undefined);
  test("subject prefixed with Re:", tab().subject === "Re: Devis pour la sortie scolaire", tab().subject);
  test("compose mode never switched via setComposeDetails",
    calls.setDetails.every((d) => d.isPlainText === undefined), JSON.stringify(calls.setDetails));
  test("reply text sits above the quoted original", tab().plainTextBody === "hi\n\n> quoted original", JSON.stringify(tab().plainTextBody));
}
{
  const tab = mailbox({ generated: { subject: "Re: Devis pour la sortie scolaire", isPlainText: true, plainTextBody: "> q" } });
  await call("/reply", { messageId: 2506, body: "hi" });
  test("Thunderbird's own Re: subject kept, not rewritten",
    tab().subject === "Re: Devis pour la sortie scolaire" && calls.setDetails.every((d) => d.subject === undefined));
}
{
  const tab = mailbox();
  await call("/reply", { messageId: 900, body: "hi" });
  test("original already starting with Re: is not double-prefixed", tab().subject === "Re: contrat signé", tab().subject);
}
{
  const tab = mailbox();
  await call("/reply", { messageId: 2506, body: "hi", subject: "Re: custom thread" });
  test("explicit subject overrides the derived one", tab().subject === "Re: custom thread", tab().subject);
}
{
  const tab = mailbox({ generated: { subject: "Re: x", isPlainText: false, body: "<blockquote>q</blockquote>" } });
  const res = await call("/reply", { messageId: 2506, body: "a < b" });
  test("HTML reply: compose mode not switched",
    calls.setDetails.every((d) => d.isPlainText === undefined), JSON.stringify(calls.setDetails));
  test("HTML reply: body escaped and prepended to the quote",
    tab().body === "<p>a &lt; b</p><blockquote>q</blockquote>", JSON.stringify(tab().body));
  test("HTML reply: quotedOriginal reported", res.quotedOriginal === true);
}
{
  mailbox();
  await call("/forward", { messageId: 2506, to: "x@y.example", body: "b" });
  test("forward subject left to Thunderbird", calls.begin.details.subject === undefined);
  test("forward body still passed up front", calls.begin.details.plainTextBody === "b", calls.begin.details.plainTextBody);
}
{
  mailbox();
  const res = await call("/reply", { messageId: 2506, body: "hi", send: true });
  test("send mode is unaffected", res.action === "sent");
}

// ─── Health ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mHealth\x1b[0m");
{
  mailbox();
  const res = await ctx.handleRequest({ method: "GET", path: "/health" });
  test("health reports the real manifest version", res.version === manifest.version, res.version);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
