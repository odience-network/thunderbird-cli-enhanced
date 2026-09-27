#!/usr/bin/env node

/**
 * Submit the built XPI through the addons.thunderbird.net (ATN) signing API and save
 * the ATN-approved file to dist/releases/.
 *
 * Unlike addons.mozilla.org, ATN does not add a META-INF/ signature: Thunderbird does
 * not require one. "Signed" here means ATN validated and approved the version and
 * serves these exact bytes; the download is checked against ATN's published sha256.
 *
 * Usage: npm run build:xpi && npm run sign:xpi [-- --xpi <file> --out-dir <dir>]
 * Output: dist/releases/<name>-<version>-tb.xpi
 *
 * Env:
 *   MOZILLA_HUB_JWT_ISSUER  ATN API key (JWT issuer)       — required
 *   MOZILLA_HUB_JWT_SECRET  ATN API secret                 — required
 *   ATN_API_URL             default https://addons.thunderbird.net/api/v4
 *   ATN_CHANNEL             "unlisted" (self-distributed, default) or "listed"
 *   ATN_SIGN_TIMEOUT        seconds to wait for approval, default 900
 *
 * The add-on ID in manifest.json must be new or owned by the API key's ATN account.
 * A version that was already uploaded (HTTP 409) resumes polling instead of failing,
 * and a file in dist/releases/ that already matches ATN's hash is left untouched.
 */

import AdmZip from "adm-zip";
import { createHash, createHmac, randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const { values } = parseArgs({
  options: { xpi: { type: "string" }, "out-dir": { type: "string" } },
});

const API_URL = (process.env.ATN_API_URL || "https://addons.thunderbird.net/api/v4").replace(/\/$/, "");
const CHANNEL = process.env.ATN_CHANNEL || "unlisted";
const TIMEOUT_MS = Number(process.env.ATN_SIGN_TIMEOUT || 900) * 1000;
const POLL_MS = Number(process.env.ATN_POLL_INTERVAL || 5) * 1000;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ─── Locate the unsigned XPI and read its manifest ─────────────────

const extManifest = JSON.parse(readFileSync(join(REPO_ROOT, "extension/manifest.json"), "utf-8"));
const xpiPath = values.xpi || join(REPO_ROOT, "dist", `thunderbird-cli-enhanced-${extManifest.version}.xpi`);
if (!existsSync(xpiPath)) fail(`${xpiPath} not found — run \`npm run build:xpi\` first`);

const manifestEntry = new AdmZip(xpiPath).getEntry("manifest.json");
if (!manifestEntry) fail(`${xpiPath} has no manifest.json at its root`);
const manifest = JSON.parse(manifestEntry.getData().toString("utf-8"));
const guid = manifest.browser_specific_settings?.gecko?.id;
const { name, version } = manifest;
if (!guid) fail("manifest.json has no browser_specific_settings.gecko.id — ATN signing needs a fixed ID");

const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
const outDir = values["out-dir"] || join(REPO_ROOT, "dist", "releases");
const outPath = join(outDir, `${slug}-${version}-tb.xpi`);

console.log(`Signing ${name} v${version} (${guid}) via ${API_URL}, channel ${CHANNEL}`);

const { MOZILLA_HUB_JWT_ISSUER: issuer, MOZILLA_HUB_JWT_SECRET: secret } = process.env;
if (!issuer || !secret) fail("MOZILLA_HUB_JWT_ISSUER and MOZILLA_HUB_JWT_SECRET must be set");

// ─── ATN API ───────────────────────────────────────────────────────

/** A fresh short-lived JWT per request; ATN rejects tokens older than 5 minutes. */
function authHeader() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: issuer, jti: randomUUID(), iat, exp: iat + 60 })}`;
  return `JWT ${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function api(method, url, body) {
  const res = await fetch(url, { method, body, headers: { Authorization: authHeader() } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const versionUrl = `${API_URL}/addons/${encodeURIComponent(guid)}/versions/${encodeURIComponent(version)}/`;

const form = new FormData();
form.append("upload", new Blob([readFileSync(xpiPath)]), basename(xpiPath));
form.append("channel", CHANNEL);

const upload = await api("PUT", versionUrl, form);
if (upload.status === 409) {
  console.log(`  version ${version} was already uploaded — waiting for its approved file`);
} else if (upload.status === 401 || upload.status === 403) {
  fail(`ATN refused the upload (${upload.status}): ${upload.json?.error || upload.json?.detail || upload.text}
  The add-on ID "${guid}" must be new or owned by the ATN account behind MOZILLA_HUB_JWT_ISSUER.`);
} else if (upload.status !== 201 && upload.status !== 202) {
  fail(`ATN upload failed (${upload.status}): ${upload.text.slice(0, 500)}`);
} else {
  console.log(`  uploaded (${upload.status}), waiting for validation and approval...`);
}

// ─── Poll until approved ───────────────────────────────────────────

const deadline = Date.now() + TIMEOUT_MS;
let approvedFile;
while (!approvedFile) {
  const { status, json, text } = await api("GET", versionUrl);
  if (status !== 200) fail(`ATN status check failed (${status}): ${text.slice(0, 500)}`);
  if (json.processed && !json.valid) {
    fail(`ATN validation failed — see ${json.validation_url}\n${JSON.stringify(json.validation_results?.messages ?? [], null, 2)}`);
  }
  if (json.reviewed && !json.passed_review) fail(`ATN review rejected v${version} — see ${json.validation_url}`);
  if (json.passed_review) approvedFile = json.files?.find((f) => f.download_url && f.hash);
  if (approvedFile) break;
  if (Date.now() > deadline) {
    fail(`not approved after ${TIMEOUT_MS / 1000}s (listed versions may need manual review) — re-run later to resume`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

// ─── Download and verify ───────────────────────────────────────────

const sha256 = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

if (existsSync(outPath) && sha256(readFileSync(outPath)) === approvedFile.hash) {
  console.log(`✓ ${basename(outPath)} already matches ATN's approved file — nothing to do`);
  process.exit(0);
}

const download = await fetch(approvedFile.download_url, { headers: { Authorization: authHeader() } });
if (!download.ok) fail(`approved XPI download failed (${download.status})`);
const approved = Buffer.from(await download.arrayBuffer());

if (sha256(approved) !== approvedFile.hash) {
  fail(`downloaded XPI hash ${sha256(approved)} does not match ATN's ${approvedFile.hash}`);
}
const approvedManifest = JSON.parse(new AdmZip(approved).getEntry("manifest.json").getData().toString("utf-8"));
if (approvedManifest.browser_specific_settings?.gecko?.id !== guid || approvedManifest.version !== version) {
  fail(`downloaded XPI is ${approvedManifest.browser_specific_settings?.gecko?.id} v${approvedManifest.version}, expected ${guid} v${version}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, approved);
console.log(`✓ ATN-approved ${basename(outPath)} (${approved.length} bytes, ${approvedFile.hash})`);
console.log(`  ${outPath}`);
