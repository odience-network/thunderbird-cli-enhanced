/**
 * Thunderbird CLI Enhanced — Background Script (v2)
 *
 * Pure WebExtension — no Experiment APIs.
 * Connects to local Node.js bridge via WebSocket.
 * Handles requests using messenger.* APIs.
 */

const WS_URL = "ws://127.0.0.1:7701";
// Reconnect backoff while the bridge is absent: 3s, 6s, 12s, then every 15s. Cuts idle wakeups
// without making a freshly started bridge wait long for the extension.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 15000;
// Max per-message operations (each one or two messenger.* calls) in flight across all requests.
const IPC_CONCURRENCY = 8;
const BASE64_CHUNK_SIZE = 0x8000;
const FOLDER_INFO_CACHE_TTL_MS = 30000;
const FOLDER_INFO_CACHE_MAX_SIZE = 500;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let ipcInFlight = 0;
const ipcQueue = [];
const folderInfoCache = new Map(); // folderId -> { info, expiresAt }
let connectionState = "connecting";

// ─── Toolbar Indicator ─────────────────────────────────────────────

const STATUS_COLORS = {
  connected: "#4CAF50",
  disconnected: "#F44336",
  connecting: "#FF9800",
};

const STATUS_TITLES = {
  connected: "Thunderbird CLI Enhanced — Connected",
  disconnected: "Thunderbird CLI Enhanced — Disconnected",
  connecting: "Thunderbird CLI Enhanced — Connecting…",
};

function createIconWithDot(size, dotColor) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  const img = new Image();
  img.src = browser.runtime.getURL(`icons/icon-${size}.png`);

  return new Promise((resolve) => {
    img.onload = () => {
      ctx.drawImage(img, 0, 0, size, size);

      const radius = Math.max(Math.round(size * 0.18), 2);
      const cx = size - radius - 1;
      const cy = size - radius - 1;

      ctx.save();
      ctx.shadowColor = dotColor;
      ctx.shadowBlur = Math.max(Math.round(size * 0.25), 2);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fillStyle = dotColor;
      ctx.fill();

      resolve(ctx.getImageData(0, 0, size, size));
    };
    img.onerror = () => {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
      ctx.fillStyle = dotColor;
      ctx.fill();
      resolve(ctx.getImageData(0, 0, size, size));
    };
  });
}

async function updateBrowserAction(state) {
  connectionState = state;
  try {
    const color = STATUS_COLORS[state] || STATUS_COLORS.disconnected;
    const imageData = {
      16: await createIconWithDot(16, color),
      48: await createIconWithDot(48, color),
    };
    browser.browserAction.setIcon({ imageData });
    browser.browserAction.setTitle({ title: STATUS_TITLES[state] || STATUS_TITLES.disconnected });
  } catch (e) {
    console.log("[tb-ai] browserAction update failed:", e.message);
  }
}

