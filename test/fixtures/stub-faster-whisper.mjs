#!/usr/bin/env node
/**
 * Stub faster-whisper (whisper-ctranslate2) CLI for tests (see test/notes-test.mjs and
 * test/mcp-test.mjs).
 *
 * Mimics just enough of `whisper-ctranslate2 <audio> --output_format txt --output_dir <dir>`
 * to exercise cli/mcp's stt.js: writes `<dir>/<audio-basename>.txt` with STUB_TRANSCRIPT (or
 * exits non-zero when STUB_EXIT_CODE is set, to exercise the ENGINE_FAILED path).
 */
import { writeFileSync } from "fs";
import { basename, extname, join } from "path";

if (process.env.STUB_EXIT_CODE) {
  process.stderr.write(process.env.STUB_STDERR || "stub faster-whisper failure\n");
  process.exit(Number(process.env.STUB_EXIT_CODE));
}

const args = process.argv.slice(2);
const audioFile = args[0];
const outDir = args[args.indexOf("--output_dir") + 1];
const base = basename(audioFile, extname(audioFile));
writeFileSync(join(outDir, `${base}.txt`), process.env.STUB_TRANSCRIPT ?? "stub transcript\n", "utf-8");
