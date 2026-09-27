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

// ─── Grid Table Formatting (--output-version 2 only) ───────────────────
//
// Renderer for the opt-in "Default output (v2)" format — see docs/CLAUDE.md.
// Ported from the fork-KaiSingL output-format chain (ODIAA-2324), gated
// behind --output-version 2 / TB_OUTPUT_VERSION=2 per CLI-UX decision:
// today's {ok,data} envelope stays the default so existing scripts/agents
// parsing `tb` output aren't broken by a silent default-shape change.

const HAS_COLOR = process.stdout.isTTY;
const BOLD = HAS_COLOR ? "\x1b[1m" : "";
const RESET = HAS_COLOR ? "\x1b[0m" : "";
const GREEN = HAS_COLOR ? "\x1b[32m" : "";
const RED = HAS_COLOR ? "\x1b[31m" : "";

/**
 * Strip ANSI escape codes from a string for visual length measurement.
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Truncate a string to fit within a given visual width, appending ellipsis.
 */
function truncateToWidth(str, maxWidth) {
  const visual = stripAnsi(str);
  if (visual.length <= maxWidth) return str;
  if (maxWidth <= 1) return "…";
  let cut = 0;
  let visualLen = 0;
  for (const char of visual) {
    if (visualLen + 1 > maxWidth - 1) break;
    visualLen++;
    cut++;
  }
  return visual.slice(0, cut) + "…";
}

/**
 * Parse an author string like "Name <email>" into {name, email}.
 * Returns {name: "Name", email: "<email>"}.
 */
function parseAuthor(author) {
  if (!author) return { name: "", email: "" };
  const s = String(author);
  const match = s.match(/^(.*?)\s*<([^>]*)>/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return { name: name || "", email: `<${match[2]}>` };
  }
  return { name: "", email: `<${s}>` };
}

/**
 * Render an adaptive column table that fits within termWidth.
 *
 * columns: [{header, key, widthRule, truncate?, multiline?}]
 *   - widthRule: "auto" | "flex" | {fixed: n} | {min: n, flex: true}
 *   - truncate: boolean (default true)
 *   - multiline: number (default 1) — how many lines this column spans per row
 * rows: array of objects where keys match column `key`
 * termWidth: total terminal width
 *
 * Each data row renders exactly 2 lines. Multiline columns show [line1, line2];
 * single-line columns show value on line 1 and empty on line 2.
 */