// ─── WebSocket Connection ───────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.log("[tb-ai] WebSocket create failed:", err.message);
    updateBrowserAction("disconnected");
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    console.log("[tb-ai] Connected to bridge");
    reconnectDelay = RECONNECT_BASE_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    updateBrowserAction("connected");
    // Unsolicited beacon so a waiting `tb extension-reload` can detect this reconnection,
    // distinguishing it from a reload of some earlier connection.
    try {
      socket.send(JSON.stringify({ type: "event", name: "extension-ready", data: {} }));
    } catch (e) {
      console.log("[tb-ai] Failed to send extension-ready beacon:", e.message);
    }
  };

  socket.onmessage = async (event) => {
    let request;
    try {
      request = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    try {
      const result = await handleRequest(request);
      socket.send(JSON.stringify({ id: request.id, result }));
    } catch (err) {
      socket.send(JSON.stringify({
        id: request.id,
        error: { message: err.message, code: err.code, stack: err.stack },
      }));
    }
  };

  // Only clear `ws` if it is still this socket: a late event from a replaced socket must not
  // drop the current connection.
  socket.onclose = () => {
    console.log("[tb-ai] Disconnected from bridge");
    if (ws === socket) ws = null;
    updateBrowserAction("disconnected");
    scheduleReconnect();
  };

  socket.onerror = () => {
    console.log("[tb-ai] WebSocket error, will reconnect");
    if (ws === socket) ws = null;
    updateBrowserAction("disconnected");
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Start connection
connect();

// Coming back from idle or sleep: retry right away instead of waiting out the backoff.
if (typeof messenger !== "undefined" && messenger.idle?.onStateChanged) {
  messenger.idle.onStateChanged.addListener((state) => {
    if (state !== "active") return;
    reconnectDelay = RECONNECT_BASE_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  });
}

// ─── Request Router ─────────────────────────────────────────────────

async function handleRequest({ method, path, body }) {
  // Health
  if (path === "/health") {
    return { status: "ok", version: messenger.runtime.getManifest().version, thunderbird: true };
  }

  // Access policy of the loaded add-on (build-time; see access-control.js)
  if (path === "/access" && method === "GET") {
    return { policy: ACCESS_POLICY };
  }

  enforceAccess(method, path, body);

  // ─── Accounts ───────────────────────────────────────────────────

  if (path === "/accounts" && method === "GET") {
    const accounts = await messenger.accounts.list(true);
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      identities: a.identities?.map((id) => ({
        email: id.email, name: id.name, id: id.id,
      })),
      rootFolder: a.rootFolder
        ? { id: a.rootFolder.id, name: a.rootFolder.name }
        : null,
    }));
  }

  // Account by ID
  const acctMatch = path.match(/^\/accounts\/([^/]+)$/);
  if (acctMatch && method === "GET") {
    const account = await messenger.accounts.get(acctMatch[1], true);
    if (!account) return { error: "Account not found" };
    return account;
  }

  // Account folders
  const foldersMatch = path.match(/^\/accounts\/([^/]+)\/folders$/);
  if (foldersMatch && method === "GET") {
    const account = await messenger.accounts.get(foldersMatch[1], true);
    if (!account) return { error: "Account not found" };
    return await flattenFolders(account.rootFolder);
  }

  // ─── Identities ────────────────────────────────────────────────

  if (path === "/identities" && method === "GET") {
    const accounts = await messenger.accounts.list(true);
    const identities = [];
    for (const acct of accounts) {
      for (const id of (acct.identities || [])) {
        identities.push({ id: id.id, email: id.email, name: id.name, accountId: acct.id });
      }
    }
    return identities;
  }

  // ─── Folders ────────────────────────────────────────────────────

  if (path === "/folders/info" && method === "POST") {
    const { folderId } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    if (!folder) return { error: "Folder not found" };
    let info = {};
    try { info = await messenger.folders.getFolderInfo(folder); } catch {}
    return {
      id: folder.id, name: folder.name, path: folder.path, type: folder.type,
      unreadMessageCount: info.unreadMessageCount || 0,
      totalMessageCount: info.totalMessageCount || 0,
      newMessageCount: info.newMessageCount || 0,
      accountId: folder.accountId,
    };
  }

  if (path === "/folders/create" && method === "POST") {
    const { parentFolderId, name } = body || {};
    const parent = await messenger.folders.get(parentFolderId, false);
    const newFolder = await messenger.folders.create(parent, name);
    return { success: true, folder: { id: newFolder.id, name: newFolder.name, path: newFolder.path } };
  }

  if (path === "/folders/rename" && method === "POST") {
    const { folderId, newName } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    const renamed = await messenger.folders.rename(folder, newName);
    return { success: true, folder: { id: renamed.id, name: renamed.name, path: renamed.path } };
  }

  if (path === "/folders/delete" && method === "POST") {
    const { folderId } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    await messenger.folders.delete(folder);
    return { success: true };
  }

  // ─── Search ─────────────────────────────────────────────────────

  if (path === "/messages/search" && method === "POST") {
    const { query, accountId, fromAddress, toAddress, subject,
            unreadOnly, flagged, limit = 25, fromDate, toDate,
            folderId, tag, hasAttachment, sizeMin, sizeMax,
            includeJunk, headerMessageId } = body || {};

    // Build base query with all non-general-query (AND) filters.
    const baseQ = {};
    if (accountId) baseQ.accountId = accountId;
    if (fromAddress) baseQ.author = fromAddress;
    if (toAddress) baseQ.recipients = toAddress;
    if (subject) baseQ.subject = subject;
    if (headerMessageId) baseQ.headerMessageId = stripAngleBrackets(headerMessageId);
    if (unreadOnly) baseQ.unread = true;
    if (flagged !== undefined) baseQ.flagged = flagged;
    if (fromDate) baseQ.fromDate = new Date(fromDate);
    if (toDate) baseQ.toDate = new Date(toDate);
    if (folderId) baseQ.folderId = folderId;
    if (hasAttachment) baseQ.attachment = true;
    if (!includeJunk) baseQ.junk = false;
    if (tag) baseQ.tags = { mode: "all", tags: { [tag]: true } };
    if (sizeMin != null || sizeMax != null) {
      baseQ.size = {};
      if (sizeMin != null) baseQ.size.min = sizeMin;
      if (sizeMax != null) baseQ.size.max = sizeMax;
    }

    if (!query) {
      // No general query — single search with base filters only.
      return await collectMessages(
        () => messenger.messages.query({ ...baseQ, autoPaginationTimeout: 200 }),
        limit
      );
    }

    // Use fullText (subject + body + author, server-side OR) — one query instead of the
    // previous 3-parallel-query approach that was catastrophically slow on large folders
    // (body search alone took 30s on 50k messages).
    const result = await collectMessages(
      () => messenger.messages.query({
        ...baseQ,
        fullText: query,
        autoPaginationTimeout: 200,
      }),
      limit
    );
    result.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    const hasMore = result.messages.length > limit;
    const messages = result.messages.slice(0, limit);

    return { messages, total: messages.length, offset: 0, hasMore };
  }

  // ─── List messages in folder ────────────────────────────────────

  if (path === "/messages/list" && method === "POST") {
    const { folderId, limit = 25, unreadOnly = false,
            offset = 0, sort, sortOrder = "desc", flagged } = body || {};
    const folder = await messenger.folders.get(folderId, false);
    if (!folder) return { error: "Folder not found" };

    const sortMap = { date: "date", from: "author", subject: "subject", size: "size" };
    const effectiveSort = sort || "date";
    const effectiveOrder = sortOrder || "desc";

    // When filtering by unread/flagged, use query() for server-side filtering.
    // messages.list() only supports client-side filtering in collectMessages —
    // catastrophically slow on large folders (20s to find 3 unread among 50k).
    // query() with read/flagged uses the indexed msgDatabase → instant.
    if (unreadOnly || flagged) {
      const q = { folderId, autoPaginationTimeout: 200 };
      if (unreadOnly) q.unread = true;
      if (flagged) q.flagged = true;
      const result = await collectMessages(
        () => messenger.messages.query(q), limit, { offset }
      );
      // query() doesn't support sortType — sort client-side (result set is small)
      const dir = effectiveOrder === "asc" ? 1 : -1;
      result.messages.sort((a, b) => {
        if (effectiveSort === "date") return dir * (new Date(a.date) - new Date(b.date));
        if (effectiveSort === "from") return dir * (a.author || "").localeCompare(b.author || "");
        if (effectiveSort === "subject") return dir * (a.subject || "").localeCompare(b.subject || "");
        if (effectiveSort === "size") return dir * ((a.size || 0) - (b.size || 0));
        return 0;
      });
      return result;
    }

    // No flag filtering — use messages.list() with server-side sort (TB 148+)
    const ver = await tbMajor();
    if (ver >= 148 && sortMap[effectiveSort]) {
      const result = await collectMessages(
        () => messenger.messages.list(folder, {
          sortType: sortMap[effectiveSort],
          sortOrder: effectiveOrder === "asc" ? "ascending" : "descending",
        }),
        limit, { offset }
      );
      return result;
    }

    // Fallback (TB < 148 or unsupported sort type): fetch pages + sort in JS
    const result = await collectMessages(
      () => messenger.messages.list(folder), limit, { offset }
    );
    const dir = effectiveOrder === "asc" ? 1 : -1;
    result.messages.sort((a, b) => {
      if (effectiveSort === "date") return dir * (new Date(a.date) - new Date(b.date));
      if (effectiveSort === "from") return dir * (a.author || "").localeCompare(b.author || "");
      if (effectiveSort === "subject") return dir * (a.subject || "").localeCompare(b.subject || "");
      if (effectiveSort === "size") return dir * ((a.size || 0) - (b.size || 0));
      return 0;
    });

    return result;
  }

  // ─── Read batch ─────────────────────────────────────────────────

  if (path === "/messages/read-batch" && method === "POST") {
    const { messageIds } = body || {};
    return await mapWithIpcLimit(messageIds || [], async (id) => {
      try {
        const [msg, full] = await Promise.all([
          messenger.messages.get(id),
          messenger.messages.getFull(id),
        ]);
        return { ...formatMessage(msg), parts: extractParts(full) };
      } catch (e) {
        return { id, error: e.message };
      }
    });
  }

  // ─── Fetch (force download) ─────────────────────────────────────

  if (path === "/messages/fetch" && method === "POST") {
    if (body.messageId) {
      const raw = await messenger.messages.getRaw(body.messageId);
      return { downloaded: true, size: typeof raw === "string" ? raw.length : 0 };
    }
    if (body.folderId) {
      const folder = await messenger.folders.get(body.folderId, false);
      const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
      const fetched = await fetchRawAll(result.messages);
      return { fetched, total: result.messages.length };
    }
    return { error: "Provide messageId or folderId" };
  }

  // ─── Archive ────────────────────────────────────────────────────

  if (path === "/messages/archive" && method === "POST") {
    const { messageIds, keepUnread = false } = body || {};
    if (!keepUnread) {
      for (const id of messageIds) {
        try { await messenger.messages.update(id, { read: true }); }
        catch { /* message may already be gone */ }
      }
    }
    await messenger.messages.archive(messageIds);
    return { success: true, archived: messageIds.length };
  }

  // ─── Move ─────────────────────────────────────────────────────────

  if (path === "/messages/move" && method === "POST") {
    const { messageIds, destinationFolderId } = body;
    const folder = await messenger.folders.get(destinationFolderId, false);
    await messenger.messages.move(messageIds, folder);
    return { success: true, moved: messageIds.length };
  }

  // ─── Copy ───────────────────────────────────────────────────────

  if (path === "/messages/copy" && method === "POST") {
    const { messageIds, destinationFolderId } = body;
    const folder = await messenger.folders.get(destinationFolderId, false);
    await messenger.messages.copy(messageIds, folder);
    return { success: true, copied: messageIds.length };
  }

  // ─── Delete ─────────────────────────────────────────────────────

  if (path === "/messages/delete" && method === "POST") {
    const { messageIds, permanent = false, keepUnread = false } = body;
    // Only mark read when moving to trash (not permanent): the message survives in trash and would otherwise bloat the unread count.
    if (!permanent && !keepUnread) {
      for (const id of messageIds) {
        try { await messenger.messages.update(id, { read: true }); }
        catch { /* message may already be gone */ }
      }
    }
    await messenger.messages.delete(messageIds, permanent);
    return { success: true, deleted: messageIds.length };
  }

  // ─── Update (mark read/flagged/junk/tags) ───────────────────────

  if (path === "/messages/update" && method === "POST") {
    const { messageId, read, flagged, junk, tags } = body;
    const props = {};
    if (read !== undefined) props.read = read;
    if (flagged !== undefined) props.flagged = flagged;
    if (junk !== undefined) props.junk = junk;
    if (tags !== undefined) props.tags = tags;
    await messenger.messages.update(messageId, props);
    return { success: true };
  }

  // ─── Message sub-routes (order matters: specific before generic) ─

  // Raw message
  const rawMatch = path.match(/^\/messages\/(\d+)\/raw$/);
  if (rawMatch && method === "GET") {
    const raw = await messenger.messages.getRaw(parseInt(rawMatch[1]));
    return { raw };
  }

  // Headers only
  const headersMatch = path.match(/^\/messages\/(\d+)\/headers$/);
  if (headersMatch && method === "GET") {
    const msgId = parseInt(headersMatch[1]);
    const msg = await messenger.messages.get(msgId);
    return formatMessage(msg);
  }

  // Full read including HTML
  const fullMatch = path.match(/^\/messages\/(\d+)\/full$/);
  if (fullMatch && method === "GET") {
    const msgId = parseInt(fullMatch[1]);
    const msg = await messenger.messages.get(msgId);
    const full = await messenger.messages.getFull(msgId);
    const parts = extractParts(full);
    return { ...formatMessage(msg), parts };
  }

  // Check download state
  const checkDlMatch = path.match(/^\/messages\/(\d+)\/check-download$/);
  if (checkDlMatch && method === "GET") {
    const msgId = parseInt(checkDlMatch[1]);
    const msg = await messenger.messages.get(msgId);
    let downloadState = "unknown";
    try {
      const full = await messenger.messages.getFull(msgId);
      const parts = extractParts(full);
      downloadState = (parts.text || parts.html) ? "full" : "headers_only";
    } catch {
      downloadState = "headers_only";
    }
    return {
      id: msg.id, downloadState, size: msg.size,
      hasBody: downloadState === "full",
      hasAttachments: false,
    };
  }

  // Download status
  const dlStatusMatch = path.match(/^\/messages\/(\d+)\/download-status$/);
  if (dlStatusMatch && method === "GET") {
    const msgId = parseInt(dlStatusMatch[1]);
    const msg = await messenger.messages.get(msgId);
    let state = "headers_only";
    try {
      const full = await messenger.messages.getFull(msgId);
      const parts = extractParts(full);
      if (parts.text || parts.html) state = "full";
    } catch { /* headers_only */ }
    return { state, size: msg.size };
  }

  // Attachments list
  const attachmentsMatch = path.match(/^\/messages\/(\d+)\/attachments$/);
  if (attachmentsMatch && method === "GET") {
    const msgId = parseInt(attachmentsMatch[1]);
    const full = await messenger.messages.getFull(msgId);
    const parts = extractParts(full);
    return parts.attachments;
  }

  // Download specific attachment
  const attachmentMatch = path.match(/^\/messages\/(\d+)\/attachment$/);
  if (attachmentMatch && method === "POST") {
    const msgId = parseInt(attachmentMatch[1]);
    const { partName } = body || {};
    const file = await messenger.messages.getAttachmentFile(msgId, partName);
    const buffer = await file.arrayBuffer();
    const base64 = bytesToBase64(new Uint8Array(buffer));
    return { name: file.name, size: file.size, contentType: file.type, data: base64 };
  }

  // Thread
  const threadMatch = path.match(/^\/messages\/(\d+)\/thread$/);
  if (threadMatch && method === "GET") {
    const msgId = parseInt(threadMatch[1]);
    const msg = await messenger.messages.get(msgId);

    const seen = new Set();
    const thread = [];
    const add = (m, threadMatch) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      thread.push({ ...formatMessage(m), threadMatch });
    };

    // Upstream: every message named in References / In-Reply-To
    const referenced = await resolveReferencedMessages(msgId, msg);
    referenced.forEach((m) => add(m, "references"));

    // Downstream: replies that don't reference this message yet share its normalized subject.
    // Thunderbird's subject query is a substring match, so keep exact matches only; these are
    // heuristic, so they are labelled and junk is excluded.
    const norm = normalizeSubject(msg?.subject || "");
    if (norm) {
      try {
        const r = await messenger.messages.query({ subject: norm, junk: false });
        for (const m of r?.messages || []) {
          if (normalizeSubject(m.subject || "").toLowerCase() === norm.toLowerCase()) add(m, "subject");
        }
      } catch {}
    }

    thread.sort((a, b) => new Date(a.date) - new Date(b.date));
    return { thread, count: thread.length };
  }

  // Read message (default — must be AFTER all /messages/:id/* sub-routes)
  const msgMatch = path.match(/^\/messages\/(\d+)$/);
  if (msgMatch && method === "GET") {
    const msgId = parseInt(msgMatch[1]);
    const msg = await messenger.messages.get(msgId);
    if (!msg) return { error: "Message not found" };
    const full = await messenger.messages.getFull(msgId);
    return { ...formatMessage(msg), parts: extractParts(full) };
  }

  // ─── Tags ───────────────────────────────────────────────────────

  if (path === "/tags" && method === "GET") {
    return await messenger.messages.listTags();
  }

  if (path === "/tags/create" && method === "POST") {
    const { key, tag, color } = body || {};
    await messenger.messages.createTag(key, tag, color);
    return { success: true, key, tag, color };
  }

  // ─── Compose ────────────────────────────────────────────────────

  if (path === "/compose" && method === "POST") {
    const { to, cc, bcc, subject, body: msgBody, isHTML = false,
            identityId, send = false, draft = false, open = false,
            priority } = body;
    const details = {};
    if (to) details.to = Array.isArray(to) ? to : to.split(",").map(s => s.trim());
    if (cc) details.cc = Array.isArray(cc) ? cc : cc.split(",").map(s => s.trim());
    if (bcc) details.bcc = Array.isArray(bcc) ? bcc : bcc.split(",").map(s => s.trim());
    if (subject) details.subject = subject;
    if (isHTML) { details.isPlainText = false; details.body = msgBody; }
    else { details.isPlainText = true; details.plainTextBody = msgBody; }
    if (identityId) details.identityId = identityId;
    if (priority) details.customHeaders = [{ name: "X-Priority", value: priorityToValue(priority) }];
    const tab = await messenger.compose.beginNew(null, details);
    if (send) {
      await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
      return { success: true, action: "sent" };
    }
    if (open) {
      return { success: true, action: "draft_opened", tabId: tab.id };
    }
    // Default: save as draft and close
    return await saveDraft(tab.id, await accountForIdentity(identityId));
  }

  // ─── Reply ──────────────────────────────────────────────────────

  if (path === "/reply" && method === "POST") {
    const { messageId, body: replyBody, replyAll = false, subject,
            identityId, send = false, draft = false, open = false,
            includeHistory = true } = body;
    const type = replyAll ? "replyToAll" : "replyToSender";

    const original = await messenger.messages.get(messageId);
    const selectedIdentityId = await resolveComposeIdentity(original, identityId);

    // Let Thunderbird establish the reply relationship and generate the identity's configured
    // signature and quotation before inserting the supplied text.
    const details = { isPlainText: true };
    if (selectedIdentityId) details.identityId = selectedIdentityId;
    const tab = await messenger.compose.beginReply(messageId, type, details);
    let composeDetails = await messenger.compose.getComposeDetails(tab.id);
    let quotedOriginal = false;

    // Earlier messages in the thread, appended below the immediate quoted parent (which is
    // already handled by Thunderbird's native quoting or the fallback below). Empty when the
    // message has no resolvable ancestors, so this is a no-op for non-threaded mail.
    const historyText = includeHistory ? await buildConversationHistory(messageId) : "";

    // An explicit subject wins; otherwise keep Thunderbird's generated one, adding the reply
    // prefix only when it is missing, so a staged reply still threads as one.
    const replySubject = subject || withReplyPrefix(composeDetails.subject || original.subject);
    if (replySubject && replySubject !== composeDetails.subject) {
      await messenger.compose.setComposeDetails(tab.id, { subject: replySubject });
      composeDetails = await messenger.compose.getComposeDetails(tab.id);
    }

    if (composeDetails.isPlainText === false) {
      // setComposeDetails cannot switch an open window between HTML and plain text (Thunderbird
      // throws), and an HTML window ignores plainTextBody. Write above the generated HTML quote.
      const text = replyBody ? `<p>${plainTextToHtml(replyBody.trimEnd())}</p>` : "";
      const history = historyText ? `<p>${plainTextToHtml(historyText.trim())}</p>` : "";
      if (text || history) {
        await messenger.compose.setComposeDetails(tab.id, {
          body: `${text}${composeDetails.body || ""}${history}`,
        });
        composeDetails = await messenger.compose.getComposeDetails(tab.id);
      }
      quotedOriginal = /<blockquote/i.test(composeDetails.body || "");
    } else if (replyBody) {
      let generatedBody = composeDetails.plainTextBody || "";
      quotedOriginal = generatedBody.split(/\r?\n/).some((line) => line.trimStart().startsWith(">"));

      // Some identities are configured not to quote. Preserve any generated signature, then
      // add a deterministic plain-text quotation fallback.
      if (!quotedOriginal) {
        const full = await messenger.messages.getFull(messageId);
        const originalText = extractParts(full).text.trimEnd();
        const quotation = originalText.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
        const attribution = `On ${original.date.toLocaleString()}, ${original.author} wrote:`;
        generatedBody = [generatedBody.trimEnd(), attribution, quotation].filter(Boolean).join("\n\n");
        quotedOriginal = Boolean(originalText);
      }

      await messenger.compose.setComposeDetails(tab.id, {
        plainTextBody: `${replyBody.trimEnd()}\n\n${generatedBody}${historyText}`,
      });
      composeDetails = await messenger.compose.getComposeDetails(tab.id);
    } else if (historyText) {
      await messenger.compose.setComposeDetails(tab.id, {
        plainTextBody: `${composeDetails.plainTextBody || ""}${historyText}`,
      });
      composeDetails = await messenger.compose.getComposeDetails(tab.id);
    }

    const verification = {
      identityId: composeDetails.identityId,
      type: composeDetails.type,
      relatedMessageId: composeDetails.relatedMessageId,
      quotedOriginal,
    };
    if (send) {
      await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
      return { success: true, action: "sent", ...verification };
    }
    if (open) {
      return { success: true, action: "draft_opened", tabId: tab.id, ...verification };
    }
    // Default: save as draft and close
    const saved = await saveDraft(tab.id, await expectedDraftAccount(selectedIdentityId, original.folder.accountId));
    return { ...saved, ...verification };
  }

  // ─── Forward ────────────────────────────────────────────────────

  if (path === "/forward" && method === "POST") {
    const { messageId, to, body: fwdBody,
            identityId, send = false, draft = false, open = false,
            includeHistory = true } = body;
    const original = await messenger.messages.get(messageId);
    const selectedIdentityId = await resolveComposeIdentity(original, identityId);
    const historyText = includeHistory ? await buildConversationHistory(messageId) : "";
    const details = {
      to: Array.isArray(to) ? to : [to], isPlainText: true, plainTextBody: `${fwdBody || ""}${historyText}`,
    };
    if (selectedIdentityId) details.identityId = selectedIdentityId;
    const tab = await messenger.compose.beginForward(messageId, "forwardAsAttachment", details);
    if (send) {
      await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
      return { success: true, action: "sent", identityId: selectedIdentityId };
    }
    if (open) {
      return { success: true, action: "draft_opened", tabId: tab.id, identityId: selectedIdentityId };
    }
    // Default: save as draft and close
    const saved = await saveDraft(tab.id, await expectedDraftAccount(selectedIdentityId, original.folder.accountId));
    return { ...saved, identityId: selectedIdentityId };
  }

  // ─── Edit existing draft ────────────────────────────────────────

  if (path === "/compose/edit" && method === "POST") {
    const {
      messageId,
      to, cc, bcc, subject, body: msgBody, isHTML = false,
      identityId, priority,
      send = false, open = false,
    } = body || {};

    if (!messageId) return { error: "messageId is required" };

    const hasFieldChange = to !== undefined || cc !== undefined || bcc !== undefined
      || subject !== undefined || msgBody !== undefined
      || identityId !== undefined || priority !== undefined;

    if (!hasFieldChange && !open && !send) {
      return { error: "Provide at least one field to change, or use open/send mode" };
    }

    let msg;
    try {
      msg = await messenger.messages.get(messageId);
    } catch {
      return { error: "Message not found" };
    }
    if (!msg) return { error: "Message not found" };

    if (msg.folder?.type !== "drafts") {
      return {
        error: `Message is not a draft (folder type: ${msg.folder?.type || "unknown"})`,
      };
    }

    let tab = null;
    try {
      // beginNew(messageId) opens the draft "as a new message": ComposeDetails.type
      // is always "new" (there is no WebExtension API for true draft-in-place editing).
      // We apply field overrides, then save + reconcile any duplicate (see below).
      tab = await messenger.compose.beginNew(messageId);
      const current = await messenger.compose.getComposeDetails(tab.id);

      const details = {};
      if (to !== undefined) {
        details.to = Array.isArray(to) ? to : String(to).split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (cc !== undefined) {
        details.cc = Array.isArray(cc) ? cc : String(cc).split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (bcc !== undefined) {
        details.bcc = Array.isArray(bcc) ? bcc : String(bcc).split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (subject !== undefined) details.subject = subject;
      if (identityId !== undefined) details.identityId = identityId;
      if (priority !== undefined) details.priority = priority;

      if (msgBody !== undefined) {
        // Compose format of an open window cannot be changed. An HTML window
        // ignores plainTextBody (and vice versa), so set the matching field:
        //  - plain-text window     -> plainTextBody
        //  - HTML window + --html  -> body (raw HTML, as given)
        //  - HTML window + plain   -> body (converted: escaped + <br> for newlines)
        if (current.isPlainText) {
          details.plainTextBody = msgBody;
        } else if (isHTML) {
          details.body = msgBody;
        } else {
          details.body = plainTextToHtml(msgBody);
        }
      }

      if (Object.keys(details).length > 0) {
        await messenger.compose.setComposeDetails(tab.id, details);
      }

      if (send) {
        await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
        tab = null; // send closes the window
        return { success: true, action: "sent", previousMessageId: messageId };
      }

      if (open) {
        const openedId = tab.id;
        tab = null; // leave open for human
        return {
          success: true,
          action: "draft_opened",
          tabId: openedId,
          messageId,
          previousMessageId: messageId,
        };
      }

      const saved = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
      const savedId = saved?.messages?.[0]?.id ?? messageId;
      await messenger.tabs.remove(tab.id);
      tab = null;

      // beginNew() + saveMessage() creates a *new* draft in Drafts and leaves
      // the original. We intentionally do NOT auto-delete: the caller should
      // verify the new draft (tb read <messageId>) and then explicitly delete
      // the original (tb delete <previousMessageId> --permanent --confirm).
      // `duplicated` tells the caller whether a distinct draft was created
      // (safe to delete previousMessageId) vs. TB replaced in place (do not).
      const duplicated = savedId !== messageId;

      return {
        success: true,
        action: "draft_saved",
        messageId: savedId,
        previousMessageId: messageId,
        duplicated,
      };
    } finally {
      if (tab) {
        try { await messenger.tabs.remove(tab.id); } catch { /* already closed */ }
      }
    }
  }

  // ─── Stats (GET — legacy) ──────────────────────────────────────

  if (path === "/stats" && method === "GET") {
    const accounts = await messenger.accounts.list(true);
    const stats = [];
    for (const account of accounts) {
      const s = { id: account.id, name: account.name, type: account.type,
        email: account.identities?.[0]?.email || "unknown",
        folders: 0, unreadTotal: 0, messageTotal: 0 };
      if (account.rootFolder) await countFolder(account.rootFolder, s);
      stats.push(s);
    }
    return {
      totalAccounts: stats.length,
      totalUnread: stats.reduce((s, a) => s + a.unreadTotal, 0),
      totalMessages: stats.reduce((s, a) => s + a.messageTotal, 0),
      accounts: stats,
    };
  }

  // ─── Stats (POST — enhanced) ───────────────────────────────────

  if (path === "/stats" && method === "POST") {
    const accounts = await messenger.accounts.list(true);
    let accts = accounts;
    if (body && body.accountId) accts = accounts.filter((a) => a.id === body.accountId);
    const stats = [];
    for (const account of accts) {
      const s = { id: account.id, name: account.name, type: account.type,
        email: account.identities?.[0]?.email || "unknown",
        folders: 0, unreadTotal: 0, messageTotal: 0 };
      if (body && body.folders && account.rootFolder) {
        s.folderDetails = await flattenFolders(account.rootFolder);
      }
      if (account.rootFolder) await countFolder(account.rootFolder, s);
      stats.push(s);
    }
    return {
      totalAccounts: stats.length,
      totalUnread: stats.reduce((s, a) => s + a.unreadTotal, 0),
      totalMessages: stats.reduce((s, a) => s + a.messageTotal, 0),
      accounts: stats,
    };
  }

  // ─── Recent ─────────────────────────────────────────────────────

  if (path === "/recent" && method === "POST") {
    const { hours = 24, limit = 50, accountId, unreadOnly = false } = body || {};
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const result = await collectMessages(
      () => messenger.messages.query({ fromDate: since, autoPaginationTimeout: 200 }), limit,
      { unreadOnly, accountId: accountId || null }
    );
    result.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    result.since = since.toISOString();
    return result;
  }

  // ─── Calendars (ODIAA-2327 proof, read-only) ────────────────────
  // Requires the calendar_calendars Experiment API (manifest experiment_apis, see
  // extension/experiments/calendar/) to have loaded successfully.

  if (path === "/calendars" && method === "GET") {
    if (!messenger.calendar?.calendars?.query) {
      return { error: "calendar experiment not loaded" };
    }
    const calendars = await messenger.calendar.calendars.query({});
    return calendars;
  }

  // ─── Contacts search (must be before /contacts/:id) ─────────────

  if (path === "/contacts/search" && method === "POST") {
    const { query, book, limit: contactLimit } = body || {};
    const books = await messenger.addressBooks.list();
    const all = [];
    for (const b of books) {
      if (book && b.id !== book && b.name !== book) continue;
      const contacts = await messenger.contacts.list(b.id);
      for (const c of contacts) {
        const name = c.properties?.DisplayName || "";
        const emails = Object.entries(c.properties || {})
          .filter(([k, v]) => /Email\d*$/.test(k) && v)
          .map(([, v]) => v);
        if (query) {
          const q = query.toLowerCase();
          const matchesEmail = emails.some((e) => e.toLowerCase().includes(q));
          if (!name.toLowerCase().includes(q) && !matchesEmail) continue;
        }
        all.push({ id: c.id, name, email: emails[0] || "", emails, book: b.name, bookId: b.id });
        if (contactLimit && all.length >= contactLimit) break;
      }
      if (contactLimit && all.length >= contactLimit) break;
    }
    return all;
  }

  // ─── Contacts create/update ──────────────────────────────────────

  if (path === "/contacts/create" && method === "POST") {
    const { book, properties } = body || {};
    const books = await messenger.addressBooks.list();
    const targetBook = books.find((b) => b.id === book || b.name === book);
    if (!targetBook) return { error: `address book not found: ${book}` };
    const id = await messenger.contacts.create(targetBook.id, null, properties || {});
    return { id, book: targetBook.name, bookId: targetBook.id, properties: properties || {} };
  }

  if (path === "/contacts/update" && method === "POST") {
    const { id, properties } = body || {};
    await messenger.contacts.update(id, properties || {});
    return { id, properties: properties || {} };
  }

  // ─── Contacts list ──────────────────────────────────────────────

  if (path === "/contacts" && method === "GET") {
    const books = await messenger.addressBooks.list();
    const all = [];
    for (const book of books) {
      const contacts = await messenger.contacts.list(book.id);
      for (const c of contacts) {
        all.push({
          id: c.id, name: c.properties?.DisplayName || "",
          email: c.properties?.PrimaryEmail || "", book: book.name,
        });
      }
    }
    return all;
  }

  // ─── Contact by ID ─────────────────────────────────────────────

  const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
  if (contactMatch && method === "GET") {
    const contactId = contactMatch[1];
    const contact = await messenger.contacts.get(contactId);
    return { id: contact.id, properties: contact.properties };
  }

  // ─── Sync ───────────────────────────────────────────────────────

  if (path === "/sync" && method === "POST") {
    if (body && body.all) {
      const accounts = await messenger.accounts.list(true);
      for (const acct of accounts) {
        if (acct.rootFolder) await messenger.folders.getSubFolders(acct.rootFolder, false);
      }
      return { success: true, synced: "all" };
    }
    if (body && body.folderId) {
      const folder = await messenger.folders.get(body.folderId, false);
      await messenger.folders.getSubFolders(folder, false);
      return { success: true, synced: body.folderId };
    }
    return { error: "Provide folderId or all: true" };
  }

  if (path === "/sync/status" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    return {
      folderId: folder.id, totalMessages: folder.totalMessageCount,
      unread: folder.unreadMessageCount, type: folder.type, name: folder.name,
    };
  }

  // ─── Extension Management ───────────────────────────────────────

  if (path === "/extension/reload" && method === "POST") {
    if (typeof messenger.runtime.reload !== "function") {
      return { error: "runtime.reload() not available in this Thunderbird version" };
    }
    // Respond first, then reload after a delay so the WebSocket response is delivered before
    // the reload tears down this connection.
    setTimeout(() => {
      messenger.runtime.reload();
    }, 500);
    return { ok: true, reloading: true, message: "Extension reloading" };
  }

  // ─── Bulk operations ───────────────────────────────────────────

  if (path === "/bulk/delete" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
    const filtered = filterBulkMessages(result.messages, body);
    if (filtered.length > 0) {
      await messenger.messages.delete(filtered.map((m) => m.id), false);
    }
    return { success: true, deleted: filtered.length };
  }

  if (path === "/bulk/tag" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
    const toTag = filterBulkMessages(result.messages, body)
      .filter((msg) => !(msg.tags || []).includes(body.tagKey));
    await mapWithIpcLimit(toTag, (msg) =>
      messenger.messages.update(msg.id, { tags: [...(msg.tags || []), body.tagKey] })
    );
    return { success: true, tagged: toTag.length };
  }

  if (path === "/bulk/fetch" && method === "POST") {
    const folder = await messenger.folders.get(body.folderId, false);
    const result = await collectMessages(() => messenger.messages.list(folder), body.limit || 100);
    const fetched = await fetchRawAll(result.messages);
    return { success: true, fetched, total: result.messages.length };
  }

  // ─── Not found ─────────────────────────────────────────────────

  return { error: `Not found: ${method} ${path}` };
}

// ─── Draft helpers ──────────────────────────────────────────────────
//
// Thunderbird files a saved draft into the drafts folder configured on the *identity* that
// composed it, falling back to the global default identity when none is given — so a reply to
// one account's message could silently land in another account's Drafts. On top of that, a
// Gmail account exposes both a bare "/Drafts" and the real server-side "/[Gmail]/Drafts", and
// only the latter shows up as a draft in Gmail.

// Identity for a reply/forward. An explicit identity may come from any account (a deliberate
// cross-account --from); otherwise prefer the message account's identity it was addressed to.
async function resolveComposeIdentity(original, identityId) {
  if (identityId) {
    if (!(await accountForIdentity(identityId))) {
      throw new Error(`Requested identity ${identityId} does not belong to any account`);
    }
    return identityId;
  }
  const account = await messenger.accounts.get(original.folder.accountId, true);
  const accountIdentities = account?.identities || [];
  const addressedRecipients = [
    ...(original.recipients || []),
    ...(original.ccList || []),
    ...(original.bccList || []),
  ].map((recipient) => String(recipient).toLowerCase()).join("\n");
  const matchingIdentity = accountIdentities.find((id) =>
    id.email && addressedRecipients.includes(id.email.toLowerCase())
  );
  return matchingIdentity?.id || accountIdentities[0]?.id || null;
}

function withReplyPrefix(subject) {
  if (!subject) return null;
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

async function accountForIdentity(identityId) {
  if (!identityId) return null;
  const accounts = await messenger.accounts.list(true);
  const owner = accounts.find((a) => (a.identities || []).some((id) => id.id === identityId));
  return owner?.id || null;
}

// Placement is decided by the composing identity's draft_folder, so the expected account follows
// that identity — not the account of the message being replied to or forwarded.
async function expectedDraftAccount(identityId, fallbackAccountId) {
  return (await accountForIdentity(identityId)) || fallbackAccountId;
}

// The account's real drafts folder: prefer Gmail's "[Gmail]/Drafts" over a bare "Drafts".
async function draftsFolderForAccount(accountId) {
  if (!accountId) return null;
  const account = await messenger.accounts.get(accountId, true);
  const drafts = [];
  (function walk(folder) {
    if (!folder) return;
    if (folder.type === "drafts") drafts.push(folder);
    (folder.subFolders || []).forEach(walk);
  })(account?.rootFolder);
  return drafts.find((f) => f.path.startsWith("/[Gmail]/")) || drafts[0] || null;
}

// Save as draft and confirm it landed; throws rather than reporting "draft_saved" for a write we
// could not verify. A misfiled draft is deliberately NOT relocated: moving a message between a
// Gmail account's two drafts folders aborts server-side (NS error 0x80550021) and renumbers it,
// trading a findable draft for a messageId that no longer resolves. Warn instead, so the
// identity's draft_folder gets fixed.
async function saveDraft(tabId, accountId) {
  const saved = await messenger.compose.saveMessage(tabId, { mode: "draft" });
  await messenger.tabs.remove(tabId);

  const header = saved?.messages?.[0];
  if (!header) {
    throw new Error("Draft save did not return a saved message — nothing was written to the mailbox");
  }

  const folder = header.folder;
  const result = {
    success: true,
    action: "draft_saved",
    messageId: header.id,
    folder: folder ? { accountId: folder.accountId, path: folder.path, name: folder.name } : null,
  };

  const target = await draftsFolderForAccount(accountId);
  if (target && folder && folder.path !== target.path) {
    result.warning =
      `Draft was filed into ${folder.path}, but this account's drafts folder is ${target.path}. ` +
      "The composing identity's draft_folder points at the wrong folder, so the draft will not " +
      "show up where drafts are normally read.";
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────

function plainTextToHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line === "" ? "<br>" : line))
    .join("<br>\n");
}

function formatMessage(msg) {
  return {
    id: msg.id,
    date: msg.date?.toISOString(),
    author: msg.author,
    subject: msg.subject,
    read: msg.read,
    flagged: msg.flagged,
    junk: msg.junk,
    size: msg.size,
    tags: msg.tags || [],
    folder: msg.folder
      ? { accountId: msg.folder.accountId, path: msg.folder.path, name: msg.folder.name }
      : null,
    recipients: msg.recipients,
    ccList: msg.ccList,
    bccList: msg.bccList,
    headerMessageId: msg.headerMessageId,
  };
}

function extractParts(part, result = { text: "", html: "", attachments: [] }) {
  if (!part) return result;
  const ct = (part.contentType || "").toLowerCase();
  if (ct === "text/plain" && part.body) result.text += part.body;
  else if (ct === "text/html" && part.body) result.html += part.body;
  else if (part.name || (ct && !ct.startsWith("multipart/"))) {
    if (part.partName && ct !== "text/plain" && ct !== "text/html") {
      result.attachments.push({
        name: part.name || "unnamed", contentType: ct,
        partName: part.partName, size: part.size,
      });
    }
  }
  if (part.parts) for (const sub of part.parts) extractParts(sub, result);
  return result;
}

// Message-IDs (without brackets) named in a message's own References / In-Reply-To / Message-ID
// headers — i.e. its upstream ancestors plus itself. getFull() does not reliably expose RFC 2822
// headers, so the raw source is parsed first, falling back to getFull()'s header map.
async function resolveThreadReferenceIds(msgId, msg) {
  let ids = new Set();
  try {
    const raw = await messenger.messages.getRaw(msgId);
    if (typeof raw === "string") ids = buildThreadIds(raw);
  } catch {}
  if (ids.size === 0) {
    try {
      const full = await messenger.messages.getFull(msgId);
      const header = (name) => full.headers?.[name]?.[0] || "";
      ids = new Set([
        ...parseReferences(header("references")),
        ...parseReferences(header("in-reply-to")),
        stripAngleBrackets(header("message-id")),
      ].filter(Boolean));
    } catch {}
  }
  // messages.query() matches headerMessageId without angle brackets
  if (msg?.headerMessageId) ids.add(stripAngleBrackets(msg.headerMessageId));
  return ids;
}

// Ancestor messages referenced by msgId's own References/In-Reply-To, oldest first. Excludes
// msgId itself, since callers (thread view, conversation history) already know that message.
async function resolveReferencedMessages(msgId, msg) {
  const ids = await resolveThreadReferenceIds(msgId, msg);
  const seen = new Set([msgId]);
  const results = [];
  const pages = await mapWithIpcLimit([...ids], async (hdrId) => {
    try {
      return (await messenger.messages.query({ headerMessageId: hdrId }))?.messages || [];
    } catch {
      return [];
    }
  });
  for (const messages of pages) {
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      results.push(m);
    }
  }
  results.sort((a, b) => new Date(a.date) - new Date(b.date));
  return results;
}

// Plain-text, oldest-first, quoted rendering of the messages upstream of msgId, for appending to
// a reply/forward body. Returns "" if msgId has no resolvable ancestors.
async function buildConversationHistory(msgId) {
  try {
    const msg = await messenger.messages.get(msgId);
    const ancestors = await resolveReferencedMessages(msgId, msg);
    if (ancestors.length === 0) return "";
    const bodies = await mapWithIpcLimit(ancestors, async (m) => {
      try {
        return extractParts(await messenger.messages.getFull(m.id)).text || "";
      } catch {
        return "";
      }
    });
    const blocks = ancestors.map((m, i) => {
      const quoted = bodies[i].split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n");
      const date = m.date ? new Date(m.date).toLocaleString() : "unknown date";
      return `On ${date}, ${m.author || "unknown"} wrote:\n${quoted}`;
    });
    return `\n\n----- Conversation History -----\n\n${blocks.join("\n\n")}`;
  } catch {
    return "";
  }
}

async function getCachedFolderInfo(folder) {
  const cached = folderInfoCache.get(folder.id);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  if (cached) folderInfoCache.delete(folder.id);
  let info = {};
  try { info = await messenger.folders.getFolderInfo(folder); } catch {}
  folderInfoCache.set(folder.id, { info, expiresAt: Date.now() + FOLDER_INFO_CACHE_TTL_MS });
  // Bound cache growth for accounts with very large folder trees; evict oldest entry.
  if (folderInfoCache.size > FOLDER_INFO_CACHE_MAX_SIZE) {
    const oldestKey = folderInfoCache.keys().next().value;
    if (oldestKey !== undefined) folderInfoCache.delete(oldestKey);
  }
  return info;
}

async function flattenFolders(folder, depth = 0) {
  const info = await getCachedFolderInfo(folder);
  const result = [{
    id: folder.id, name: folder.name, path: folder.path,
    type: folder.type,
    unreadMessageCount: info.unreadMessageCount || 0,
    totalMessageCount: info.totalMessageCount || 0,
    depth,
  }];
  if (folder.subFolders) {
    for (const sub of folder.subFolders) {
      result.push(...await flattenFolders(sub, depth + 1));
    }
  }
  return result;
}

async function countFolder(folder, stats) {
  stats.folders++;
  const info = await getCachedFolderInfo(folder);
  stats.unreadTotal += info.unreadMessageCount || 0;
  stats.messageTotal += info.totalMessageCount || 0;
  if (folder.subFolders) {
    for (const sub of folder.subFolders) await countFolder(sub, stats);
  }
}

async function collectMessages(queryFn, limit, { unreadOnly = false, flaggedOnly = false, offset = 0, accountId = null } = {}) {
  let page = await queryFn();
  const messages = [];
  let skipped = 0;
  try {
    while (page) {
      for (const msg of page.messages) {
        if (unreadOnly && msg.read) continue;
        if (flaggedOnly && !msg.flagged) continue;
        if (accountId && msg.folder?.accountId !== accountId) continue;
        if (skipped < offset) { skipped++; continue; }
        // One extra matching message proves more exist, even inside a final page.
        if (messages.length >= limit) {
          return { messages, total: messages.length, offset, hasMore: true };
        }
        messages.push(formatMessage(msg));
      }
      if (!page.id) break;
      page = await messenger.messages.continueList(page.id);
    }
    return { messages, total: messages.length, offset, hasMore: false };
  } finally {
    if (page?.id) await messenger.messages.abortList(page.id);
  }
}

function filterBulkMessages(messages, filters) {
  let result = messages;
  if (filters.olderThan) {
    const cutoff = new Date(Date.now() - parseInt(filters.olderThan) * 86400000);
    result = result.filter((m) => new Date(m.date) < cutoff);
  }
  if (filters.from) {
    const from = filters.from.toLowerCase();
    result = result.filter((m) => (m.author || "").toLowerCase().includes(from));
  }
  if (filters.subject) {
    const subj = filters.subject.toLowerCase();
    result = result.filter((m) => (m.subject || "").toLowerCase().includes(subj));
  }
  return result;
}

function priorityToValue(priority) {
  const map = { highest: "1", high: "2", normal: "3", low: "4", lowest: "5" };
  return map[priority] || "3";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Force-download each message; resolves to how many succeeded. */
async function fetchRawAll(messages) {
  const results = await mapWithIpcLimit(messages, async (msg) => {
    try {
      await messenger.messages.getRaw(msg.id);
      return true;
    } catch {
      return false;
    }
  });
  return results.filter(Boolean).length;
}

/**
 * Map items through an async fn, preserving order, with at most IPC_CONCURRENCY calls in
 * flight across every concurrent request so bulk work can't flood Thunderbird.
 */
function mapWithIpcLimit(items, fn) {
  return Promise.all(items.map((item) => new Promise((resolve, reject) => {
    ipcQueue.push({ run: () => fn(item), resolve, reject });
    drainIpcQueue();
  })));
}

function drainIpcQueue() {
  while (ipcInFlight < IPC_CONCURRENCY && ipcQueue.length > 0) {
    const { run, resolve, reject } = ipcQueue.shift();
    ipcInFlight++;
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => {
        ipcInFlight--;
        drainIpcQueue();
      });
  }
}

let _tbMajor = null;
async function tbMajor() {
  if (_tbMajor !== null) return _tbMajor;
  try {
    const m = navigator.userAgent.match(/Thunderbird\/(\d+)/);
    _tbMajor = m ? parseInt(m[1]) : 0;
  } catch { _tbMajor = 0; }
  return _tbMajor;
}
