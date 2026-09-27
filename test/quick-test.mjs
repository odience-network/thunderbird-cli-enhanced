#!/usr/bin/env node
/**
 * Quick test — single process, no subprocess spawning.
 * Directly imports and tests the HTTP client against a mock bridge.
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";

const PORT = 19700;
const WS_PORT = 19701;
let passed = 0, failed = 0;

function handle({ method, path, body }) {
  if (path === "/health") return { status: "ok", version: "2.0.0", thunderbird: true };
  if (path === "/access" && method === "GET") return { policy: { delete: false, folderDelete: false } };
  if (path === "/accounts") return [{ id: "acct1", name: "Test", type: "imap", identities: [{ id: "id1", email: "t@t.com", name: "T" }], rootFolder: { id: "rf", name: "" } }];
  if (path?.match(/^\/accounts\/[^/]+$/) && method === "GET") return { id: "acct1", name: "Test" };
  if (path?.match(/^\/accounts\/[^/]+\/folders$/)) return [{ id: "f1", name: "Inbox", path: "/Inbox", type: "inbox", depth: 0, unreadMessageCount: 5, totalMessageCount: 50 }];
  if (path === "/identities") return [{ id: "id1", email: "t@t.com", accountId: "acct1" }];
  if (path === "/folders/info") return { id: body?.folderId, name: "Inbox", type: "inbox", unreadMessageCount: 5, totalMessageCount: 50 };
  if (path === "/folders/create") return { success: true, folder: { id: "fn", name: body?.name } };
  if (path === "/folders/rename") return { success: true, folder: { id: body?.folderId, name: body?.newName } };
  if (path === "/folders/delete") return { success: true };
  if (path === "/messages/search") return { messages: [{ id: 1, subject: "Test", author: "a@b.com", date: "2026-04-01", read: false, flagged: false, junk: false, size: 100, tags: [], folder: { accountId: "acct1", path: "/Inbox" } }], total: 1 };
  if (path === "/messages/list") return { messages: [{ id: 1, subject: "Test", author: "a@b.com", date: "2026-04-01", read: false, flagged: false, junk: false, size: 100, tags: ["$l1"], folder: { accountId: "acct1", path: "/Inbox" } }], total: 1 };
  if (path === "/messages/read-batch") return (body?.messageIds || []).map(id => ({ id, subject: "T", parts: { text: "Hello" } }));
  if (path === "/messages/fetch") return body?.messageId ? { downloaded: true, size: 100 } : { fetched: 2, total: 2 };
  if (path === "/messages/archive") return { success: true, archived: (body?.messageIds || []).length };
  if (path === "/messages/move") return { success: true, moved: (body?.messageIds || []).length };
  if (path === "/messages/copy") return { success: true, copied: (body?.messageIds || []).length };
  if (path === "/messages/delete") return { success: true, deleted: (body?.messageIds || []).length };
  if (path === "/messages/update") return { success: true };
  if (path?.match(/\/raw$/)) return { raw: "From: a@b\nSubject: T\n\nBody" };
  if (path?.match(/\/headers$/)) return { id: 1, subject: "T", author: "a@b" };
  if (path?.match(/\/full$/)) return { id: 1, subject: "T", parts: { text: "Hello", html: "<p>Hello</p>", attachments: [] } };
  if (path?.match(/\/check-download$/)) return { id: 1, downloadState: "full", size: 100, hasBody: true };
  if (path?.match(/\/download-status$/)) return { state: "full", size: 100 };
  if (path?.match(/\/attachments$/)) return [{ name: "f.pdf", contentType: "application/pdf", partName: "1.2", size: 5000 }];
  if (path?.match(/\/attachment$/) && method === "POST") return { name: "f.pdf", size: 5000, data: "SGVsbG8=" };
  if (path?.match(/\/thread$/)) return { thread: [{ id: 1, subject: "T" }], count: 1 };
  if (path?.match(/^\/messages\/\d+$/) && method === "GET") return { id: 1, subject: "T", author: "a@b", date: "2026-04-01", read: false, flagged: false, junk: false, size: 100, tags: ["$l1"], folder: null, parts: { text: "Hello world", html: "", attachments: [] } };
  if (path === "/tags") return [{ key: "$l1", tag: "Important", color: "#FF0000" }];
  if (path === "/tags/create") return { success: true, ...body };
  if (path === "/compose") return { success: true, action: body?.send ? "sent" : body?.open ? "draft_opened" : "draft_saved" };
  if (path === "/compose/edit") {
    if (!body?.messageId) return { error: "messageId is required" };
    const action = body?.send ? "sent" : body?.open ? "draft_opened" : "draft_saved";
    return {
      success: true,
      action,
      messageId: body?.send ? undefined : (body.messageId + 1000),
      previousMessageId: body.messageId,
      ...(body?.open ? { tabId: 42 } : {}),
    };
  }
  if (path === "/reply") return { success: true, action: body?.send ? "sent" : "draft_saved" };
  if (path === "/forward") return { success: true, action: body?.send ? "sent" : "draft_saved" };
  if (path === "/stats") return { totalAccounts: 1, totalUnread: 5, totalMessages: 100, accounts: [] };
  if (path === "/recent") return { messages: [], total: 0, since: new Date().toISOString() };
  if (path === "/contacts/search") return [{ id: "c1", name: "John", email: "j@e.com" }];
  if (path === "/contacts" && method === "GET") return [{ id: "c1", name: "John", email: "j@e.com", book: "P" }];
  if (path?.match(/^\/contacts\/[^/]+$/)) return { id: "c1", properties: { DisplayName: "John" } };
  if (path === "/sync") return { success: true, synced: body?.all ? "all" : body?.folderId };
  if (path === "/sync/status") return { folderId: body?.folderId, totalMessages: 50, unread: 5 };
  if (path === "/bulk/delete") return { success: true, deleted: 3 };
  if (path === "/bulk/tag") return { success: true, tagged: 5 };
  if (path === "/bulk/fetch") return { success: true, fetched: 10, total: 10 };
  if (path === "/extension/reload") return { ok: true, reloading: true, message: "Extension reloading" };
  return { error: `Not found: ${method} ${path}` };
}

async function startBridge() {
  return new Promise((resolve) => {
    const pending = new Map();
    let extSock = null;
    const recentEvents = [];
    const eventWaiters = []; // { name, since, resolve, timer }
    const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
    wss.on("connection", ws => {
      extSock = ws;
      ws.on("message", d => {
        const m = JSON.parse(d.toString());

        // Response to a pending request.
        if (m.id !== undefined) {
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.result); }
          return;
        }

        // Unsolicited event from the extension.
        if (m.type === "event") {
          const event = { name: m.name, data: m.data || {}, receivedAt: Date.now() };
          recentEvents.push(event);
          for (let i = eventWaiters.length - 1; i >= 0; i--) {
            const w = eventWaiters[i];
            if (w.name === event.name && event.receivedAt >= w.since) {
              eventWaiters.splice(i, 1);
              clearTimeout(w.timer);
              w.resolve({ event });
            }
          }
        }
      });
    });
    const httpServer = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/bridge/status") { res.writeHead(200); res.end(JSON.stringify({ bridge: "running", extension: "connected" })); return; }

      if (req.url.startsWith("/bridge/events")) {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
        const waitName = url.searchParams.get("wait");
        const since = parseInt(url.searchParams.get("since") || "0");
        const eventTimeoutMs = parseInt(url.searchParams.get("timeout") || "30000");

        if (!waitName) {
          res.writeHead(200);
          res.end(JSON.stringify({ events: recentEvents.filter(e => e.receivedAt >= since) }));
          return;
        }

        const found = recentEvents.find(e => e.name === waitName && e.receivedAt >= since);
        if (found) { res.writeHead(200); res.end(JSON.stringify({ event: found })); return; }

        const timer = setTimeout(() => {
          const idx = eventWaiters.findIndex(w => w.resolve === resolveWaiter);
          if (idx !== -1) eventWaiters.splice(idx, 1);
          res.writeHead(408);
          res.end(JSON.stringify({ error: "Event timeout", code: "EVENT_TIMEOUT" }));
        }, eventTimeoutMs);
        const resolveWaiter = (data) => { res.writeHead(200); res.end(JSON.stringify(data)); };
        eventWaiters.push({ name: waitName, since, resolve: resolveWaiter, timer });
        return;
      }

      let b = ""; for await (const c of req) b += c;
      let pb = null; if (b.trim()) try { pb = JSON.parse(b); } catch {}
      try {
        const result = await new Promise((resolve, reject) => {
          if (!extSock || extSock.readyState !== 1) { reject(new Error("no ext")); return; }
          const id = randomUUID();
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, 5000);
          pending.set(id, { resolve, reject, timer });
          extSock.send(JSON.stringify({ id, method: req.method, path: req.url, body: pb }));
        });
        res.writeHead(200); res.end(JSON.stringify(result));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    httpServer.listen(PORT, "127.0.0.1", () => {
      const mock = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      mock.on("open", () => {
        // Send the startup beacon like the real extension does on every WS connect.
        mock.send(JSON.stringify({ type: "event", name: "extension-ready", data: {} }));
        resolve({ httpServer, wss, mock });
      });
      mock.on("message", d => {
        const r = JSON.parse(d.toString());
        mock.send(JSON.stringify({ id: r.id, result: handle(r) }));
      });
    });
  });
}

// ─── Direct HTTP test (no CLI subprocess) ──────────────────────────

async function httpCall(method, path, body = null) {
  const url = `http://127.0.0.1:${PORT}${path}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return await res.json();
}

function test(name, result, check) {
  if (check(result)) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${JSON.stringify(result).slice(0, 200)}`);
  }
}

const servers = await startBridge();
await new Promise(r => setTimeout(r, 300));

console.log("\n\x1b[1m=== thunderbird-cli API Tests ===\x1b[0m\n");

console.log("\x1b[1mConnection\x1b[0m");
test("GET /health", await httpCall("GET", "/health"), r => r.status === "ok");
test("GET /bridge/status", await httpCall("GET", "/bridge/status"), r => r.bridge === "running");
test("GET /access", await httpCall("GET", "/access"), r => r.policy?.delete === false);

console.log("\n\x1b[1mAccounts\x1b[0m");
test("GET /accounts", await httpCall("GET", "/accounts"), r => Array.isArray(r) && r.length === 1);
test("GET /accounts/:id", await httpCall("GET", "/accounts/acct1"), r => r.id === "acct1");
test("GET /identities", await httpCall("GET", "/identities"), r => Array.isArray(r) && r[0]?.email);
test("GET /accounts/:id/folders", await httpCall("GET", "/accounts/acct1/folders"), r => Array.isArray(r));

console.log("\n\x1b[1mFolders\x1b[0m");
test("POST /folders/info", await httpCall("POST", "/folders/info", { folderId: "f1" }), r => r.name === "Inbox");
test("POST /folders/create", await httpCall("POST", "/folders/create", { parentFolderId: "f1", name: "New" }), r => r.success);
test("POST /folders/rename", await httpCall("POST", "/folders/rename", { folderId: "f1", newName: "X" }), r => r.success);
test("POST /folders/delete", await httpCall("POST", "/folders/delete", { folderId: "f1" }), r => r.success);

console.log("\n\x1b[1mSearch & List\x1b[0m");
test("POST /messages/search", await httpCall("POST", "/messages/search", { query: "test", limit: 25 }), r => r.messages?.length >= 0);
test("POST /messages/list", await httpCall("POST", "/messages/list", { folderId: "f1", limit: 25 }), r => r.messages?.length >= 0);

console.log("\n\x1b[1mRead\x1b[0m");
test("GET /messages/1", await httpCall("GET", "/messages/1"), r => r.id === 1 && r.parts);
test("GET /messages/1/raw", await httpCall("GET", "/messages/1/raw"), r => r.raw);
test("GET /messages/1/headers", await httpCall("GET", "/messages/1/headers"), r => r.id === 1);
test("GET /messages/1/full", await httpCall("GET", "/messages/1/full"), r => r.parts?.html !== undefined);
test("GET /messages/1/thread", await httpCall("GET", "/messages/1/thread"), r => r.thread);
test("GET /messages/1/check-download", await httpCall("GET", "/messages/1/check-download"), r => r.downloadState);
test("GET /messages/1/download-status", await httpCall("GET", "/messages/1/download-status"), r => r.state === "full");
test("GET /messages/1/attachments", await httpCall("GET", "/messages/1/attachments"), r => Array.isArray(r));
test("POST /messages/1/attachment", await httpCall("POST", "/messages/1/attachment", { partName: "1.2" }), r => r.data);
test("POST /messages/read-batch", await httpCall("POST", "/messages/read-batch", { messageIds: [1, 2] }), r => Array.isArray(r) && r.length === 2);

console.log("\n\x1b[1mActions\x1b[0m");
test("POST /messages/move", await httpCall("POST", "/messages/move", { messageIds: [1], destinationFolderId: "f2" }), r => r.success);
test("POST /messages/copy", await httpCall("POST", "/messages/copy", { messageIds: [1], destinationFolderId: "f2" }), r => r.success);
test("POST /messages/delete", await httpCall("POST", "/messages/delete", { messageIds: [1] }), r => r.success);
test("POST /messages/archive", await httpCall("POST", "/messages/archive", { messageIds: [1, 2] }), r => r.success && r.archived === 2);
test("POST /messages/update", await httpCall("POST", "/messages/update", { messageId: 1, read: true }), r => r.success);
test("POST /messages/fetch", await httpCall("POST", "/messages/fetch", { messageId: 1 }), r => r.downloaded);

console.log("\n\x1b[1mTags\x1b[0m");
test("GET /tags", await httpCall("GET", "/tags"), r => Array.isArray(r));
test("POST /tags/create", await httpCall("POST", "/tags/create", { key: "k", tag: "T", color: "#FFF" }), r => r.success);

console.log("\n\x1b[1mCompose\x1b[0m");
test("POST /compose draft", await httpCall("POST", "/compose", { to: "a@b", subject: "T", body: "Hi" }), r => r.success && r.action === "draft_saved");
test("POST /compose send", await httpCall("POST", "/compose", { to: "a@b", body: "Hi", send: true }), r => r.action === "sent");
test("POST /compose open", await httpCall("POST", "/compose", { to: "a@b", body: "Hi", open: true }), r => r.action === "draft_opened");
test("POST /compose/edit draft", await httpCall("POST", "/compose/edit", { messageId: 10, body: "Revised" }), r => r.success && r.action === "draft_saved" && r.messageId === 1010 && r.previousMessageId === 10);
test("POST /compose/edit open", await httpCall("POST", "/compose/edit", { messageId: 10, open: true }), r => r.action === "draft_opened" && r.tabId === 42);
test("POST /compose/edit send", await httpCall("POST", "/compose/edit", { messageId: 10, subject: "Go", send: true }), r => r.action === "sent" && r.previousMessageId === 10);
test("POST /reply", await httpCall("POST", "/reply", { messageId: 1, body: "Thanks" }), r => r.success);
test("POST /forward", await httpCall("POST", "/forward", { messageId: 1, to: "c@d", body: "FYI" }), r => r.success);

console.log("\n\x1b[1mStats & Recent\x1b[0m");
test("GET /stats", await httpCall("GET", "/stats"), r => r.totalAccounts === 1);
test("POST /stats", await httpCall("POST", "/stats", { accountId: "acct1" }), r => r.totalAccounts !== undefined);
test("POST /recent", await httpCall("POST", "/recent", { hours: 24, limit: 50 }), r => r.messages !== undefined);

console.log("\n\x1b[1mContacts\x1b[0m");
test("GET /contacts", await httpCall("GET", "/contacts"), r => Array.isArray(r));
test("POST /contacts/search", await httpCall("POST", "/contacts/search", { query: "john" }), r => Array.isArray(r));
test("GET /contacts/c1", await httpCall("GET", "/contacts/c1"), r => r.id === "c1");

console.log("\n\x1b[1mSync\x1b[0m");
test("POST /sync", await httpCall("POST", "/sync", { all: true }), r => r.success);
test("POST /sync/status", await httpCall("POST", "/sync/status", { folderId: "f1" }), r => r.totalMessages);

console.log("\n\x1b[1mBulk\x1b[0m");
test("POST /bulk/delete", await httpCall("POST", "/bulk/delete", { folderId: "f1" }), r => r.success);
test("POST /bulk/tag", await httpCall("POST", "/bulk/tag", { folderId: "f1", tagKey: "$l1" }), r => r.success);
test("POST /bulk/fetch", await httpCall("POST", "/bulk/fetch", { folderId: "f1" }), r => r.success);

console.log("\n\x1b[1mExtension Management\x1b[0m");
test("POST /extension/reload", await httpCall("POST", "/extension/reload", {}), r => r.ok && r.reloading);

console.log("\n\x1b[1mBridge Events\x1b[0m");
test("GET /bridge/events returns buffered events", await httpCall("GET", "/bridge/events"), r => Array.isArray(r.events) && r.events.some(e => e.name === "extension-ready"));
test("GET /bridge/events?wait=extension-ready (from buffer)", await httpCall("GET", "/bridge/events?wait=extension-ready&since=0&timeout=1000"), r => r.event?.name === "extension-ready");
test("GET /bridge/events?wait=nonexistent (timeout)", await httpCall("GET", "/bridge/events?wait=nonexistent&since=0&timeout=500"), r => r.code === "EVENT_TIMEOUT");

// Live push: start a long-poll wait, then push a matching event over the mock WS.
const liveWait = httpCall("GET", "/bridge/events?wait=test-event&since=0&timeout=3000");
await new Promise(r => setTimeout(r, 200)); // ensure the waiter is registered before the push
servers.mock.send(JSON.stringify({ type: "event", name: "test-event", data: { hello: "world" } }));
test("GET /bridge/events?wait=test-event (live push)", await liveWait, r => r.event?.name === "test-event" && r.event?.data?.hello === "world");

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);

servers.mock.close();
servers.wss.close();
servers.httpServer.close();
process.exit(failed > 0 ? 1 : 0);
