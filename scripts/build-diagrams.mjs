#!/usr/bin/env node

/**
 * Rebuild every diagram in docs/diagrams/ from its archify JSON IR.
 *
 * Usage: npm run build:diagrams [-- --no-png] [-- <name> ...]
 *
 * For each docs/diagrams/src/<name>.json:
 *   1. archify validate <type> --quality showcase
 *   2. archify deliver  <type> → docs/diagrams/<name>.html (self-contained, interactive)
 *   3. headless Chromium → docs/diagrams/<name>.png and <name>-dark.png, produced by the
 *      viewer's own Export → PNG code path (the same bytes a reader gets from the menu)
 *
 * The IR in docs/diagrams/src/ is the source of truth; never hand-edit the HTML or PNGs.
 *
 * Requirements:
 *   - archify skill installed project-locally (pinned in skills-lock.json):
 *       npx skills experimental_install      # restore from skills-lock.json
 *       npx skills add tt-a1i/archify --skill archify --agent claude-code -y
 *     or point ARCHIFY_BIN at an archify/bin/archify.mjs checkout.
 *   - Chrome/Chromium for PNG export: found via ARCHIFY_CHROME / CHROME_PATH, the usual
 *     binary names on PATH, or Playwright's cache (npx playwright install chromium).
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname, basename, delimiter } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir, homedir } from "os";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DIAGRAM_DIR = join(REPO_ROOT, "docs/diagrams");
const SRC_DIR = join(DIAGRAM_DIR, "src");
// `skills experimental_install` restores into .agents/skills, `skills add --agent claude-code`
// into .claude/skills; accept either.
const ARCHIFY_BIN =
  process.env.ARCHIFY_BIN ||
  [".claude/skills", ".agents/skills"]
    .map((d) => join(REPO_ROOT, d, "archify/bin/archify.mjs"))
    .find((p) => existsSync(p)) ||
  join(REPO_ROOT, ".claude/skills/archify/bin/archify.mjs");
// PNG width in CSS pixels × this factor. 2 keeps text crisp on HiDPI without multi-MB files.
const PNG_SCALE = 2;

// Never phone home from builds or CI.
process.env.ARCHIFY_UPDATE_CHECK_DISABLED = "1";

const { values, positionals } = parseArgs({
  options: { "no-png": { type: "boolean", default: false } },
  allowPositionals: true,
});

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(ARCHIFY_BIN)) {
  fail(`archify not found at ${ARCHIFY_BIN}
  Install it project-locally (pinned in skills-lock.json):
    npx skills experimental_install
  or: npx skills add tt-a1i/archify --skill archify --agent claude-code -y
  or set ARCHIFY_BIN to an archify/bin/archify.mjs checkout.`);
}

// ─── validate + deliver ────────────────────────────────────────────

const names = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => basename(f, ".json"))
  .filter((n) => positionals.length === 0 || positionals.includes(n))
  .sort();
if (names.length === 0) fail(`no matching IR files in ${SRC_DIR}`);

function archify(...args) {
  const r = spawnSync(process.execPath, [ARCHIFY_BIN, ...args], { encoding: "utf8" });
  if (r.status !== 0) fail(`archify ${args.slice(0, 3).join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

const delivered = [];
for (const name of names) {
  const src = join(SRC_DIR, `${name}.json`);
  const type = JSON.parse(readFileSync(src, "utf8")).diagram_type;
  const out = join(DIAGRAM_DIR, `${name}.html`);
  archify("validate", type, src, "--quality", "showcase");
  const receipt = JSON.parse(archify("deliver", type, src, out, "--quality", "showcase", "--json"));
  const v = receipt.validation;
  console.log(`✓ ${name}.html (${type}, ${v.checksPassed}/${v.checkCount} checks, ${v.errors} errors, ${v.warnings} warnings)`);
  delivered.push({ name, html: out });
}

if (values["no-png"]) process.exit(0);

// ─── PNG export via headless Chromium (Chrome DevTools Protocol) ───

function findChrome() {
  for (const env of ["ARCHIFY_CHROME", "CHROME_PATH"]) {
    if (process.env[env] && existsSync(process.env[env])) return process.env[env];
  }
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
    }
  }
  const cache = join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((d) => d.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        if (existsSync(join(cache, d, rel))) return join(cache, d, rel);
      }
    }
  }
  return null;
}

const chromePath = findChrome();
if (!chromePath) {
  fail("Chrome/Chromium not found for PNG export. Set ARCHIFY_CHROME, run `npx playwright install chromium`, or pass --no-png.");
}

const profile = mkdtempSync(join(tmpdir(), "tb-diagrams-"));
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--window-size=1600,1000", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  ...(process.env.ARCHIFY_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const browserWs = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before DevTools was ready:\n${buf}`)));
  setTimeout(() => reject(new Error("timed out waiting for Chrome DevTools")), 30000);
});

const targets = await (await fetch(browserWs.replace(/^ws/, "http").replace(/\/devtools\/browser\/.*/, "/json/list"))).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });

let seq = 0;
const waiting = new Map();
const listeners = new Set();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const once = (method) => new Promise((r) => { const l = (m) => { if (m.method === method) { listeners.delete(l); r(m); } }; listeners.add(l); });

// Runs inside the delivered HTML: switch theme, trigger the viewer's PNG export, capture the
// blob its download() hands to <a>.click(), downscale to PNG_SCALE, return base64.
const exportInPage = (theme) => `(async () => {
  await document.fonts.ready;
  document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
  let href;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) href = this.href; else click.call(this); };
  try { await Archify.exportMenu.run('png'); } finally { HTMLAnchorElement.prototype.click = click; }
  if (!href) throw new Error('export produced no download');
  const img = new Image();
  img.src = href;
  await img.decode();
  const vb = document.querySelector('.diagram-container svg').viewBox.baseVal;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vb.width * ${PNG_SCALE});
  canvas.height = Math.round(canvas.width * img.naturalHeight / img.naturalWidth);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
})()`;

try {
  await cdp("Page.enable");
  for (const { name, html } of delivered) {
    for (const [theme, suffix] of [["light", ""], ["dark", "-dark"]]) {
      const loaded = once("Page.loadEventFired");
      await cdp("Page.navigate", { url: pathToFileURL(html).href });
      await loaded;
      const r = await cdp("Runtime.evaluate", { expression: exportInPage(theme), awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${name} (${theme}): ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      const out = join(DIAGRAM_DIR, `${name}${suffix}.png`);
      writeFileSync(out, Buffer.from(r.result.value, "base64"));
      console.log(`✓ ${basename(out)}`);
    }
  }
} catch (err) {
  process.exitCode = 1;
  console.error(`✗ PNG export failed: ${err.message}`);
} finally {
  ws.close();
  chrome.kill();
  await new Promise((r) => chrome.once("exit", r));
  rmSync(profile, { recursive: true, force: true });
}