function formatColumnTable(columns, rows, termWidth) {
  const padding = 1;
  const N = columns.length;
  // Overhead: left border + right border + (N-1) separators + N*2 padding
  const overhead = 2 + (N - 1) + N * 2;
  const availableWidth = Math.max(0, termWidth - overhead);

  // Phase 1: Calculate widths for non-flex columns
  const widths = new Array(N).fill(0);
  const isFlex = new Array(N).fill(false);
  let fixedTotal = 0;

  for (let i = 0; i < N; i++) {
    const col = columns[i];
    if (col.widthRule === "auto") {
      let maxW = stripAnsi(col.header).length;
      for (const row of rows) {
        const val = row[col.key];
        if (Array.isArray(val)) {
          for (const line of val) {
            maxW = Math.max(maxW, stripAnsi(String(line)).length);
          }
        } else {
          maxW = Math.max(maxW, stripAnsi(String(val)).length);
        }
      }
      widths[i] = maxW;
      fixedTotal += maxW;
    } else if (typeof col.widthRule === "object" && "fixed" in col.widthRule) {
      widths[i] = col.widthRule.fixed;
      fixedTotal += col.widthRule.fixed;
    } else if (typeof col.widthRule === "object" && col.widthRule.flex) {
      const min = col.widthRule.min || 5;
      widths[i] = min;
      isFlex[i] = true;
      fixedTotal += min;
    } else if (col.widthRule === "flex") {
      widths[i] = 5;
      isFlex[i] = true;
      fixedTotal += 5;
    }
  }

  // Phase 2: Distribute remaining space to flex columns
  const remaining = availableWidth - fixedTotal;
  if (remaining > 0 && isFlex.some(Boolean)) {
    const flexIndices = isFlex.map((f, i) => f ? i : -1).filter(i => i >= 0);
    const flexMinTotal = flexIndices.reduce((sum, i) => sum + widths[i], 0);
    let distributed = 0;
    for (let idx = 0; idx < flexIndices.length; idx++) {
      const i = flexIndices[idx];
      const share = idx === flexIndices.length - 1
        ? remaining - distributed
        : Math.round(remaining * (widths[i] / flexMinTotal));
      widths[i] += share;
      distributed += share;
    }
  }

  // Phase 3: Build table
  const colWidths = widths.map(w => w + padding * 2);

  const top = "┌" + colWidths.map(w => "─".repeat(w)).join("┬") + "┐";
  const sep = "├" + colWidths.map(w => "─".repeat(w)).join("┼") + "┤";
  const bot = "└" + colWidths.map(w => "─".repeat(w)).join("┴") + "┘";

  function pad(text, width) {
    const s = String(text);
    const visualLen = stripAnsi(s).length;
    return " ".repeat(padding) + s + " ".repeat(Math.max(0, width - visualLen - padding));
  }

  const linesPerRow = 2;

  // Build cell content for each row: [row][col][line]
  const cells = rows.map(row => {
    return columns.map((col, colIdx) => {
      const val = row[col.key];
      const shouldTruncate = col.truncate !== false;
      const isMultiline = col.multiline === 2;

      const lines = [];
      if (isMultiline && Array.isArray(val)) {
        lines.push(shouldTruncate ? truncateToWidth(String(val[0] || ""), widths[colIdx]) : String(val[0] || ""));
        lines.push(shouldTruncate ? truncateToWidth(String(val[1] || ""), widths[colIdx]) : String(val[1] || ""));
      } else {
        const text = shouldTruncate ? truncateToWidth(String(val || ""), widths[colIdx]) : String(val || "");
        lines.push(text);
        lines.push(""); // empty second line
      }
      return lines;
    });
  });

  const parts = [top];

  // Header row (1 line)
  const headerLine = "│" + columns.map((col, i) => {
    const h = HAS_COLOR ? `${BOLD}${col.header}${RESET}` : col.header;
    return pad(h, colWidths[i]);
  }).join("│") + "│";
  parts.push(headerLine);
  parts.push(sep);

  // Data rows (2 lines each)
  for (let r = 0; r < cells.length; r++) {
    for (let line = 0; line < linesPerRow; line++) {
      const rowLine = "│" + cells[r].map((cellLines, colIdx) => {
        return pad(cellLines[line] || "", colWidths[colIdx]);
      }).join("│") + "│";
      parts.push(rowLine);
    }
    if (r < cells.length - 1) {
      parts.push(sep);
    }
  }

  parts.push(bot);
  return parts.join("\n");
}

/**
 * Format a list of messages as a 2-line adaptive column table.
 */
function formatMessageListTable(messages) {
  if (!messages || !messages.length) return "";
  const unread = messages.filter(m => !m.read).length;
  const summary = `${messages.length} message${messages.length !== 1 ? "s" : ""}${unread ? ` (${unread} unread)` : ""}`;
  if (HAS_COLOR) {
    process.stdout.write(`${BOLD}${summary}${RESET}\n\n`);
  } else {
    process.stdout.write(summary + "\n\n");
  }

  // Check which columns have data
  const hasFolder = messages.some(m => m.folder?.path || m.folder?.name || (typeof m.folder === "string" && m.folder));

  // Date formatting: replace T with space
  const formatDateShort = (d) => d ? String(d).replace("T", " ") : "";

  // Parse author into name + email
  const rows = messages.map(m => {
    const { name, email } = parseAuthor(m.author);
    const folder = m.folder?.path || m.folder?.name || (typeof m.folder === "string" ? m.folder : "") || "";
    return {
      id: String(m.id),
      from: [name || email.slice(1, -1) || "", name ? email : ""],
      subject: m.subject || "",
      date: formatDateShort(m.date),
      read: m.read ? "◉" : "○",
      flagged: m.flagged ? "⚑" : "○",
      folder: folder,
    };
  });

  const columns = [
    { header: "#", key: "id", widthRule: "auto", truncate: false },
    { header: "from", key: "from", widthRule: { min: 8, flex: true }, truncate: true, multiline: 2 },
    { header: "subj", key: "subject", widthRule: { min: 10, flex: true }, truncate: true },
    { header: "date", key: "date", widthRule: "auto", truncate: false },
    { header: "◉", key: "read", widthRule: { fixed: 1 }, truncate: false },
    { header: "⚑", key: "flagged", widthRule: { fixed: 1 }, truncate: false },
  ];
  if (hasFolder) {
    columns.push({ header: "🗀", key: "folder", widthRule: { min: 5, flex: true }, truncate: true });
  }

  const termWidth = process.stdout.columns || 80;
  const table = formatColumnTable(columns, rows, termWidth);
  process.stdout.write(table + "\n");
}

