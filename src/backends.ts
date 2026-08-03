/**
 * Local speech-to-text backends. Everything runs on the machine; nothing in
 * this file makes a network call.
 *
 *   whisper-cpp  ->  `whisper-cli` (or legacy `main`) from ggml-org/whisper.cpp
 *                    `-oj -ojf` gives per-token timestamps, which is what makes
 *                    word-level typing timing possible.
 *   whisper      ->  the `whisper` CLI from openai-whisper, faster-whisper-cli,
 *                    or whisperx, all of which write a compatible JSON.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hasCommand, prepareForWhisperCpp } from "./audio.ts";

export type BackendName = "whisper-cpp" | "whisper";

export interface BackendOptions {
  backend: BackendName | "auto";
  /** whisper.cpp: path to a `.bin` model. whisper: a size name like `base.en`. */
  model: string;
  whisperBin?: string;
  /** Where the Python backend looks for already-downloaded weights. */
  modelDir?: string;
  language: string;
  threads?: number;
  /**
   * Off by default. When false, the child process is spawned with every
   * model-fetch path forced offline and a preflight check refuses to run
   * unless the weights are already on disk.
   */
  allowModelDownload: boolean;
  verbose: boolean;
}

/**
 * Environment forced onto every spawned backend when downloads are not allowed.
 *
 * whisper.cpp has no downloader at all, so this only matters for the Python
 * backends: openai-whisper fetches from an Azure CDN, faster-whisper and
 * whisperx from the Hugging Face hub, and whisperx additionally pulls VAD and
 * alignment models. Each honours a different variable, so all of them get set.
 */
function offlineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    // torch.hub and whisper's own loader both respect these caches; pointing
    // them at the resolved model dir keeps lookups local.
    NO_PROXY: "*",
    no_proxy: "*",
  };
}

/** Default weight cache used by openai-whisper when `--model_dir` is absent. */
export function defaultPythonModelDir(): string {
  return join(homedir(), ".cache", "whisper");
}

const WHISPER_CPP_BINARIES = ["whisper-cli", "whisper-cpp", "main"];

export function resolveBackend(options: BackendOptions): {
  name: BackendName;
  binary: string;
} {
  if (options.whisperBin) {
    const name: BackendName =
      options.backend === "auto"
        ? /whisper-cli|whisper-cpp|(^|\/)main$/.test(options.whisperBin)
          ? "whisper-cpp"
          : "whisper"
        : options.backend;
    return { name, binary: options.whisperBin };
  }

  if (options.backend === "whisper-cpp" || options.backend === "auto") {
    for (const candidate of WHISPER_CPP_BINARIES) {
      if (hasCommand(candidate)) return { name: "whisper-cpp", binary: candidate };
    }
    if (options.backend === "whisper-cpp") {
      throw new Error(
        `No whisper.cpp binary found on PATH (looked for: ${WHISPER_CPP_BINARIES.join(", ")}).\n` +
          `Pass --whisper-bin /path/to/whisper-cli, or build it:\n` +
          `  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j`,
      );
    }
  }

  if (options.backend === "whisper" || options.backend === "auto") {
    if (hasCommand("whisper")) return { name: "whisper", binary: "whisper" };
    if (options.backend === "whisper") {
      throw new Error(
        `\`whisper\` was not found on PATH.\nInstall one of:\n` +
          `  pipx install openai-whisper\n  pipx install faster-whisper-cli\n  pipx install whisperx`,
      );
    }
  }

  throw new Error(
    `No local speech-to-text backend found.\nInstall one:\n` +
      `  whisper.cpp   https://github.com/ggml-org/whisper.cpp   (fastest on Apple Silicon and CPU)\n` +
      `  openai-whisper  pipx install openai-whisper\n` +
      `Or skip transcription entirely with --transcript <file.json|.srt|.vtt>.`,
  );
}

/** Runs the backend and returns the raw transcript text it produced. */
export function transcribe(audioFile: string, options: BackendOptions): {
  raw: string;
  backend: BackendName;
} {
  const { name, binary } = resolveBackend(options);
  if (options.verbose) {
    process.stderr.write(`[typescribe] backend: ${name} (${binary})\n`);
  }

  return name === "whisper-cpp"
    ? { raw: runWhisperCpp(audioFile, binary, options), backend: name }
    : { raw: runWhisperPython(audioFile, binary, options), backend: name };
}

