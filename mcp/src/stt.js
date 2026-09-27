/**
 * Local speech-to-text for voice memo transcription.
 *
 * Local-first by design: every engine here shells out to a binary the user
 * installs themselves and runs entirely on their machine. No audio or text
 * ever leaves the machine, no network call is made, and no API key is read
 * or required. A cloud STT provider is a separate vendor/stack decision and
 * is intentionally not implemented here (see the ODIAA-2331 PR description
 * for the option A vs B trade-off).
 *
 * Engines are detected at runtime (env var override, then well-known PATH
 * binary names) so the CLI works whether the user has whisper.cpp,
 * faster-whisper, both, or neither installed — absence produces a clean
 * error with an install hint rather than a stack trace.
 *
 * Self-contained copy of cli/src/stt.js, so the mcp package has no runtime
 * dependency on the cli package (see notes.js). Keep in sync.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, delimiter, extname, join, resolve } from "path";

function invalidArgs(message) {
  return Object.assign(new Error(`INVALID_ARGS: ${message}`), { code: "INVALID_ARGS" });
}

// Default cap on how long an engine may run before we give up and kill it —
// guards against a hung or runaway process rather than any expectation of
// how long real transcription takes.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function which(names) {
  const dirs = (process.env.PATH || "").split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const ENGINES = [
  {
    id: "whisper-cpp",
    label: "whisper.cpp",
    resolveBin: () => process.env.TB_WHISPER_CPP_BIN || which(["whisper-cli", "whisper-cpp"]),
    installHint:
      "whisper.cpp: install it (https://github.com/ggml-org/whisper.cpp), put `whisper-cli` on PATH " +
      "or set TB_WHISPER_CPP_BIN to its path, and pass --model (or set TB_WHISPER_CPP_MODEL) to a " +
      "downloaded ggml model file.",
    transcribe(bin, audioFile, outDir, opts) {
      const model = opts.model || process.env.TB_WHISPER_CPP_MODEL;
      if (!model) throw invalidArgs("whisper.cpp requires a model file: pass --model or set TB_WHISPER_CPP_MODEL");
      if (!existsSync(model)) throw invalidArgs(`model file not found: ${model}`);
      const outPrefix = join(outDir, "transcript");
      const args = ["-m", model, "-f", audioFile, "-otxt", "-of", outPrefix, "-nt"];
      if (opts.language) args.push("-l", opts.language);
      execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      return readFileSync(`${outPrefix}.txt`, "utf-8");
    },
  },
  {
    id: "faster-whisper",
    label: "faster-whisper",
    resolveBin: () => process.env.TB_FASTER_WHISPER_BIN || which(["whisper-ctranslate2"]),
    installHint:
      "faster-whisper: `pip install whisper-ctranslate2` (its CLI wrapper), ensure `whisper-ctranslate2` " +
      "is on PATH, or set TB_FASTER_WHISPER_BIN to its path.",
    transcribe(bin, audioFile, outDir, opts) {
      const args = [audioFile, "--output_format", "txt", "--output_dir", outDir];
      if (opts.model) args.push("--model", opts.model);
      if (opts.language) args.push("--language", opts.language);
      execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      const base = basename(audioFile, extname(audioFile));
      return readFileSync(join(outDir, `${base}.txt`), "utf-8");
    },
  },
];

export function listEngines() {
  return ENGINES.map((e) => ({ id: e.id, label: e.label, available: Boolean(e.resolveBin()) }));
}

function resolveEngine(preferredId) {
  const candidates = preferredId ? ENGINES.filter((e) => e.id === preferredId) : ENGINES;
  if (preferredId && candidates.length === 0) {
    throw invalidArgs(`unknown engine '${preferredId}'; expected one of: ${ENGINES.map((e) => e.id).join(", ")}`);
  }
  for (const engine of candidates) {
    const bin = engine.resolveBin();
    if (bin) return { engine, bin };
  }
  const hints = candidates.map((e) => `  - ${e.installHint}`).join("\n");
  throw Object.assign(
    new Error(
      "NO_ENGINE: no local speech-to-text engine found.\n" +
        `${hints}\n` +
        "Cloud speech-to-text is not supported here (local-first by design) — no audio ever leaves this machine."
    ),
    { code: "NO_ENGINE" }
  );
}

export function transcribeAudio(audioFile, opts = {}) {
  if (typeof audioFile !== "string" || !audioFile.trim()) throw invalidArgs("audio file path is required");
  const resolvedAudio = resolve(audioFile);
  if (!existsSync(resolvedAudio)) {
    throw Object.assign(new Error(`NOT_FOUND: audio file '${audioFile}' does not exist`), { code: "NOT_FOUND" });
  }

  const { engine, bin } = resolveEngine(opts.engine);
  const outDir = mkdtempSync(join(tmpdir(), "tb-transcribe-"));
  try {
    const text = engine.transcribe(bin, resolvedAudio, outDir, opts).trim();
    return { text, engine: engine.id, audioFile: resolvedAudio };
  } catch (err) {
    if (err.code === "INVALID_ARGS" || err.code === "NOT_FOUND") throw err;
    const detail = err.stderr ? String(err.stderr).slice(0, 2000).trim() : err.message;
    throw Object.assign(new Error(`ENGINE_FAILED: ${engine.label} failed: ${detail}`), { code: "ENGINE_FAILED" });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
