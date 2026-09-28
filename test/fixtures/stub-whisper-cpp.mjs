#!/usr/bin/env node
/**
 * Stub whisper.cpp CLI for tests (see test/notes-test.mjs and test/mcp-test.mjs).
 *
 * Mimics just enough of `whisper-cli -m <model> -f <audio> -otxt -of <prefix> -nt [-l <lang>]`
 * to exercise cli/mcp's stt.js: writes `<prefix>.txt` with STUB_TRANSCRIPT (or exits non-zero
 * when STUB_EXIT_CODE is set, to exercise the ENGINE_FAILED path).
 */
import { writeFileSync } from "fs";

if (process.env.STUB_EXIT_CODE) {
  process.stderr.write(process.env.STUB_STDERR || "stub whisper.cpp failure\n");
  process.exit(Number(process.env.STUB_EXIT_CODE));
}

const args = process.argv.slice(2);
const prefix = args[args.indexOf("-of") + 1];
writeFileSync(`${prefix}.txt`, process.env.STUB_TRANSCRIPT ?? "stub transcript\n", "utf-8");