function runWhisperCpp(
  audioFile: string,
  binary: string,
  options: BackendOptions,
): string {
  if (!options.model || !existsSync(options.model)) {
    throw new Error(
      `whisper.cpp needs a model file. Pass --model /path/to/ggml-base.en.bin.\n` +
        `Download one:\n  bash models/download-ggml-model.sh base.en   (inside the whisper.cpp checkout)`,
    );
  }

  const prepared = prepareForWhisperCpp(audioFile);
  const outDir = mkdtempSync(join(tmpdir(), "typescribe-cpp-"));
  const outPrefix = join(outDir, "transcript");

  const args = [
    "-m", options.model,
    "-f", prepared.path,
    "-l", options.language,
    "-oj",   // JSON output
    "-ojf",  // full JSON: includes per-token timestamps
    "-of", outPrefix,
    "-np",   // no progress prints
  ];
  if (options.threads) args.push("-t", String(options.threads));

  if (options.verbose) {
    process.stderr.write(`[typescribe] ${binary} ${args.join(" ")}\n`);
  }

  const result = spawnSync(binary, args, {
    stdio: ["ignore", options.verbose ? "inherit" : "ignore", "pipe"],
    encoding: "utf8",
    env: options.allowModelDownload ? process.env : offlineEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`${binary} exited with code ${result.status}:\n${result.stderr?.trim()}`);
  }

  const jsonPath = `${outPrefix}.json`;
  if (!existsSync(jsonPath)) {
    throw new Error(
      `${binary} ran but produced no JSON at ${jsonPath}. ` +
        `Older whisper.cpp builds spell the flag --output-json-full; check \`${binary} --help\`.`,
    );
  }
  return readFileSync(jsonPath, "utf8");
}

/**
 * The Python backends resolve a model *name* to weights and will fetch them if
 * they are absent. Confirm the weights are already on disk before spawning,
 * so an offline machine fails with an actionable message instead of a network
 * timeout buried in a Python traceback.
 */
function assertPythonWeightsPresent(model: string, modelDir: string): void {
  // openai-whisper layout.
  if (existsSync(join(modelDir, `${model}.pt`))) return;
  // faster-whisper / whisperx layout (Hugging Face hub cache).
  const hubCache = join(homedir(), ".cache", "huggingface", "hub");
  if (existsSync(hubCache)) {
    const match = readdirSync(hubCache).some(
      (entry) => entry.startsWith("models--") && entry.includes(model.replace(/\./g, "-")),
    );
    if (match) return;
  }
  // A directory the user pointed at that has *some* weights in it.
  if (existsSync(modelDir) && readdirSync(modelDir).some((f) => /\.(pt|bin|safetensors)$/.test(f))) {
    return;
  }

  throw new Error(
    `No local weights found for model "${model}".\n` +
      `Looked in: ${join(modelDir, `${model}.pt`)}\n` +
      `           ${hubCache}\n\n` +
      `typescribe will not download models, so this run would need network access.\n` +
      `Fix it one of these ways:\n` +
      `  1. Point at weights you already have:  --model-dir /path/to/weights\n` +
      `  2. Fetch them once on a connected machine:  --allow-model-download\n` +
      `  3. Use whisper.cpp instead, which takes an explicit file path and has\n` +
      `     no downloader at all:  --backend whisper-cpp --model /path/ggml-${model}.bin`,
  );
}

function runWhisperPython(
  audioFile: string,
  binary: string,
  options: BackendOptions,
): string {
  const model = options.model || "base.en";
  const modelDir = options.modelDir ?? defaultPythonModelDir();
  if (!options.allowModelDownload) {
    assertPythonWeightsPresent(model, modelDir);
  }

  const outDir = mkdtempSync(join(tmpdir(), "typescribe-py-"));
  const args = [
    audioFile,
    "--model", model,
    "--model_dir", modelDir,
    "--language", options.language,
    "--task", "transcribe",
    "--word_timestamps", "True",
    "--output_format", "json",
    "--output_dir", outDir,
  ];
  if (options.threads) args.push("--threads", String(options.threads));

  if (options.verbose) {
    process.stderr.write(`[typescribe] ${binary} ${args.join(" ")}\n`);
    process.stderr.write(
      `[typescribe] model dir: ${modelDir}${options.allowModelDownload ? " (downloads allowed)" : " (offline)"}\n`,
    );
  }

  const result = spawnSync(binary, args, {
    stdio: ["ignore", options.verbose ? "inherit" : "ignore", "pipe"],
    encoding: "utf8",
    env: options.allowModelDownload ? process.env : offlineEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`${binary} exited with code ${result.status}:\n${result.stderr?.trim()}`);
  }

  const expected = join(outDir, `${basename(audioFile).replace(/\.[^.]+$/, "")}.json`);
  if (existsSync(expected)) return readFileSync(expected, "utf8");

  const fallback = readdirSync(outDir).find((file) => file.endsWith(".json"));
  if (!fallback) {
    throw new Error(`${binary} ran but wrote no JSON into ${outDir}.`);
  }
  return readFileSync(join(outDir, fallback), "utf8");
}