function formatGrid(rows, { labelMin = 10, valueMin = 20, padding = 1 } = {}) {
  if (!rows.length) return "";

  const termWidth = process.stdout.columns || 80;
  const borderAndSep = 3; // │ + padding on each side = 1 + 1 + 1

  // Calculate max label width using visual length (strip ANSI codes for measurement)
  const maxLabel = Math.max(labelMin, ...rows.map((r) => stripAnsi(r.label).length));
  const maxAvailableValue = termWidth - maxLabel - borderAndSep - (padding * 2);
  const targetValueWidth = Math.max(valueMin, ...rows.map((r) => {
    return Math.max(...String(r.value).split("\n").map((l) => stripAnsi(l).length));
  }));
  const valueWidth = Math.min(targetValueWidth, maxAvailableValue);

  function wrapLine(text, width) {
    if (width <= 0) return [text];
    const lines = [];
    for (const raw of String(text).replace(/\r\n/g, "\n").replace(/\r/g, "").split("\n")) {
      // Use visual length for wrapping (strip ANSI for measurement)
      const visualRaw = stripAnsi(raw);
      if (visualRaw.length <= width) { lines.push(raw); continue; }
      let line = "";
      for (const word of raw.split(/(\s+)/)) {
        const visualLine = stripAnsi(line);
        const visualWord = stripAnsi(word);
        if (visualLine.length + visualWord.length > width && visualLine.length > 0) {
          lines.push(line);
          line = word.trimStart();
        } else {
          line += word;
        }
      }
      if (line) lines.push(line);
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines;
  }

  const prepared = rows.map((r) => ({
    label: r.label,
    lines: wrapLine(r.value, valueWidth),
  }));

  const lw = maxLabel + padding * 2;
  const vw = valueWidth + padding * 2;

  const top = "┌" + "─".repeat(lw) + "┬" + "─".repeat(vw) + "┐";
  const mid = "├" + "─".repeat(lw) + "┼" + "─".repeat(vw) + "┤";
  const bot = "└" + "─".repeat(lw) + "┴" + "─".repeat(vw) + "┘";

  function pad(text, width) {
    const s = String(text);
    const visualLen = stripAnsi(s).length;
    return " ".repeat(padding) + s + " ".repeat(Math.max(0, width - visualLen - padding));
  }

  const parts = [top];
  for (let i = 0; i < prepared.length; i++) {
    const row = prepared[i];
    for (let j = 0; j < row.lines.length; j++) {
      // Bold labels in the first line of each row
      const label = j === 0 ? `${BOLD}${row.label}${RESET}` : "";
      parts.push("│" + pad(label, lw) + "│" + pad(row.lines[j], vw) + "│");
    }
    if (i < prepared.length - 1) parts.push(mid);
  }
  parts.push(bot);
  return parts.join("\n");
}

function formatMessageTable(msg) {
  function humanSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  const body = (msg.parts?.text || msg.body || "").replace(/\r\n/g, "\n").replace(/\r/g, "");
  const attachments = msg.parts?.attachments || msg.attachments || [];
  const rows = [
    { label: "ID", value: String(msg.id ?? "") },
    { label: "Subject", value: msg.subject || "" },
    { label: "From", value: msg.author || "" },
  ];
  if (msg.recipients?.length) {
    rows.push({ label: "To", value: msg.recipients.join("\n") });
  }
  if (msg.ccList?.length) {
    rows.push({ label: "CC", value: msg.ccList.join("\n") });
  }
  if (msg.bccList?.length) {
    rows.push({ label: "BCC", value: msg.bccList.join("\n") });
  }
  rows.push(
    { label: "Date", value: msg.date || "" },
    { label: "Read", value: msg.read ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}` },
    { label: "Flagged", value: msg.flagged ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}` },
    { label: "Junk", value: msg.junk ? `${RED}✓${RESET}` : `${GREEN}✗${RESET}` },
  );
  if (msg.size) {
    rows.push({ label: "Size", value: humanSize(msg.size) });
  }
  if (msg.folder) {
    const name = msg.folder.name;
    const path = msg.folder.path;
    const folder = (name && name !== path?.split("/").pop()) ? `${path} (${name})` : (path || name || "");
    rows.push({ label: "Folder", value: folder });
  }
  if (msg.tags?.length) {
    rows.push({ label: "Tags", value: msg.tags.join("\n") });
  }
  if (msg.priority) {
    rows.push({ label: "Priority", value: String(msg.priority) });
  }
  if (body) {
    rows.push({ label: "Body", value: body });
  }
  if (attachments.length) {
    rows.push({
      label: "Attachments",
      value: attachments.map((a) => {
        const name = a.name || a.fileName || "unnamed";
        const meta = [];
        if (a.contentType) meta.push(a.contentType);
        if (a.size) meta.push(humanSize(a.size));
        return meta.length ? `${name} (${meta.join(", ")})` : name;
      }).join("\n"),
    });
  }
  return formatGrid(rows);
}

