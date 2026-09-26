#!/usr/bin/env node
/**
 * scripts/sign-xpi.mjs tests.
 *
 * Runs the real signing script as a subprocess against an in-process mock of the
 * addons.thunderbird.net v4 signing API — no network, no real credentials.
 */

import AdmZip from "adm-zip";
import { spawn } from "child_process";
import { createHmac } from "crypto";
import { createServer } from "http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sign-xpi.mjs");
const ISSUER = "user:12345:67";
const SECRET = "test-secret";
const GUID = "test-addon@example.org";

let passed = 0, failed = 0;

function test(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} — expected ${expected}, got ${actual}`);
  }
}

function xpi({ signed = false, version = "1.2.3" } = {}) {
  const zip = new AdmZip();
  const manifest = { manifest_version: 2, name: "Test Add-on", version, browser_specific_settings: { gecko: { id: GUID } } };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  if (signed) zip.addFile("META-INF/mozilla.rsa", Buffer.from("sig"));
  return zip.toBuffer();
}

/** True when the Authorization header is a valid, short-lived HS256 JWT for ISSUER. */
function validJwt(header) {
  const [scheme, token] = (header || "").split(" ");
  const [h, p, s] = (token || "").split(".");
  if (scheme !== "JWT" || !s) return false;
  if (createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url") !== s) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  return claims.iss === ISSUER && !!claims.jti && claims.exp - claims.iat <= 300;
}

/**
 * Start a mock ATN. `scenario` picks the upload response and the status sequence;
 * resolves with { url, requests, close }.
 */
function startAtn(scenario) {
  const requests = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString("latin1")));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: validJwt(req.headers.authorization), body });
      const send = (status, json) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      if (req.url === "/download/signed.xpi") {
        res.writeHead(200);
        return res.end(xpi({ signed: scenario !== "unsigned-download", version: "1.2.3" }));
      }
      if (req.method === "PUT") {
        if (scenario === "not-owner") return send(403, { error: "You do not own this addon." });
        if (scenario === "already-uploaded") return send(409, { error: "Version already exists." });
        return send(202, { processed: false });
      }
      polls++;
      const done = polls >= 2;
      send(200, {
        processed: done,
        valid: scenario !== "invalid",
        validation_url: `${base}/validation/1`,
        validation_results: { messages: [{ type: "error", message: "bad manifest" }] },
        files: done && scenario !== "invalid" ? [{ signed: true, download_url: `${base}/download/signed.xpi` }] : [],
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() })
    )
  );
}

function runSign(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ATN_POLL_INTERVAL: "0.01", ATN_SIGN_TIMEOUT: "10", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (out += c));
    proc.on("exit", (code) => resolve({ code, out }));
  });
}

async function scenario(name, run) {
  const dir = mkdtempSync(join(tmpdir(), "sign-xpi-"));
  const input = join(dir, "unsigned.xpi");
  writeFileSync(input, xpi());
  const out = join(dir, "releases");
  const signedPath = join(out, "test_add_on-1.2.3-tb.xpi");
  try {
    await run({ dir, input, out, signedPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const creds = { MOZILLA_HUB_JWT_ISSUER: ISSUER, MOZILLA_HUB_JWT_SECRET: SECRET };

console.log("\nsign-xpi");

await scenario("happy path", async ({ input, out, signedPath }) => {
  const atn = await startAtn("ok");
  const r = await runSign(["--xpi", input, "--out-dir", out], { ...creds, ATN_API_URL: atn.url });
  atn.close();
  test("signs and exits 0", r.code, 0);
  test("writes <slug>-<version>-tb.xpi", existsSync(signedPath), true);
  test("output carries the signature", !!new AdmZip(readFileSync(signedPath)).getEntry("META-INF/mozilla.rsa"), true);
  test("uploads to /addons/<guid>/versions/<version>/", atn.requests[0].url, `/addons/${encodeURIComponent(GUID)}/versions/1.2.3/`);
  test("uploads as PUT", atn.requests[0].method, "PUT");
  test("uploads the unlisted channel by default", /name="channel"\r\n\r\nunlisted/.test(atn.requests[0].body), true);
  test("every request carries a valid JWT", atn.requests.every((q) => q.auth), true);

  const again = await runSign(["--xpi", input, "--out-dir", out], { ATN_API_URL: "http://127.0.0.1:9" });
  test("re-run with the signed file present is a no-op", again.code, 0);
});

await scenario("already uploaded resumes", async ({ input, out, signedPath }) => {
  const atn = await startAtn("already-uploaded");
  const r = await runSign(["--xpi", input, "--out-dir", out], { ...creds, ATN_API_URL: atn.url });
  atn.close();
  test("409 on upload resumes polling", r.code, 0);
  test("409 still yields the signed file", existsSync(signedPath), true);
});

await scenario("not owner", async ({ input, out, signedPath }) => {
  const atn = await startAtn("not-owner");
  const r = await runSign(["--xpi", input, "--out-dir", out], { ...creds, ATN_API_URL: atn.url });
  atn.close();
  test("foreign add-on ID fails", r.code, 1);
  test("foreign add-on ID explains ownership", r.out.includes("must be new or owned"), true);
  test("foreign add-on ID writes nothing", existsSync(signedPath), false);
});

await scenario("validation failure", async ({ input, out, signedPath }) => {
  const atn = await startAtn("invalid");
  const r = await runSign(["--xpi", input, "--out-dir", out], { ...creds, ATN_API_URL: atn.url });
  atn.close();
  test("invalid upload fails", r.code, 1);
  test("invalid upload reports the validation messages", r.out.includes("bad manifest"), true);
  test("invalid upload writes nothing", existsSync(signedPath), false);
});

await scenario("unsigned download", async ({ input, out, signedPath }) => {
  const atn = await startAtn("unsigned-download");
  const r = await runSign(["--xpi", input, "--out-dir", out], { ...creds, ATN_API_URL: atn.url });
  atn.close();
  test("download without META-INF signature fails", r.code, 1);
  test("download without signature writes nothing", existsSync(signedPath), false);
});

await scenario("missing credentials", async ({ input, out }) => {
  const r = await runSign(["--xpi", input, "--out-dir", out], {
    MOZILLA_HUB_JWT_ISSUER: "",
    MOZILLA_HUB_JWT_SECRET: "",
    ATN_API_URL: "http://127.0.0.1:9",
  });
  test("missing credentials fail", r.code, 1);
  test("missing credentials are named", r.out.includes("MOZILLA_HUB_JWT_ISSUER"), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
