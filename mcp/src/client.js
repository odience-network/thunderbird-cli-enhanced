/**
 * Minimal HTTP client for the thunderbird-cli bridge.
 *
 * This is a self-contained copy of the functions needed by the MCP server,
 * so that the mcp package has no runtime dependency on the cli package.
 * Keep in sync with cli/src/client.js.
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve as pathResolve, dirname } from "path";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATHS = [
  join(homedir(), ".config", "thunderbird-cli", "config.json"),
  join(homedir(), ".config", "thunderbird-ai", "config.json"),
];

function loadConfig() {
  const defaults = { host: "127.0.0.1", port: 7700, authToken: null };
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
    port: parseInt(
      envPort || fileConfig.bridge?.httpPort || fileConfig.port || defaults.port
    ),
    authToken:
      envToken || fileConfig.bridge?.authToken || fileConfig.authToken || defaults.authToken,
  };
}

const config = loadConfig();
const BASE_URL = `http://${config.host}:${config.port}`;

// ─── Bridge Auto-Start ─────────────────────────────────────────────

/**
 * Probe the bridge with a lightweight GET /bridge/status request.
 * Returns true if the bridge responded, false otherwise.
 */
function probeBridge(host, port) {
  return new Promise((ok) => {
    const req = httpRequest(
      { hostname: host, port, path: "/bridge/status", method: "GET", timeout: 2000 },
      (res) => {
        res.resume(); // drain the response
        ok(res.statusCode >= 200 && res.statusCode < 500);
      },
    );
    req.on("error", () => ok(false));
    req.on("timeout", () => {
      req.destroy();
      ok(false);
    });
    req.end();
  });
}

/**
 * Probe the bridge and return the full status object.
 * Returns null if the bridge is unreachable.
 */
function probeBridgeStatus(host, port) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: host, port, path: "/bridge/status", method: "GET", timeout: 2000 },
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
    req.end();
  });
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let bridgeEnsured = false;

/**
 * Ensure the bridge daemon is running, auto-starting it if necessary.
 *
 * On first call this probes the bridge; if unreachable it spawns the bridge
 * as a detached child process and retries the probe with increasing delays
 * (~15 s total). After the bridge HTTP is up, waits for the Thunderbird
 * extension to connect via WebSocket (~10 s timeout). Subsequent calls are no-ops.
 */
export async function ensureBridge() {
  if (bridgeEnsured) return;

  // Fast path — bridge already running
  if (await probeBridge(config.host, config.port)) {
    bridgeEnsured = true;
    return;
  }

  // Resolve the bridge script relative to this file (mcp/src/client.js)
  const bridgePath = pathResolve(__dirname, "../../bridge/bridge.js");

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
    if (await probeBridge(config.host, config.port)) {
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
    const status = await probeBridgeStatus(config.host, config.port);
    if (status?.extension === "connected") break;
    await sleep(delay);
  }

  bridgeEnsured = true;
}

/**
 * Make an HTTP call to the bridge daemon.
 */
export async function api(method, path, body = null, timeout = 30000) {
  await ensureBridge();

  const url = `${BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (config.authToken) headers["Authorization"] = `Bearer ${config.authToken}`;
  // Tell the bridge how long it should wait for Thunderbird before giving up.
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
      throw Object.assign(
        new Error(
          "Cannot connect to Thunderbird bridge at " +
            BASE_URL +
            ". Is the bridge daemon running? See https://github.com/vitalio-sh/thunderbird-cli#quick-start"
        ),
        { code: "BRIDGE_UNREACHABLE" }
      );
    }
    throw err;
  }

  const data = await res.json();
  if (res.status >= 400) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code =
      data.code || (res.status === 503 ? "EXTENSION_DISCONNECTED" : "THUNDERBIRD_ERROR");
    throw err;
  }
  return data;
}

/**
 * Parse relative date strings (7d, 2w, 3m, 1y, today, yesterday) to ISO dates.
 */
export function parseRelativeDate(input) {
  if (!input) return input;
  const now = new Date();
  const lower = input.toLowerCase().trim();
  if (lower === "today")
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
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
  return input;
}