/**
 * Format an ISO date string for display.
 * Defaults to local time; use utc=true for UTC.
 */
function formatDate(isoStr, utc = false) {
  if (!isoStr) return isoStr || "";
  if (utc) return isoStr.slice(0, 16);
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Recursively transform all "date" keys in data using formatDate.
 * Applies local/UTC formatting consistently across all output formats.
 */
function transformDates(data, utc = false) {
  if (Array.isArray(data)) return data.map(item => transformDates(item, utc));
  if (data && typeof data === "object") {
    const result = {};
    for (const [k, v] of Object.entries(data)) {
      result[k] = k === "date" ? formatDate(v, utc) : transformDates(v, utc);
    }
    return result;
  }
  return data;
}

/**
 * Format a value for display in a table cell.
 * Handles arrays, objects, and primitives intelligently.
 */
function formatValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    // Array of primitives (strings, numbers)
    if (typeof v[0] !== "object" || v[0] === null) return v.join(", ");
    // Array of objects — summarize each
    return v.map(item => {
      if (item === null || item === undefined) return "";
      if (typeof item !== "object") return String(item);
      // Try to get a meaningful one-line summary
      const name = item.name || item.path || item.subject || item.author || item.email || "";
      const detail = item.path || item.type || item.role || item.contentType || item.size || "";
      if (name && detail && name !== detail) return `${name} (${detail})`;
      return name || detail || Object.entries(item).map(([k, val]) => `${k}: ${formatValue(val)}`).join(", ");
    }).join("\n");
  }
  // Plain object — show key: value lines
  const entries = Object.entries(v).filter(([, val]) => val !== null && val !== undefined);
  if (entries.length === 0) return "";
  return entries.map(([k, val]) => {
    const formatted = formatValue(val);
    return `${k}: ${formatted}`;
  }).join("\n");
}

// ─── Standard Output ───────────────────────────────────────────────

/**
 * v1 output (default): standard {ok, data} envelope, always. This is the
 * output shape documented in docs/CLAUDE.md and AGENTS.md and relied on by
 * every existing script/agent — do not change its behavior here.
 */
