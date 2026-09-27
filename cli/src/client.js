/**
 * HTTP client for Thunderbird CLI Bridge
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";

// Config file paths — check both locations
const CONFIG_PATHS = [
  join(homedir(), ".config", "thunderbird-cli", "config.json"),
  join(homedir(), ".config", "thunderbird-ai", "config.json"),
];

function loadConfig() {
  const defaults = {
    host: "127.0.0.1",
    port: 7700,
    authToken: null,
    defaults: { limit: 25, fields: null, compact: false, maxBody: null },
  };

  const envHost = process.env.TB_BRIDGE_HOST;
  const envPort = process.env.TB_BRIDGE_PORT;
  const envToken = process.env.TB_AUTH_TOKEN;

  let fileConfig = {};
  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) {
      try {
        fileConfig = JSON.parse(readFileSync(p, "utf-8"));
        break;
      } catch {}
    }
  }

  return {
    host: envHost || fileConfig.bridge?.host || fileConfig.host || defaults.host,
    port: parseInt(envPort || fileConfig.bridge?.httpPort || fileConfig.port || defaults.port),
    authToken: envToken || fileConfig.bridge?.authToken || fileConfig.authToken || defaults.authToken,
    defaults: { ...defaults.defaults, ...(fileConfig.defaults || {}) },
  };
}

const config = loadConfig();
const BASE_URL = `http://${config.host}:${config.port}`;

// ─── Bridge Auto-Start ─────────────────────────────────────────────

let bridgeEnsured = false;

/**
 * Probe the bridge daemon with a short GET /bridge/status request.
 * Returns true if the bridge responded, false otherwise.
 */
