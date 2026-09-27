#!/usr/bin/env node
/**
 * Notes workspace tests.
 *
 * Exercises cli/src/notes.js and mcp/src/notes.js (self-contained copies,
 * see notes.js header) against a scratch directory: storage round-trips,
 * path-traversal rejection, and Markdown render/sanitize.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_WHISPER_CPP = join(__dirname, "fixtures/stub-whisper-cpp.mjs");
const STUB_FASTER_WHISPER = join(__dirname, "fixtures/stub-faster-whisper.mjs");

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
}

function throws(fn, code) {
  try {
    fn();
    return false;
  } catch (err) {
    return code ? err.code === code : true;
  }
}

for (const pkg of ["cli", "mcp"]) {
  console.log(`\n\x1b[1m=== ${pkg}/src/notes.js ===\x1b[0m\n`);
  const mod = await import(`../${pkg}/src/notes.js`);
  const { listNotes, readNote, saveNote, appendNote, deleteNote, searchNotes, renderNoteHtml, sanitizeNoteName } = mod;

  const dir = mkdtempSync(join(tmpdir(), "tb-notes-test-"));
  const opts = { notesDir: dir };

  console.log("Storage");
  test("listNotes starts empty", listNotes(opts).length === 0);

  const saved = saveNote("meeting-notes", "Hello **world**", { title: "Meeting Notes", source: "42", ...opts });
  test("saveNote returns name/title/path", saved.name === "meeting-notes" && saved.title === "Meeting Notes" && saved.path.startsWith(dir));

  const read1 = readNote("meeting-notes", opts);
  test("readNote round-trips body", read1.body === "Hello **world**");
  test("readNote round-trips title", read1.title === "Meeting Notes");
  test("readNote round-trips source", read1.source === "42");
  test("readNote has created timestamp", typeof read1.created === "string" && read1.created.length > 0);

  test("listNotes now has one entry", listNotes(opts).length === 1);

  saveNote("meeting-notes", "Replaced body", opts);
  test("saveNote overwrites existing note", readNote("meeting-notes", opts).body === "Replaced body");

  const appended = appendNote("meeting-notes", "More text", opts);
  test("appendNote reports created:false for existing note", appended.created === false);
  test("appendNote appends to body", readNote("meeting-notes", opts).body === "Replaced body\n\nMore text");

  const createdViaAppend = appendNote("brand-new", "First line", { title: "Brand New", ...opts });
  test("appendNote creates a missing note", createdViaAppend.created === true);
  test("appendNote-created note is readable", readNote("brand-new", opts).body === "First line");

  const results = searchNotes("replaced", opts);
  test("searchNotes finds a match by body text", results.some((r) => r.name === "meeting-notes"));
  test("searchNotes returns a snippet", results[0]?.snippet?.length > 0);
  test("searchNotes finds nothing for an absent term", searchNotes("zzz-nonexistent", opts).length === 0);

  test("deleteNote removes the note", deleteNote("brand-new", opts).deleted === true);
  test("deleteNote on missing note throws NOT_FOUND", throws(() => deleteNote("brand-new", opts), "NOT_FOUND"));
  test("readNote on missing note throws NOT_FOUND", throws(() => readNote("does-not-exist", opts), "NOT_FOUND"));

  // Plain .md file dropped in by hand (no front matter) should still read fine.
  const { writeFileSync } = await import("fs");
  writeFileSync(join(dir, "plain.md"), "Just markdown, no front matter.\n", "utf-8");
  const plain = readNote("plain", opts);
  test("readNote handles a note without front matter", plain.body.trim() === "Just markdown, no front matter." && plain.title === "plain");

  console.log("\nPath traversal rejection");
  test("rejects '..' in name", throws(() => sanitizeNoteName(".."), "INVALID_ARGS"));
  test("rejects '../escape'", throws(() => readNote("../escape", opts), "INVALID_ARGS"));
  test("rejects nested path 'a/b'", throws(() => saveNote("a/b", "x", opts), "INVALID_ARGS"));
  test("rejects backslash 'a\\\\b'", throws(() => saveNote("a\\b", "x", opts), "INVALID_ARGS"));
  test("rejects absolute-looking name", throws(() => readNote("/etc/passwd", opts), "INVALID_ARGS"));
  test("rejects embedded NUL byte", throws(() => saveNote("a\0b", "x", opts), "INVALID_ARGS"));
  test("rejects empty name", throws(() => saveNote("", "x", opts), "INVALID_ARGS"));
  test("rejects name that is only dots", throws(() => saveNote("...", "x", opts), "INVALID_ARGS"));
  test("accepts a plain safe name", sanitizeNoteName("My Note-2026_v1") === "My Note-2026_v1");
  test("no file escaped the notes dir after all rejections", listNotes(opts).every((n) => !n.name.includes("/")));

  console.log("\nMarkdown render + sanitize");
  const html = renderNoteHtml("# Title\n\nHello **world**\n\n- one\n- two\n");
  test("renders headings", html.includes("<h1>Title</h1>"));
  test("renders bold", html.includes("<strong>world</strong>"));
  test("renders lists", html.includes("<li>one</li>") && html.includes("<li>two</li>"));

  const dirty = renderNoteHtml(
    'Hi <script>alert(1)</script> [xss](javascript:alert(2)) <img src=x onerror=alert(3)> [ok](https://example.com/a)'
  );
  test("strips <script> tags", !dirty.includes("<script"));
  test("strips javascript: URLs", !dirty.includes("javascript:"));
  test("strips inline event handlers", !dirty.toLowerCase().includes("onerror"));
  test("keeps safe https links", dirty.includes('href="https://example.com/a"'));

  console.log(`\n\x1b[1m=== ${pkg}/src/stt.js ===\x1b[0m\n`);
  const { transcribeAudio, listEngines } = await import(`../${pkg}/src/stt.js`);

  const sttDir = mkdtempSync(join(tmpdir(), "tb-stt-test-"));
  const audioFile = join(sttDir, "memo.wav");
  writeFileSync(audioFile, "fake audio bytes");
  const modelFile = join(sttDir, "model.bin");
  writeFileSync(modelFile, "fake model bytes");

  const envKeys = ["PATH", "TB_WHISPER_CPP_BIN", "TB_FASTER_WHISPER_BIN", "TB_WHISPER_CPP_MODEL"];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  console.log("No engine installed");
  delete process.env.TB_WHISPER_CPP_BIN;
  delete process.env.TB_FASTER_WHISPER_BIN;
  process.env.PATH = ""; // nothing resolvable on PATH
  test("listEngines reports both engines unavailable when nothing is installed", listEngines().every((e) => !e.available));
  test(
    "throws NO_ENGINE with install hints when nothing is installed",
    throws(() => transcribeAudio(audioFile), "NO_ENGINE")
  );
  process.env.PATH = savedEnv.PATH; // restore: the stub scripts below still need `node` on PATH

  console.log("\nStubbed whisper.cpp engine");
  process.env.TB_WHISPER_CPP_BIN = STUB_WHISPER_CPP;
  test("whisper-cpp requires a model file", throws(() => transcribeAudio(audioFile, { engine: "whisper-cpp" }), "INVALID_ARGS"));
  process.env.STUB_TRANSCRIPT = "Hello from whisper.cpp\n";
  const wResult = transcribeAudio(audioFile, { model: modelFile, language: "en" });
  test("auto-detects the whisper-cpp engine", wResult.engine === "whisper-cpp");
  test("returns the trimmed transcript text", wResult.text === "Hello from whisper.cpp");
  delete process.env.STUB_TRANSCRIPT;
  delete process.env.TB_WHISPER_CPP_BIN;

  console.log("\nStubbed faster-whisper engine");
  process.env.TB_FASTER_WHISPER_BIN = STUB_FASTER_WHISPER;
  process.env.STUB_TRANSCRIPT = "Hello from faster-whisper\n";
  const fResult = transcribeAudio(audioFile, { engine: "faster-whisper" });
  test("uses the requested faster-whisper engine", fResult.engine === "faster-whisper");
  test("faster-whisper doesn't require a model file", fResult.text === "Hello from faster-whisper");
  delete process.env.STUB_TRANSCRIPT;

  console.log("\nEngine selection, failure handling and note round-trip");
  test("rejects an unknown engine id", throws(() => transcribeAudio(audioFile, { engine: "cloud-magic" }), "INVALID_ARGS"));
  test("throws NOT_FOUND for a missing audio file", throws(() => transcribeAudio(join(sttDir, "missing.wav")), "NOT_FOUND"));
  process.env.STUB_EXIT_CODE = "1";
  test(
    "wraps a failing engine as ENGINE_FAILED",
    throws(() => transcribeAudio(audioFile, { engine: "faster-whisper" }), "ENGINE_FAILED")
  );
  delete process.env.STUB_EXIT_CODE;

  const transcribed = transcribeAudio(audioFile, { engine: "faster-whisper" });
  const note = saveNote("voice-memo", transcribed.text, {
    source: "voice-memo:memo.wav",
    engine: transcribed.engine,
    ...opts,
  });
  test("transcript is saved as a note", note.name === "voice-memo");
  const readBack = readNote("voice-memo", opts);
  test("saved note body is the transcript", readBack.body === transcribed.text);
  test("saved note records the source audio file in front matter", readBack.source === "voice-memo:memo.wav");
  test("saved note records the engine used in front matter", readBack.engine === "faster-whisper");
  delete process.env.TB_FASTER_WHISPER_BIN;

  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(sttDir, { recursive: true, force: true });

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
