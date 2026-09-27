#!/usr/bin/env node

/**
 * Thunderbird CLI Bridge Server
 *
 * HTTP server (port 7700) for CLI requests.
 * WebSocket server (port 7701) for Thunderbird extension.
 * Forwards: CLI HTTP → WebSocket → Extension → response.
 *
 * Usage: node bridge.js [--port 7700] [--ws-port 7701] [--host 127.0.0.1]
 *
 * Environment variables:
 *   TB_BRIDGE_PORT            HTTP port (default: 7700)
 *   TB_BRIDGE_WS_PORT         WebSocket port (default: 7701)
 *   TB_BRIDGE_HOST            bind host (default: 127.0.0.1)
 *   TB_BRIDGE_TIMEOUT         default per-request timeout in ms (default: 120000)
 *   TB_AUTH_TOKEN             if set, HTTP requests must present it as `Authorization: Bearer <token>`.
 *                             Unset it to run without authentication. Setting it to an empty value is
 *                             rejected at startup rather than silently disabling authentication.
 *   TB_BRIDGE_CORS_ORIGINS    comma-separated browser origins allowed to call the HTTP API
 *                             (default: the bridge's own http://127.0.0.1 / http://localhost origin)
 *   TB_BRIDGE_ALLOWED_HOSTS   extra comma-separated Host header names to accept, in addition to
 *                             IP literals, localhost, *.localhost and *.internal
 *   TB_BRIDGE_WS_HEARTBEAT_MS WebSocket ping interval used to drop dead extension sockets (default: 30000)
 *
 * Per-request override: HTTP clients can pass `X-TB-Timeout: <ms>` header.
 *
 * Programmatic usage:
 *   import { startBridge } from "./bridge.js";
 *   const { httpServer, wss, close } = await startBridge({ port: 7700, wsPort: 7701 });
 */

import { createServer } from "http";
import { isIP } from "net";
import { WebSocketServer } from "ws";
import { randomUUID, timingSafeEqual } from "crypto";
import { EventEmitter } from "events";
import { pathToFileURL } from "url";

// ─── Helper: resolve CLI arg value ────────────────────────────────

function cliArg(name) {
  return process.argv.find((_, i, a) => a[i - 1] === name);
}

// ─── startBridge ──────────────────────────────────────────────────