function outputV1(data, format, opts) {
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
 * v2 output (opt-in via --output-version 2 / TB_OUTPUT_VERSION=2): the
 * fork-KaiSingL "Default output (v2)" shape — smart TTY/pipe format,
 * bare data by default (--envelope restores {ok,data}), compact-by-default
 * JSON (--verbose restores nulls/empty arrays, --pretty restores indentation),
 * short field presets for list-shaped commands, local-time dates (--utc
 * restores UTC), and the adaptive Unicode table renderer.
 */
function outputV2(data, format, opts) {
  if (opts.maxBody) data = truncateBody(data, opts.maxBody);
  if (opts.fields) data = filterFields(data, opts.fields);

  // Compactify by default; skip only if --verbose
  // (Run BEFORE envelope wrapping so that null/empty keys are stripped
  // from inner data, preserving the envelope's `data` key.)
  if (!opts.verbose) data = compactify(data);

  // Envelope logic: errors always use envelope; success only if --envelope
  if (!opts.raw) {
    if (data && data.error) {
      // Error responses always use envelope format
      data = { ok: false, error: data.error, code: data.code || "THUNDERBIRD_ERROR" };
    } else if (opts.envelope) {
      // Success with envelope: wrap in {ok, data}
      data = { ok: true, data };
    }
    // else: output bare data, no envelope
  }
  data = transformDates(data, opts.utc);

  switch (format) {
    case "compact":
    case "json": {
      const indent = opts.pretty ? 2 : undefined;
      process.stdout.write(JSON.stringify(data, null, indent) + "\n");
      break;
    }
    case "table": {
      // If data is a string, just print it directly
      if (typeof data === "string") {
        process.stdout.write(data + "\n");
        break;
      }
      const inner = data?.data || data;
      if (Array.isArray(inner) && inner.length === 0) {
        process.stdout.write("No results found.\n");
        break;
      }
      if (inner?.messages && Array.isArray(inner.messages) && inner.messages.length === 0) {
        process.stdout.write("No results found.\n");
        break;
      }
      // Check for empty result objects (e.g., {total: 0, ...} without messages)
      if (inner && typeof inner === "object" && !Array.isArray(inner) && !inner.messages && !inner.subject && !inner.author) {
        const vals = Object.values(inner);
        if (vals.length === 0 || vals.every(v => v === 0 || v === false || v === "" || (Array.isArray(v) && v.length === 0))) {
          process.stdout.write("No results found.\n");
          break;
        }
      }
      if (Array.isArray(inner)) {
        // Check if it looks like message objects for enhanced display
        if (inner.length > 0 && inner[0] && inner[0].subject !== undefined) {
          formatMessageListTable(inner);
        } else {
          console.table(inner);
        }
      } else if (inner?.messages) {
        formatMessageListTable(inner.messages);
      } else if (inner?.subject && inner?.author) {
        process.stdout.write(formatMessageTable(inner) + "\n");
      } else {
        const rows = [];
        for (const [k, v] of Object.entries(inner)) {
          if (v && typeof v === "object" && !Array.isArray(v) &&
              Object.values(v).every(val => val == null || typeof val !== "object")) {
            // Flat object — promote each property as its own row
            for (const [pk, pv] of Object.entries(v)) {
              if (pv != null) rows.push({ label: pk, value: formatValue(pv) });
            }
          } else {
            rows.push({ label: k, value: formatValue(v) });
          }
        }
        process.stdout.write(formatGrid(rows) + "\n");
      }
      break;
    }
    default:
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

/**
 * Output data to stdout.
 * @param {*} data - raw response data
 * @param {string} format - json|compact|table
 * @param {object} opts - {outputVersion: 1|2, fields, compact, verbose, envelope,
 *   pretty, maxBody, raw, utc} — see outputV1/outputV2 for which opts apply to which version.
 */
export function output(data, format = "json", opts = {}) {
  if (opts.outputVersion === 2) {
    outputV2(data, format, opts);
  } else {
    outputV1(data, format, opts);
  }
}

/**
 * Output error to stderr and exit.
 * v1 (default): always pretty-printed, unchanged from today's behavior.
 * v2: compact JSON when piped, pretty when TTY.
 */
export function outputError(err, format = "json", opts = {}) {
  const data = {
    ok: false,
    error: err.message || String(err),
    code: err.code || "UNKNOWN",
  };
  const indent = opts.outputVersion === 2 ? (process.stderr.isTTY ? 2 : undefined) : 2;
  process.stderr.write(JSON.stringify(data, null, indent) + "\n");
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
