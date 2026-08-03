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
import { hasCommand, isWhisperReadyWav, prepareForWhisperCpp } from "./audio.ts";
import { managedWhisperCli, resolveModelPath } from "./paths.ts";

export type BackendName = "whisper-cpp" | "whisper";

export interface BackendOptions {
  backend: BackendName | "auto";
  /**
   * whisper.cpp: a model name resolved against the install directory, or a
   * file path. whisper: a size name. Undefined means "whatever setup installed".
   */
  model?: string;
  whisperBin?: string;
  /** Where the Python backend looks for already-downloaded weights. */
  modelDir?: string;
  /** typescribe install directory, searched before PATH. */
  home: string;
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
    // A `typescribe setup` install wins over whatever is on PATH, so the
    // executable behaves the same whether or not the host has its own build.
    const managed = managedWhisperCli(options.home);
    if (managed) return { name: "whisper-cpp", binary: managed };

    for (const candidate of WHISPER_CPP_BINARIES) {
      if (hasCommand(candidate)) return { name: "whisper-cpp", binary: candidate };
    }
    if (options.backend === "whisper-cpp") {
      throw new Error(
        `No whisper.cpp binary found.\n` +
          `  Looked in: ${options.home}/whisper, then PATH (${WHISPER_CPP_BINARIES.join(", ")})\n\n` +
          `Install it with:  typescribe setup\n` +
          `Or point at your own:  --whisper-bin /path/to/whisper-cli`,
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
    `No local speech-to-text backend found.\n\n` +
      `Run:  typescribe setup\n` +
      `That fetches whisper.cpp and a model into ${options.home}. It is the only\n` +
      `step that needs the network; transcription afterwards is fully offline.\n\n` +
      `Alternatives:\n` +
      `  typescribe setup --list          see exactly what it would download\n` +
      `  --whisper-bin <path>             use a whisper.cpp build you already have\n` +
      `  --transcript <file>              skip speech-to-text entirely`,
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
  const model = resolveModelPath(options.home, options.model);
  if (!model) {
    throw new Error(
      `No Whisper model found.\n` +
        `  Looked for: ${options.model || "(the default recorded by setup)"}\n` +
        `  In:         ${options.home}/models\n\n` +
        `Install one with:  typescribe setup --model base.en\n` +
        `Or pass a path:    --model /path/to/ggml-base.en.bin`,
    );
  }

  // whisper-cli 1.9+ decodes several compressed formats itself; converting
  // those through ffmpeg first would be a pointless round trip, and would make
  // ffmpeg a hard requirement it no longer is.
  const prepared = whisperCliHandles(binary, audioFile)
    ? { path: audioFile, temporary: false }
    : prepareForWhisperCpp(audioFile);
  const outDir = mkdtempSync(join(tmpdir(), "typescribe-cpp-"));
  const outPrefix = join(outDir, "transcript");

  const args = [
    "-m", model,
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

/**
 * Asks whisper-cli which container formats it can decode.
 *
 * v1.9 prints `supported audio formats: flac, mp3, ogg, wav` in its usage text.
 * Older builds print nothing of the kind and only handle 16 kHz mono WAV, so an
 * absent line is treated as "WAV only" and the ffmpeg path is used.
 */
const formatCache = new Map<string, Set<string>>();

export function whisperCliFormats(binary: string): Set<string> {
  const cached = formatCache.get(binary);
  if (cached) return cached;

  const result = spawnSync(binary, ["--help"], { encoding: "utf8", timeout: 15_000 });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const line = text.split("\n").find((l) => /supported audio formats:/i.test(l));
  const formats = new Set<string>(
    line
      ? line.split(":")[1]!.split(",").map((f) => f.trim().toLowerCase()).filter(Boolean)
      : ["wav"],
  );
  formatCache.set(binary, formats);
  return formats;
}

function whisperCliHandles(binary: string, audioFile: string): boolean {
  const extension = audioFile.split(".").pop()?.toLowerCase() ?? "";
  if (!extension) return false;
  const formats = whisperCliFormats(binary);
  // WAV still goes through the converter unless it is already 16 kHz mono:
  // whisper-cli accepts other WAV shapes but resamples less carefully.
  if (extension === "wav") return isWhisperReadyWav(audioFile);
  return formats.has(extension);
}
