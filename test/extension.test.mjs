#!/usr/bin/env node
/**
 * Extension background-script tests.
 *
 * Loads the real extension/src/thread-utils.js + background.js (in manifest order) into a vm
 * with a mocked `messenger` API, WebSocket and timers, then drives handleRequest() and the
 * reconnect logic directly. Complements test/quick-test.mjs, which mocks the extension away.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import vm from "vm";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf-8"));

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── Mock environment ───────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  // test helpers
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  fail() { this.readyState = MockWebSocket.CLOSED; this.onerror?.(new Error("refused")); this.onclose?.(); }
}

const timers = [];
const idleListeners = [];
const date = (s) => new Date(s);
const folder = (accountId) => ({ accountId, path: "/INBOX", name: "Inbox" });

function header(id, extra = {}) {
  return {
    id, subject: `Message ${id}`, author: "a@example.org", date: date("2026-01-01T00:00:00Z"),
    read: false, flagged: false, junk: false, size: 10, tags: [], folder: folder("acct1"),
    headerMessageId: `m${id}@example.org`, ...extra,
  };
}

const calls = { query: [], getRaw: [], update: [], sendMessage: [], saveMessage: [], tabsRemove: [] };
let inFlight = 0, maxInFlight = 0;
const track = async (fn) => {
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setImmediate(r));
  try { return await fn(); } finally { inFlight--; }
};

const store = new Map();
const queryHandlers = [];

const accounts = new Map();
const composeTabs = new Map();
let nextComposeTabId = 1;

const messenger = {
  runtime: { getManifest: () => manifest },
  idle: { onStateChanged: { addListener: (fn) => idleListeners.push(fn) } },
  folders: { get: async (id) => ({ id, accountId: "acct1" }) },
  accounts: {
    get: async (accountId) => {
      if (!accounts.has(accountId)) throw new Error(`Account ${accountId} not found`);
      return accounts.get(accountId);
    },
  },
  compose: {
    beginReply: async (messageId, type, details) => {
      const id = nextComposeTabId++;
      const original = store.get(messageId);
      const identityId = details.identityId || accounts.get(original.header.folder.accountId)?.identities?.[0]?.id;
      composeTabs.set(id, {
        type,
        relatedMessageId: messageId,
        identityId,
        plainTextBody: (accounts.get(original.header.folder.accountId)?.identities || [])
          .find((idn) => idn.id === identityId)?.signatureQuotes
          ? `> quoted signature line\n\n-- \nSignature`
          : "",
      });
      return { id };
    },
    beginForward: async (messageId, forwardType, details) => {
      const id = nextComposeTabId++;
      composeTabs.set(id, { type: forwardType, relatedMessageId: messageId, plainTextBody: details.plainTextBody || "" });
      return { id };
    },
    getComposeDetails: async (tabId) => ({ ...composeTabs.get(tabId) }),
    setComposeDetails: async (tabId, details) => {
      Object.assign(composeTabs.get(tabId), details);
    },
    sendMessage: async (tabId) => { calls.sendMessage.push(tabId); },
    saveMessage: async (tabId) => { calls.saveMessage.push(tabId); },
  },
  tabs: {
    remove: async (tabId) => { calls.tabsRemove.push(tabId); composeTabs.delete(tabId); },
  },
  messages: {
    get: (id) => track(async () => {
      if (!store.has(id)) throw new Error(`Message ${id} not found`);
      return store.get(id).header;
    }),
    getFull: (id) => track(async () => {
      if (!store.has(id)) throw new Error(`Message ${id} not found`);
      return store.get(id).full || { contentType: "text/plain", body: `body ${id}`, headers: {} };
    }),
    getRaw: (id) => track(async () => {
      calls.getRaw.push(id);
      const raw = store.get(id)?.raw;
      if (raw === undefined) throw new Error("no raw");
      return raw;
    }),
    query: async (q) => {
      calls.query.push(q);
      for (const h of queryHandlers) {
        const r = h(q);
        if (r) return r;
      }
      return { messages: [] };
    },
    list: async () => ({ messages: [...store.values()].map((s) => s.header) }),
    continueList: async () => null,
    abortList: async () => {},
    update: (id, props) => track(async () => { calls.update.push({ id, props }); }),
    getAttachmentFile: async () => {
      const bytes = randomBytes(100_000);
      attachmentBytes = bytes;
      return { name: "big.bin", size: bytes.length, type: "application/octet-stream", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    },
  },
};
let attachmentBytes = null;

const ctx = vm.createContext({
  console: { log() {}, error() {} },
  WebSocket: MockWebSocket,
  messenger,
  btoa,
  setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
  clearTimeout: (t) => { if (t) t.cleared = true; },
});
for (const script of manifest.background.scripts) {
  const file = join(EXT, script);
  vm.runInContext(readFileSync(file, "utf-8"), ctx, { filename: file });
}
const handle = (method, path, body) => ctx.handleRequest({ method, path, body });
const pendingTimers = () => timers.filter((t) => !t.cleared && !t.fired);
const fireTimer = () => { const t = pendingTimers()[0]; t.fired = true; t.fn(); return t.ms; };
const lastSocket = () => MockWebSocket.instances.at(-1);

console.log("\n\x1b[1m=== extension background tests ===\x1b[0m");

// ─── Manifest ───────────────────────────────────────────────────────

console.log("\n\x1b[1mManifest\x1b[0m");
test("thread-utils.js loads before background.js",
  manifest.background.scripts.indexOf("src/thread-utils.js") < manifest.background.scripts.indexOf("src/background.js"));
test("idle permission declared for wake-up reconnect", manifest.permissions.includes("idle"));

// ─── Reconnect ──────────────────────────────────────────────────────

console.log("\n\x1b[1mReconnect\x1b[0m");
test("connects on load", MockWebSocket.instances.length === 1 && lastSocket().url === "ws://127.0.0.1:7701");
const delays = [];
for (let i = 0; i < 6; i++) {
  lastSocket().fail();
  test(`failure ${i + 1} schedules exactly one retry`, pendingTimers().length === 1, `pending=${pendingTimers().length}`);
  delays.push(fireTimer());
}
test("backoff is 3s → 6s → 12s → capped at 15s", JSON.stringify(delays) === JSON.stringify([3000, 6000, 12000, 15000, 15000, 15000]), JSON.stringify(delays));

lastSocket().open();
lastSocket().fail();
test("successful connection resets backoff to 3s", pendingTimers()[0]?.ms === 3000, `got ${pendingTimers()[0]?.ms}`);
fireTimer();
lastSocket().fail();
fireTimer();
lastSocket().fail();
const beforeIdle = MockWebSocket.instances.length;
idleListeners.forEach((fn) => fn("idle"));
test("idle state does not reconnect", MockWebSocket.instances.length === beforeIdle);
idleListeners.forEach((fn) => fn("active"));
test("returning to active reconnects immediately", MockWebSocket.instances.length === beforeIdle + 1);
test("pending backoff timer is cancelled on wake", pendingTimers().length === 0);

const current = lastSocket();
current.open();
test("reconnection sends an extension-ready beacon", current.sent.some((m) => m.type === "event" && m.name === "extension-ready"));
const stale = new MockWebSocket("stale");
stale.onclose = null;
idleListeners.forEach((fn) => fn("active"));
test("active while connected does not open a second socket", lastSocket() === stale);
current.onmessage({ data: JSON.stringify({ id: "r1", method: "GET", path: "/health" }) });
await new Promise((r) => setImmediate(r));
const healthResponse = current.sent.find((m) => m.id === "r1");
test("requests are answered on the socket they arrived on", healthResponse?.id === "r1" && healthResponse?.result?.status === "ok");
test("health reports the manifest version", healthResponse?.result?.version === manifest.version);

// ─── Thread ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mThread\x1b[0m");
store.clear();
store.set(1, { header: header(1, { subject: "Budget", date: date("2026-01-01T00:00:00Z"), headerMessageId: "root@example.org" }) });
store.set(2, { header: header(2, { subject: "Re: Budget", date: date("2026-01-02T00:00:00Z"), headerMessageId: "mid@example.org" }) });
store.set(3, {
  header: header(3, { subject: "Re: [fin] Budget", date: date("2026-01-03T00:00:00Z"), headerMessageId: "leaf@example.org" }),
  raw: "Message-ID: <leaf@example.org>\r\nReferences: <root@example.org>\r\n <mid@example.org>\r\nIn-Reply-To: <mid@example.org>\r\nSubject: Re: [fin] Budget\r\n\r\nbody",
});
store.set(4, { header: header(4, { subject: "AW: Budget", date: date("2026-01-04T00:00:00Z"), headerMessageId: "late@example.org" }) });
store.set(5, { header: header(5, { subject: "Budget review Q3", date: date("2026-01-05T00:00:00Z"), headerMessageId: "other@example.org" }) });
const byHdrId = new Map([...store.values()].map((s) => [s.header.headerMessageId, s.header]));
queryHandlers.length = 0;
queryHandlers.push((q) => q.headerMessageId && { messages: byHdrId.has(q.headerMessageId) ? [byHdrId.get(q.headerMessageId)] : [] });
queryHandlers.push((q) => q.subject && { messages: [...store.values()].map((s) => s.header).filter((h) => h.subject.includes(q.subject)) });

calls.query.length = 0;
const t = await handle("GET", "/messages/3/thread");
const ids = t.thread.map((m) => m.id);
test("header ids are queried without angle brackets", calls.query.filter((q) => q.headerMessageId).every((q) => !/[<>]/.test(q.headerMessageId)));
test("upstream messages found via folded References", ids.includes(1) && ids.includes(2));
test("downstream reply found by exact normalized subject", ids.includes(4));
test("substring subject match is excluded", !ids.includes(5));
test("thread sorted by date", JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(ids));
test("count matches", t.count === 4);
test("matches labelled by source",
  t.thread.find((m) => m.id === 2)?.threadMatch === "references" && t.thread.find((m) => m.id === 4)?.threadMatch === "subject");
test("subject search excludes junk", calls.query.some((q) => q.subject === "Budget" && q.junk === false));

// getRaw unavailable → getFull headers, still bracket-stripped
store.set(6, {
  header: header(6, { subject: "Re: Budget", headerMessageId: "six@example.org" }),
  full: { headers: { references: ["<root@example.org> <mid@example.org>"], "in-reply-to": ["<mid@example.org>"], "message-id": ["<six@example.org>"] } },
});
const t6 = await handle("GET", "/messages/6/thread");
test("falls back to getFull headers when getRaw fails", t6.thread.some((m) => m.id === 1 && m.threadMatch === "references"));

let missingErr = null;
try { await handle("GET", "/messages/999/thread"); } catch (e) { missingErr = e; }
test("unknown message still reports an error", missingErr?.message.includes("not found"));

// ─── Reply ──────────────────────────────────────────────────────────

console.log("\n\x1b[1mReply\x1b[0m");
accounts.set("acct1", {
  identities: [
    { id: "id1", email: "me@acct1.example" },
    { id: "id2", email: "other@acct1.example" },
  ],
});
accounts.set("acct-quoting", { identities: [{ id: "id3", email: "quoter@example.org", signatureQuotes: true }] });

store.set(20, {
  header: header(20, { author: "sender@example.org", folder: folder("acct1"), recipients: ["me@acct1.example"] }),
  full: { contentType: "text/plain", body: "Original message body" },
});
calls.sendMessage.length = 0; calls.saveMessage.length = 0; calls.tabsRemove.length = 0;
const r1 = await handle("POST", "/reply", { messageId: 20, body: "Thanks" });
test("reply infers identity from addressed recipients", r1.identityId === "id1", r1.identityId);
test("reply without native quote falls back to a deterministic quotation", r1.quotedOriginal === true);
test("default reply action saves a draft and closes the tab", r1.action === "draft_saved" && calls.saveMessage.length === 1 && calls.tabsRemove.length === 1);

const r2 = await handle("POST", "/reply", { messageId: 20, body: "Thanks", identityId: "id2" });
test("explicit identity overrides inference", r2.identityId === "id2");

let identityErr = null;
try { await handle("POST", "/reply", { messageId: 20, body: "Thanks", identityId: "does-not-exist" }); }
catch (e) { identityErr = e; }
test("identity outside the message account is rejected", identityErr?.message.includes("does not belong"));

store.set(21, {
  header: header(21, { author: "sender@example.org", folder: folder("acct-quoting"), recipients: ["quoter@example.org"] }),
  full: { contentType: "text/plain", body: "Original message body" },
});
const r3 = await handle("POST", "/reply", { messageId: 21, body: "Thanks" });
test("native quotation is preserved instead of the deterministic fallback", r3.quotedOriginal === true);

const r4 = await handle("POST", "/reply", { messageId: 20, body: "Thanks", send: true });
test("--send sends immediately", r4.action === "sent" && calls.sendMessage.length === 1);

const r5 = await handle("POST", "/reply", { messageId: 20, body: "Thanks", open: true });
test("--open returns the compose tab without saving or sending", r5.action === "draft_opened" && typeof r5.tabId === "number");

// ─── Conversation history (reply/forward) ────────────────────────────

console.log("\n\x1b[1mConversation history\x1b[0m");

// Message 3 (from the Thread section above) references ancestors 1 and 2.
const rh1 = await handle("POST", "/reply", { messageId: 3, body: "Sounds good", open: true });
const rh1Body = composeTabs.get(rh1.tabId).plainTextBody;
test("reply appends ancestor thread as quoted history",
  rh1Body.includes("Conversation History") && rh1Body.includes("> body 1") && rh1Body.includes("> body 2"));
const rh1History = rh1Body.slice(rh1Body.indexOf("Conversation History"));
test("history section excludes the message being replied to (already quoted above it)", !rh1History.includes("> body 3"));
test("reply history is ordered oldest first", rh1Body.indexOf("> body 1") < rh1Body.indexOf("> body 2"));

const rh2 = await handle("POST", "/reply", { messageId: 3, body: "Sounds good", open: true, includeHistory: false });
test("includeHistory: false opts out for reply", !composeTabs.get(rh2.tabId).plainTextBody.includes("Conversation History"));

const fh1 = await handle("POST", "/forward", { messageId: 3, to: "x@example.org", body: "FYI", open: true });
test("forward appends ancestor thread as quoted history",
  composeTabs.get(fh1.tabId).plainTextBody.includes("Conversation History"));

const fh2 = await handle("POST", "/forward", { messageId: 3, to: "x@example.org", body: "FYI", open: true, includeHistory: false });
test("includeHistory: false opts out for forward", !composeTabs.get(fh2.tabId).plainTextBody.includes("Conversation History"));

const rh3 = await handle("POST", "/reply", { messageId: 20, body: "Thanks", open: true });
test("history is a no-op for a message with no thread", !composeTabs.get(rh3.tabId).plainTextBody.includes("Conversation History"));

// ─── Recent ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mRecent\x1b[0m");
queryHandlers.length = 0;
queryHandlers.push((q) => q.fromDate && {
  messages: [
    header(10, { folder: folder("acct1"), read: false }),
    header(11, { folder: folder("acct2"), read: false }),
    header(12, { folder: folder("acct1"), read: true }),
  ],
});
const all = await handle("POST", "/recent", { hours: 24, limit: 50 });
test("no filters returns every account", all.messages.length === 3);
const acct = await handle("POST", "/recent", { hours: 24, limit: 50, accountId: "acct2" });
test("--account filters by account", acct.messages.length === 1 && acct.messages[0].id === 11);
const unread = await handle("POST", "/recent", { hours: 24, limit: 50, unreadOnly: true });
test("--unread filters read messages", unread.messages.length === 2 && unread.messages.every((m) => !m.read));

// ─── Search ─────────────────────────────────────────────────────────

console.log("\n\x1b[1mSearch\x1b[0m");
calls.query.length = 0;
await handle("POST", "/messages/search", { headerMessageId: "<abc@host>" });
test("headerMessageId forwarded to query without brackets", calls.query[0]?.headerMessageId === "abc@host");
test("junk still excluded by default", calls.query[0]?.junk === false);

// Match beyond the original limit; simulate Thunderbird's native query filters.
queryHandlers.length = 0;
queryHandlers.push((q) => ({ messages: [
  header(20, { tags: [], size: 10 }),
  header(21, { tags: ["$label1"], size: 100 }),
  header(22, { tags: ["$label1"], size: 200 }),
].filter((m) => (!q.tags || Object.entries(q.tags.tags).every(([tag, value]) => m.tags.includes(tag) === value))
  && (q.size?.min === undefined || m.size >= q.size.min)
  && (q.size?.max === undefined || m.size <= q.size.max)) }));
for (const [label, filters, expectedId] of [
  ["tag", { tag: "$label1" }, 21],
  ["minimum size", { sizeMin: 100 }, 21],
  ["maximum size", { sizeMax: 10 }, 20],
  ["tag and inclusive size range", { tag: "$label1", sizeMin: 100, sizeMax: 100 }, 21],
]) {
  const r = await handle("POST", "/messages/search", { ...filters, limit: 1 });
  test(`${label} applied before limit`, r.messages.length === 1 && r.messages[0].id === expectedId);
}
const zeroSize = await handle("POST", "/messages/search", { sizeMax: 0, limit: 1 });
test("zero maximum size is not ignored", zeroSize.total === 0);
test("tag is passed to native query", calls.query.some((q) => q.tags?.mode === "all" && q.tags.tags.$label1 === true));
test("size range is passed to native query", calls.query.some((q) => q.size?.min === 100 && q.size?.max === 100));

// A general query with no field filter searches body, subject, and author via a single
// server-side fullText query (not three parallel per-field queries).
queryHandlers.length = 0;
queryHandlers.push((q) => q.fullText === "widget" ? { messages: [header(30), header(31), header(32)] } : { messages: [] });
calls.query.length = 0;
const fullTextSearch = await handle("POST", "/messages/search", { query: "widget", limit: 10 });
const fullTextIds = fullTextSearch.messages.map((m) => m.id).sort();
test("general query searches via fullText", JSON.stringify(fullTextIds) === JSON.stringify([30, 31, 32]));
test("general query issues exactly one native query", calls.query.length === 1);
test("general query passes fullText, not per-field OR params", calls.query[0]?.fullText === "widget" && calls.query[0]?.body === undefined && calls.query[0]?.subject === undefined);

// An explicit fromAddress filter is an AND constraint alongside fullText, not a
// separate OR branch.
queryHandlers.length = 0;
queryHandlers.push((q) => (q.fullText === "widget" && q.author === "known@example.org")
  ? { messages: [header(34)] } : { messages: [] });
calls.query.length = 0;
const fullTextNarrowed = await handle("POST", "/messages/search", { query: "widget", fromAddress: "known@example.org", limit: 10 });
test("explicit fromAddress filter is ANDed with fullText in a single query",
  calls.query.length === 1 && calls.query[0]?.author === "known@example.org" && calls.query[0]?.fullText === "widget");
test("general query results still returned with a narrowing filter", fullTextNarrowed.messages.some((m) => m.id === 34));

// Test the shared collector with Thunderbird-sized pages, not one record per page.
const previousContinue = messenger.messages.continueList;
const previousAbort = messenger.messages.abortList;
const continued = [], aborted = [];
let pages;
messenger.messages.continueList = async (id) => {
  continued.push(id);
  const page = pages.get(id);
  if (page instanceof Error) throw page;
  return page;
};
messenger.messages.abortList = async (id) => { aborted.push(id); };
async function collect(first, following = [], limit = 1, options = {}) {
  pages = new Map(following);
  continued.length = 0;
  aborted.length = 0;
  return ctx.collectMessages(async () => first, limit, options);
}
let pageResult = await collect({ messages: [header(30), header(31)] });
test("truncation inside final page reports hasMore", pageResult.total === 1 && pageResult.hasMore);
pageResult = await collect({ messages: [header(30)] });
test("exact limit on final page reports no more", pageResult.total === 1 && !pageResult.hasMore);
pageResult = await collect({ messages: [] });
test("empty result reports no more", pageResult.total === 0 && !pageResult.hasMore);
pageResult = await collect({ id: "next", messages: [header(30)] }, [["next", { messages: [header(31)] }]]);
test("lookahead finds a match on next page", pageResult.hasMore && continued.length === 1);
pageResult = await collect({ id: "next", messages: [header(30)] }, [["next", { messages: [] }]]);
test("empty trailing page does not imply more results", !pageResult.hasMore);
pageResult = await collect({ messages: [header(30), header(31, { read: true })] }, [], 1, { unreadOnly: true });
test("filtered tail does not imply more results", !pageResult.hasMore);
pageResult = await collect({ id: "next", messages: [header(30)] }, [["next", {
  id: "last", messages: [header(31, { read: true })],
}], ["last", { messages: [header(32)] }]], 1, { unreadOnly: true });
test("lookahead crosses filtered pages", pageResult.hasMore && continued.length === 2);
pageResult = await collect({ messages: [header(30), header(31), header(32)] }, [], 1, { offset: 1 });
test("offset skips matches before limit and lookahead", pageResult.messages[0]?.id === 31 && pageResult.offset === 1 && pageResult.hasMore);
pageResult = await collect({ id: "next", messages: [header(30), header(31)] }, [], 1);
test("early completion releases Thunderbird list", pageResult.hasMore && aborted[0] === "next" && continued.length === 0);
pageResult = await collect({ id: "next", messages: [header(30)] }, [["next", { messages: [header(31)] }]], Infinity);
test("unbounded callers still collect all pages", pageResult.total === 2 && !pageResult.hasMore);
let pageError;
try { await collect({ id: "next", messages: [header(30)] }, [["next", new Error("page failed")]]); }
catch (e) { pageError = e; }
test("pagination errors propagate and release list", pageError?.message === "page failed" && aborted[0] === "next");
messenger.messages.continueList = previousContinue;
messenger.messages.abortList = previousAbort;

// ─── Read batch / bulk ──────────────────────────────────────────────

console.log("\n\x1b[1mBatch and bulk\x1b[0m");
store.clear();
for (let i = 1; i <= 40; i++) store.set(i, { header: header(i, { tags: i % 2 ? ["$label1"] : [] }), raw: "x" });
const batchIds = [...Array(40).keys()].map((i) => i + 1).reverse();
maxInFlight = 0;
await handle("POST", "/messages/read-batch", { messageIds: batchIds });
// 8 operations × (get + getFull)
test(`in-flight messenger calls bounded (max ${maxInFlight} ≤ 16)`, maxInFlight > 2 && maxInFlight <= 16);

batchIds.splice(5, 0, 404);
const batch = await handle("POST", "/messages/read-batch", { messageIds: batchIds });
test("read-batch preserves request order", JSON.stringify(batch.map((m) => m.id)) === JSON.stringify(batchIds));
test("read-batch reports per-message errors", batch[5].error?.includes("not found") && batch[6].parts?.text === "body 35");
test("read-batch with no ids returns []", JSON.stringify(await handle("POST", "/messages/read-batch", {})) === "[]");

calls.update.length = 0;
const tagged = await handle("POST", "/bulk/tag", { folderId: "f1", tagKey: "$label1", limit: 100 });
test("bulk tag only touches untagged messages", tagged.tagged === 20 && calls.update.length === 20);
test("bulk tag appends to existing tags", calls.update.every((u) => u.props.tags.at(-1) === "$label1"));

calls.getRaw.length = 0;
store.get(7).raw = undefined;
const fetched = await handle("POST", "/bulk/fetch", { folderId: "f1", limit: 100 });
test("bulk fetch counts successes", fetched.fetched === 39 && fetched.total === 40);

// ─── Attachment ─────────────────────────────────────────────────────

console.log("\n\x1b[1mAttachment\x1b[0m");
const att = await handle("POST", "/messages/1/attachment", { partName: "1.2" });
test("chunked base64 matches Node's encoder (100 KB, multi-chunk)", att.data === attachmentBytes.toString("base64"));

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