export async function startBridge(opts = {}) {
  const HTTP_PORT = parseInt(
    opts.port ?? process.env.TB_BRIDGE_PORT ?? cliArg("--port") ?? "7700"
  );
  const WS_PORT = parseInt(
    opts.wsPort ?? process.env.TB_BRIDGE_WS_PORT ?? cliArg("--ws-port") ?? "7701"
  );
  const HOST = opts.host ?? process.env.TB_BRIDGE_HOST ?? cliArg("--host") ?? "127.0.0.1";
  const DEFAULT_TIMEOUT = parseInt(process.env.TB_BRIDGE_TIMEOUT || "120000");
  const HEARTBEAT_INTERVAL_MS = parseInt(process.env.TB_BRIDGE_WS_HEARTBEAT_MS || "30000");
  const CORS_ALLOWED_ORIGINS = new Set(
    (process.env.TB_BRIDGE_CORS_ORIGINS || `http://127.0.0.1:${HTTP_PORT},http://localhost:${HTTP_PORT}`)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  const EXTRA_ALLOWED_HOSTS = new Set(
    (process.env.TB_BRIDGE_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  // An empty TB_AUTH_TOKEN is a misconfiguration, not a way to disable auth. Failing open here
  // would leave the bridge reachable by any local process with nothing in the log to say so.
  const RAW_AUTH_TOKEN = process.env.TB_AUTH_TOKEN;
  if (RAW_AUTH_TOKEN !== undefined && RAW_AUTH_TOKEN.trim() === "") {
    console.error(
      "[bridge] TB_AUTH_TOKEN is set but empty. Refusing to start rather than silently " +
        "disabling authentication — unset the variable to run without auth."
    );
    process.exit(1);
  }
  const AUTH_TOKEN = RAW_AUTH_TOKEN ?? null;

  function isAuthorized(req) {
    if (!AUTH_TOKEN) return true;
    // RFC 7235: the auth scheme is case-insensitive. Require exactly "<scheme> <token>".
    const parts = (req.headers["authorization"] || "").split(" ");
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return false;
    const expected = Buffer.from(AUTH_TOKEN);
    const actual = Buffer.from(parts[1]);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  // ─── Browser-origin defenses ────────────────────────────────────────
  // Binding to 127.0.0.1 does not stop a web page in the user's browser from reaching the
  // bridge. CORS alone only hides responses: a page can still fire "simple" cross-origin
  // POSTs (e.g. compose+send, delete) blindly, and DNS rebinding makes a hostile domain
  // same-origin with the bridge. CLI/MCP clients send no Origin header, so rejecting
  // unknown origins and non-local Host names costs them nothing.

  function getAllowedCorsOrigin(originHeader) {
    if (!originHeader) return null;
    let origin;
    try {
      origin = new URL(originHeader).origin;
    } catch {
      return null;
    }
    return CORS_ALLOWED_ORIGINS.has(origin) ? origin : null;
  }

  function isAllowedHost(hostHeader) {
    if (!hostHeader) return true;
    let hostname;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return false;
    }
    const bare = hostname.replace(/^\[|\]$/g, "");
    // DNS rebinding needs a domain name; IP literals can't be rebound. `.internal` is reserved
    // for private use (host.docker.internal, host.containers.internal, ...).
    return (
      isIP(bare) !== 0 ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".internal") ||
      EXTRA_ALLOWED_HOSTS.has(hostname)
    );
  }

  // The extension connects from a moz-extension:// origin; non-browser clients send none.
  // Web content can only present http(s)/file origins or the opaque "null" origin.
  function isWebPageOrigin(originHeader) {
    if (!originHeader) return false;
    return originHeader === "null" || /^(https?|file):/i.test(originHeader);
  }

  let extensionSocket = null;
  const pending = new Map(); // id → { resolve, reject, timer }

  // Unsolicited push messages from the extension (e.g. "extension-ready" after a reload).
  // Ring-buffered so a long-poller that arrives just after an event can still see it.
  const eventEmitter = new EventEmitter();
  eventEmitter.setMaxListeners(50);
  const recentEvents = [];
  const MAX_RECENT_EVENTS = 100;

  // ─── WebSocket Server (for extension) ───────────────────────────────

  const wss = new WebSocketServer({
    host: HOST,
    port: WS_PORT,
    verifyClient: ({ req }) => {
      if (isWebPageOrigin(req.headers.origin)) {
        console.error(`[bridge] Rejected WebSocket connection from web origin ${req.headers.origin}`);
        return false;
      }
      return true;
    },
  });

  wss.on("connection", (ws) => {
    console.log("[bridge] Extension connected");
    extensionSocket = ws;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Response to a pending request (has a matching id).
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) {
              p.reject(msg.error);
            } else {
              p.resolve(msg.result);
            }
          }
          return;
        }

        // Unsolicited event from the extension.
        if (msg.type === "event") {
          const event = { name: msg.name, data: msg.data || {}, receivedAt: Date.now() };
          recentEvents.push(event);
          if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
          eventEmitter.emit("event", event);
        }
      } catch (e) {
        console.error("[bridge] Bad message from extension:", e.message);
      }
    });

    ws.on("close", () => {
      console.log("[bridge] Extension disconnected");
      if (extensionSocket === ws) extensionSocket = null;
    });
  });

  // Terminate sockets that stop answering pings (e.g. after the host slept), so requests fail
  // fast with EXTENSION_DISCONNECTED instead of hanging until the per-request timeout.
  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.readyState === 1) client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  // ─── Forward request to extension ───────────────────────────────────

  function forwardToExtension(method, path, body, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!extensionSocket || extensionSocket.readyState !== 1) {
        reject({ message: "Thunderbird extension not connected. Is Thunderbird running?" });
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject({ message: `Request timed out (${Math.round(timeoutMs / 1000)}s)` });
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      extensionSocket.send(JSON.stringify({ id, method, path, body }));
    });
  }

  // ─── HTTP Server (for CLI) ──────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: `Host "${req.headers.host}" not allowed. Add it to TB_BRIDGE_ALLOWED_HOSTS if this is intended.`,
          code: "FORBIDDEN",
        })
      );
      return;
    }

    const allowedOrigin = getAllowedCorsOrigin(req.headers.origin);
    if (req.headers.origin && !allowedOrigin) {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: "CORS origin not allowed. Add it to TB_BRIDGE_CORS_ORIGINS if this is intended.",
          code: "FORBIDDEN",
        })
      );
      return;
    }
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-TB-Timeout");
      res.setHeader("Access-Control-Max-Age", "600");
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          error: "Missing or invalid Authorization token. Set TB_AUTH_TOKEN for this client.",
          code: "AUTH_REQUIRED",
        })
      );
      return;
    }

    // Bridge status endpoint (doesn't need extension)
    if (req.url === "/bridge/status") {
      const status = {
        bridge: "running",
        extension: extensionSocket ? "connected" : "disconnected",
        httpPort: HTTP_PORT,
        wsPort: WS_PORT,
        defaultTimeoutMs: DEFAULT_TIMEOUT,
      };
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    // Bridge-local event feed (extension-pushed events, e.g. "extension-ready" after a
    // reload). Not routed through the extension or access-control.js — bridge-local like
    // /bridge/status.
    if (req.url.startsWith("/bridge/events")) {
      const url = new URL(req.url, `http://${HOST}:${HTTP_PORT}`);
      const waitName = url.searchParams.get("wait");
      const since = parseInt(url.searchParams.get("since") || "0");
      const eventTimeoutMs = Math.min(parseInt(url.searchParams.get("timeout") || "30000"), 120000);

      if (!waitName) {
        res.writeHead(200);
        res.end(JSON.stringify({ events: recentEvents.filter((e) => e.receivedAt >= since) }));
        return;
      }

      // The event may have already arrived before this long-poll started.
      const found = recentEvents.find((e) => e.name === waitName && e.receivedAt >= since);
      if (found) {
        res.writeHead(200);
        res.end(JSON.stringify({ event: found }));
        return;
      }

      let resolved = false;
      const cleanup = () => {
        clearTimeout(timer);
        eventEmitter.off("event", onEvent);
      };
      const onEvent = (event) => {
        if (resolved || event.name !== waitName || event.receivedAt < since) return;
        resolved = true;
        cleanup();
        res.writeHead(200);
        res.end(JSON.stringify({ event }));
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        res.writeHead(408);
        res.end(JSON.stringify({ error: "Event timeout", code: "EVENT_TIMEOUT" }));
      }, eventTimeoutMs);
      eventEmitter.on("event", onEvent);
      req.on("close", cleanup);
      return;
    }

    // Read body
    let body = "";
    for await (const chunk of req) body += chunk;

    let parsedBody = null;
    if (body.trim()) {
      try {
        parsedBody = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
    }

    // Per-request timeout override via X-TB-Timeout header
    let timeoutMs = DEFAULT_TIMEOUT;
    const headerTimeout = req.headers["x-tb-timeout"];
    if (headerTimeout) {
      const parsed = parseInt(headerTimeout);
      if (parsed > 0) timeoutMs = parsed;
    }

    // Forward to extension
    try {
      const result = await forwardToExtension(req.method, req.url, parsedBody, timeoutMs);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.code === "FORBIDDEN" ? 403 : err.message?.includes("not connected") ? 503 : 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: err.message || "Unknown error", code: err.code }));
    }
  });

  // A taken port is the most common startup failure (often an editor's port forwarding); explain it
  // instead of crashing with an unhandled 'error' event.
  function onServerError(label, port) {
    return (err) => {
      if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
        console.error(`[bridge] ${label} server error:`, err.message);
        return;
      }
      console.error(`[bridge] Cannot listen on ${HOST}:${port} (${label}): ${err.code === "EADDRINUSE" ? "port already in use" : "permission denied"}.`);
      console.error(`[bridge] See what holds it:  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      console.error(
        label === "WebSocket"
          ? `[bridge] The Thunderbird extension always connects to ws://${HOST}:${port}, so free this port (e.g. stop editor port forwarding) rather than changing it.`
          : `[bridge] Or pick another HTTP port: --port <n>, and set TB_BRIDGE_PORT=<n> for tb / tb-mcp.`
      );
      process.exit(1);
    };
  }
  wss.on("error", onServerError("WebSocket", WS_PORT));
  httpServer.on("error", onServerError("HTTP", HTTP_PORT));

  await new Promise((resolve) => {
    httpServer.listen(HTTP_PORT, HOST, () => {
      console.log(`[bridge] HTTP server on http://${HOST}:${HTTP_PORT}`);
      console.log(`[bridge] WebSocket server on ws://${HOST}:${WS_PORT}`);
      console.log(`[bridge] Default timeout: ${DEFAULT_TIMEOUT}ms (override via TB_BRIDGE_TIMEOUT env or X-TB-Timeout header)`);
      console.log(
        AUTH_TOKEN
          ? "[bridge] Auth: enabled (Authorization: Bearer required on all HTTP requests)"
          : "[bridge] Auth: disabled — any local process can call this bridge (set TB_AUTH_TOKEN to require a token)"
      );
      console.log(`[bridge] Waiting for Thunderbird extension to connect...`);
      resolve();
    });
  });

  return {
    httpServer,
    wss,
    close() {
      // Reject any pending requests so callers don't hang
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject({ message: "Bridge shutting down" });
      }
      pending.clear();

      return new Promise((resolveClose, rejectClose) => {
        let outstanding = 2;
        let failed = false;
        const done = (err) => {
          if (err && !failed) { failed = true; rejectClose(err); return; }
          if (--outstanding === 0 && !failed) resolveClose();
        };
        httpServer.close(done);
        wss.close(done);
      });
    },
  };
}

// ─── CLI entrypoint (only when run directly) ──────────────────────

const _entryHref = process.argv[1]
  ? pathToFileURL(process.argv[1]).href.toLowerCase()
  : "";
if (_entryHref === import.meta.url.toLowerCase()) {
  startBridge().catch((err) => {
    console.error("[bridge] Fatal:", err);
    process.exit(1);
  });
}
