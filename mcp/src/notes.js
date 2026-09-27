/**
 * Local Markdown notes workspace.
 *
 * Notes live entirely on the user's disk as plain `.md` files with optional
 * YAML-ish front matter (title, created, source message id) — no bridge or
 * extension round-trip is involved. Filenames are derived from a
 * caller-supplied `name`, restricted to a safe charset and re-validated to
 * stay inside the configured notes directory (defense in depth against path
 * traversal even though the charset already forbids `/`, `\` and `..`).
 *
 * This is a self-contained copy of cli/src/notes.js, so the mcp package has
 * no runtime dependency on the cli package (see client.js). Keep in sync.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Same config files the HTTP client reads from (see client.js) — `notesDir`
// lives alongside `bridge`/`defaults` in that JSON.
const CONFIG_PATHS = [
  join(homedir(), ".config", "thunderbird-cli", "config.json"),
  join(homedir(), ".config", "thunderbird-ai", "config.json"),
];

function loadNotesDir() {
  if (process.env.TB_NOTES_DIR) return resolve(process.env.TB_NOTES_DIR);

  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) {
      try {
        const config = JSON.parse(readFileSync(p, "utf-8"));
        if (config.notesDir) return resolve(config.notesDir);
      } catch {}
      break;
    }
  }

  return join(homedir(), ".config", "thunderbird-cli", "notes");
}

export function getNotesDir() {
  return loadNotesDir();
}

function ensureNotesDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function invalidArgs(message) {
  return Object.assign(new Error(`INVALID_ARGS: ${message}`), { code: "INVALID_ARGS" });
}

const MAX_NAME_LENGTH = 150;
const SAFE_NAME = /^[A-Za-z0-9 _.-]+$/;

export function sanitizeNoteName(name) {
  if (typeof name !== "string") throw invalidArgs("note name must be a string");
  let base = name.trim();
  if (base.toLowerCase().endsWith(".md")) base = base.slice(0, -3);
  if (
    !base ||
    base.length > MAX_NAME_LENGTH ||
    base.includes("/") ||
    base.includes("\\") ||
    base.includes("\0") ||
    base.includes("..") ||
    /^\.+$/.test(base) ||
    /[\x00-\x1f]/.test(base) ||
    !SAFE_NAME.test(base)
  ) {
    throw invalidArgs(
      "note name may only contain letters, numbers, spaces, '.', '_', '-', and must not reference parent directories"
    );
  }
  return base;
}

// Resolves `name` to an absolute path inside `notesDir`, refusing to return
// anything outside it even if the charset check above were ever loosened.
function resolveNotePath(notesDir, name) {
  const safeName = sanitizeNoteName(name);
  const dir = resolve(notesDir);
  const filePath = resolve(dir, `${safeName}.md`);
  if (!filePath.startsWith(dir + sep)) {
    throw Object.assign(new Error("FORBIDDEN: resolved note path escapes the notes workspace"), { code: "FORBIDDEN" });
  }
  return { filePath, safeName };
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontMatter(raw) {
  const match = raw.match(FRONT_MATTER_RE);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    try {
      value = JSON.parse(value);
    } catch {
      // Not a quoted/JSON scalar — keep the raw trimmed string.
    }
    meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length) };
}

function serializeFrontMatter(meta) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function readRaw(filePath) {
  return readFileSync(filePath, "utf-8");
}

export function listNotes(opts = {}) {
  const dir = opts.notesDir ? resolve(opts.notesDir) : getNotesDir();
  ensureNotesDir(dir);
  const notes = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => {
      const full = join(dir, f);
      const stat = statSync(full);
      const { meta } = parseFrontMatter(readRaw(full));
      const name = f.slice(0, -3);
      return {
        name,
        title: meta.title || name,
        created: meta.created || stat.birthtime.toISOString(),
        source: meta.source ?? null,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });
  notes.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return notes;
}

export function readNote(name, opts = {}) {
  const dir = opts.notesDir ? resolve(opts.notesDir) : getNotesDir();
  const { filePath, safeName } = resolveNotePath(dir, name);
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`NOT_FOUND: note '${safeName}' does not exist`), { code: "NOT_FOUND" });
  }
  const stat = statSync(filePath);
  const { meta, body } = parseFrontMatter(readRaw(filePath));
  return {
    name: safeName,
    title: meta.title || safeName,
    created: meta.created || stat.birthtime.toISOString(),
    source: meta.source ?? null,
    modified: stat.mtime.toISOString(),
    body: body.trimEnd(),
  };
}

export function saveNote(name, body, opts = {}) {
  const dir = opts.notesDir ? resolve(opts.notesDir) : getNotesDir();
  ensureNotesDir(dir);
  const { filePath, safeName } = resolveNotePath(dir, name);
  const meta = {
    title: opts.title || safeName,
    created: new Date().toISOString(),
    source: opts.source ?? undefined,
  };
  writeFileSync(filePath, serializeFrontMatter(meta) + String(body ?? "").trimEnd() + "\n", "utf-8");
  return { name: safeName, title: meta.title, path: filePath };
}

export function appendNote(name, body, opts = {}) {
  const dir = opts.notesDir ? resolve(opts.notesDir) : getNotesDir();
  ensureNotesDir(dir);
  const { filePath, safeName } = resolveNotePath(dir, name);

  if (existsSync(filePath)) {
    const { meta, body: existingBody } = parseFrontMatter(readRaw(filePath));
    const nextMeta = { ...meta };
    if (opts.title) nextMeta.title = opts.title;
    if (opts.source !== undefined) nextMeta.source = opts.source;
    const combined = `${existingBody.trimEnd()}\n\n${String(body ?? "").trimEnd()}\n`;
    writeFileSync(filePath, serializeFrontMatter(nextMeta) + combined, "utf-8");
    return { name: safeName, title: nextMeta.title || safeName, path: filePath, created: false };
  }

  const meta = { title: opts.title || safeName, created: new Date().toISOString(), source: opts.source ?? undefined };
  writeFileSync(filePath, serializeFrontMatter(meta) + String(body ?? "").trimEnd() + "\n", "utf-8");
  return { name: safeName, title: meta.title, path: filePath, created: true };
}

export function deleteNote(name, opts = {}) {
  const dir = opts.notesDir ? resolve(opts.notesDir) : getNotesDir();
  const { filePath, safeName } = resolveNotePath(dir, name);
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`NOT_FOUND: note '${safeName}' does not exist`), { code: "NOT_FOUND" });
  }
  unlinkSync(filePath);
  return { name: safeName, deleted: true };
}

export function searchNotes(query, opts = {}) {
  if (typeof query !== "string" || !query.trim()) throw invalidArgs("query is required");
  const dir = opts.notesDir ? resolve(opts.notesDir) : getNotesDir();
  ensureNotesDir(dir);
  const q = query.trim().toLowerCase();

  const results = [];
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, file);
    const { meta, body } = parseFrontMatter(readRaw(full));
    const name = file.slice(0, -3);
    const title = meta.title || name;
    const haystack = `${title}\n${body}`;
    const idx = haystack.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    const stat = statSync(full);
    const start = Math.max(0, idx - 40);
    const snippet = haystack.slice(start, idx + q.length + 40).replace(/\s+/g, " ").trim();
    results.push({
      name,
      title,
      source: meta.source ?? null,
      modified: stat.mtime.toISOString(),
      snippet,
    });
  }
  results.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return results;
}

// ─── Markdown → sanitized HTML (for note_to_draft) ─────────────────

marked.use({ gfm: true, breaks: true });

export function renderNoteHtml(markdown) {
  const rawHtml = marked.parse(String(markdown ?? ""));
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title"],
      a: ["href", "name", "target"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
    },
  });
}