function probeBridge() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: config.host, port: config.port, path: "/bridge/status", timeout: 2000 },
      (res) => {
        res.resume(); // drain the response
        resolve(res.statusCode < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * Probe the bridge and return the full status object.
 * Returns null if the bridge is unreachable.
 */
function probeBridgeStatus() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: config.host, port: config.port, path: "/bridge/status", timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 500) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * Auto-start the bridge daemon if it's not already running.
 * - Probes GET /bridge/status first; returns immediately if reachable.
 * - If unreachable, spawns bridge.js as a detached child and retries
 *   the probe with increasing delays (~15 s total).
 * - After the bridge HTTP is up, waits for the Thunderbird extension
 *   to connect via WebSocket (~10 s timeout).
 */
export async function ensureBridge() {
  if (bridgeEnsured) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Quick probe — bridge is already running
  if (await probeBridge()) {
    bridgeEnsured = true;
    return;
  }

  // Resolve bridge script path relative to this file's location
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const bridgePath = resolve(cliDir, "../../bridge/bridge.js");

  // Spawn as detached so the child survives parent exit
  const child = spawn("node", [bridgePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Wait for bridge HTTP to be ready (~15s total)
  const httpDelays = [300, 500, 800, 1000, 1200, 1500, 2000, 2500, 3000, 3000];
  let httpReady = false;
  for (const delay of httpDelays) {
    await sleep(delay);
    if (await probeBridge()) {
      httpReady = true;
      break;
    }
  }

  if (!httpReady) {
    throw new Error("Bridge auto-start failed: could not connect within the retry window");
  }

  // Wait for Thunderbird extension to connect (~10s total)
  const extDelays = [500, 500, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
  for (const delay of extDelays) {
    const status = await probeBridgeStatus();
    if (status?.extension === "connected") break;
    await sleep(delay);
  }

  bridgeEnsured = true;
}

/**
 * Make API call to bridge
 */
export async function api(method, path, body = null, timeout = 30000) {
  if (!bridgeEnsured) await ensureBridge();

  const url = `${BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (config.authToken) headers["Authorization"] = `Bearer ${config.authToken}`;
  // Tell the bridge how long it should wait for Thunderbird before giving up.
  // Without this header the bridge uses its own default (TB_BRIDGE_TIMEOUT or 120s).
  if (timeout) headers["X-TB-Timeout"] = String(timeout);

  const opts = { method, headers };
  if (body && (method === "POST" || method === "PUT")) {
    opts.body = JSON.stringify(body);
  }
  if (timeout) opts.signal = AbortSignal.timeout(timeout);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw Object.assign(new Error("Request timed out"), { code: "TIMEOUT" });
    }
    if (err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
      throw Object.assign(new Error("Cannot connect to bridge. Is it running?"), {
        code: "BRIDGE_UNREACHABLE",
      });
    }
    throw err;
  }

  const data = await res.json();
  if (res.status >= 400) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code || (res.status === 503 ? "EXTENSION_DISCONNECTED" : "THUNDERBIRD_ERROR");
    throw err;
  }
  return data;
}

export function getConfig() {
  return config;
}

// ─── Output Transformations ────────────────────────────────────────

function pickFields(obj, fields) {
  const result = {};
  for (const f of fields) {
    if (f in obj) result[f] = obj[f];
  }
  return result;
}

function filterFields(data, fields) {
  if (!fields || !fields.length) return data;
  if (Array.isArray(data)) return data.map((item) => pickFields(item, fields));
  if (data && typeof data === "object") {
    if (data.messages) return { ...data, messages: data.messages.map((m) => pickFields(m, fields)) };
    if (data.thread) return { ...data, thread: data.thread.map((m) => pickFields(m, fields)) };
    return pickFields(data, fields);
  }
  return data;
}

function compactify(data) {
  if (Array.isArray(data)) return data.map(compactify);
  if (data && typeof data === "object") {
    const result = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      result[k] = compactify(v);
    }
    return result;
  }
  return data;
}

function truncateBody(data, maxChars) {
  if (!maxChars || maxChars <= 0) return data;
  if (data && typeof data === "object") {
    const result = { ...data };
    if (result.parts && typeof result.parts === "object") {
      result.parts = { ...result.parts };
      if (typeof result.parts.text === "string" && result.parts.text.length > maxChars) {
        result.parts.text = result.parts.text.slice(0, maxChars) + "\n...[truncated]";
        result.parts.textTruncated = true;
      }
    }
    if (typeof result.body === "string" && result.body.length > maxChars) {
      result.body = result.body.slice(0, maxChars) + "\n...[truncated]";
      result.bodyTruncated = true;
    }
    if (result.messages) result.messages = result.messages.map((m) => truncateBody(m, maxChars));
    return result;
  }
  return data;
}

// ─── Standard Output ───────────────────────────────────────────────

/**
 * Output data in standard {ok, data} format
 * @param {*} data - raw response data
 * @param {string} format - json|compact|table
 * @param {object} opts - {fields: string[], compact: bool, maxBody: number, raw: bool}
 */
export function output(data, format = "json", opts = {}) {
  if (opts.maxBody) data = truncateBody(data, opts.maxBody);
  if (opts.fields) data = filterFields(data, opts.fields);

  // Wrap in standard {ok, data} format unless raw
  if (!opts.raw) {
    if (data && data.error) {
      data = { ok: false, error: data.error, code: data.code || "THUNDERBIRD_ERROR" };
    } else {
      data = { ok: true, data };
    }
  }

  if (opts.compact) data = compactify(data);

  switch (format) {
    case "compact":
      process.stdout.write(JSON.stringify(data) + "\n");
      break;
    case "table": {
      const inner = data?.data || data;
      if (Array.isArray(inner)) {
        console.table(inner);
      } else if (inner?.messages) {
        console.table(
          inner.messages.map((m) => ({
            id: m.id,
            from: m.author?.slice(0, 30),
            subject: m.subject?.slice(0, 50),
            date: m.date?.slice(0, 16),
            read: m.read ? "✓" : "✗",
            folder: m.folder?.path,
          }))
        );
      } else {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      }
      break;
    }
    default:
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

/**
 * Output error to stderr and exit
 */
export function outputError(err, format = "json") {
  const data = {
    ok: false,
    error: err.message || String(err),
    code: err.code || "UNKNOWN",
  };
  process.stderr.write(JSON.stringify(data, null, 2) + "\n");
  process.exit(1);
}

/**
 * Parse relative date strings (7d, 2w, 3m, 1y, today, yesterday) to ISO dates
 */
export function parseRelativeDate(input) {
  if (!input) return input;
  const now = new Date();
  const lower = input.toLowerCase().trim();
  if (lower === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  if (lower === "yesterday") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  }
  const match = lower.match(/^(\d+)([dwmy])$/);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2];
    const d = new Date(now);
    if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - n * 7);
    else if (unit === "m") d.setMonth(d.getMonth() - n);
    else if (unit === "y") d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  }
  return input; // assume ISO date
}
