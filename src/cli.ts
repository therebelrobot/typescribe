#!/usr/bin/env node
/**
 * typescribe — audio file in, .docx out, where the document's tracked-change
 * history reproduces the transcript arriving in time with the recording.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { HELP, parseArgs, type CliOptions } from "./args.ts";
import { hasCommand, probeDuration } from "./audio.ts";
import { defaultPythonModelDir, resolveBackend, transcribe } from "./backends.ts";
import { parseTranscript, type Transcript } from "./transcript.ts";
import { buildTypingPlan, formatClock, type TypingPlan } from "./typing.ts";
import { buildDocx } from "./docx/build.ts";

const VERSION = "0.1.0";
const GENERATOR = `typescribe ${VERSION}`;

function main(argv: string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${message(error)}\n\nRun typescribe --help for usage.\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.check) {
    return doctor(options);
  }
  if (!options.input && !options.transcript) {
    process.stderr.write(
      "No input. Pass an audio file, or --transcript <file> to skip speech-to-text.\n\n" + HELP,
    );
    return 2;
  }

  try {
    return run(options);
  } catch (error) {
    process.stderr.write(`${message(error)}\n`);
    return 1;
  }
}

function run(options: CliOptions): number {
  const audioPath = options.input ? resolve(options.input) : undefined;
  if (audioPath && !existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  // 1. Get a transcript.
  let transcript: Transcript;
  let rawTranscript: string;

  if (options.transcript) {
    const transcriptPath = resolve(options.transcript);
    if (!existsSync(transcriptPath)) {
      throw new Error(`Transcript file not found: ${transcriptPath}`);
    }
    rawTranscript = readFileSync(transcriptPath, "utf8");
    transcript = parseTranscript(rawTranscript, basename(transcriptPath));
  } else {
    const started = Date.now();
    const result = transcribe(audioPath!, {
      backend: options.backend,
      model: options.model,
      whisperBin: options.whisperBin,
      modelDir: options.modelDir,
      language: options.language,
      threads: options.threads,
      allowModelDownload: options.allowModelDownload,
      verbose: options.verbose,
    });
    rawTranscript = result.raw;
    transcript = parseTranscript(rawTranscript, result.backend);
    if (options.verbose) {
      log(`transcription took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }

  if (!transcript.words.length) {
    throw new Error(
      "The transcript contained no words. If the recording is quiet or non-English, try a larger model or --language <code>.",
    );
  }

  // 2. Establish the wall clock. A recording's mtime is when it finished being
  //    written, so t=0 sits one duration earlier.
  const mediaDuration = audioPath ? probeDuration(audioPath) : null;
  // A transcript can never outrun its audio, so if it does, the probe is the
  // number to distrust.
  const duration = Math.max(mediaDuration ?? 0, transcript.duration);
  const sessionStart = options.start ?? defaultStart(audioPath, duration);

  // 3. Plan the typing.
  const plan = buildTypingPlan(
    { ...transcript, duration },
    {
      lag: options.lag,
      wpm: options.wpm,
      chunkMode: options.chunkMode,
      maxChunkWords: options.maxChunkWords,
      pauseGap: options.pauseGap,
      paragraphGap: options.paragraphGap,
      maxBacklog: options.maxBacklog,
      sessionStart,
    },
  );

  if (options.jsonPlan) {
    writeFileSync(resolve(options.jsonPlan), JSON.stringify(plan, null, 2), "utf8");
    log(`wrote typing plan: ${resolve(options.jsonPlan)}`);
  }

  if (options.dryRun) {
    printPlan(plan, options);
    return 0;
  }

  // 4. Emit the document.
  const outPath = resolve(
    options.out ??
      (audioPath
        ? `${basename(audioPath, extname(audioPath))}.docx`
        : "transcript.docx"),
  );
  const title =
    options.title ??
    (audioPath ? `Transcript — ${basename(audioPath)}` : "Live transcript");

  const buffer = buildDocx(plan, {
    title,
    author: options.author,
    timestamps: options.timestamps,
    generator: GENERATOR,
  });
  writeFileSync(outPath, buffer);

  if (options.keepTranscript) {
    const sidecar = outPath.replace(/\.docx$/i, "") + ".transcript.json";
    writeFileSync(sidecar, rawTranscript, "utf8");
    log(`wrote transcript: ${sidecar}`);
  }

  printSummary(plan, outPath, options);
  return 0;
}

/**
 * Reports whether a transcription run on this machine would need the network.
 * Touches nothing and transcribes nothing.
 */
function doctor(options: CliOptions): number {
  const problems: string[] = [];
  const ok = (label: string, detail: string) => log(`  ok    ${label.padEnd(14)} ${detail}`);
  const bad = (label: string, detail: string) => {
    log(`  MISS  ${label.padEnd(14)} ${detail}`);
    problems.push(label);
  };

  log("typescribe offline check");
  log("");

  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 6)) {
    ok("node", `${process.versions.node} (type stripping available)`);
  } else {
    bad("node", `${process.versions.node} — 22.6+ needed for --experimental-strip-types`);
  }

  let backend: { name: string; binary: string } | null = null;
  try {
    backend = resolveBackend({
      backend: options.backend,
      model: options.model,
      whisperBin: options.whisperBin,
      modelDir: options.modelDir,
      language: options.language,
      threads: options.threads,
      allowModelDownload: options.allowModelDownload,
      verbose: false,
    });
    ok("backend", `${backend.name} (${backend.binary})`);
  } catch {
    bad("backend", "no whisper.cpp or whisper CLI on PATH");
  }

  if (backend?.name === "whisper-cpp") {
    if (options.model && existsSync(options.model)) {
      ok("model", `${resolve(options.model)}`);
    } else {
      bad("model", `not found: ${options.model || "(none given)"} — pass --model /path/ggml-*.bin`);
    }
  } else if (backend?.name === "whisper") {
    const dir = options.modelDir ?? defaultPythonModelDir();
    const weights = join(dir, `${options.model}.pt`);
    if (existsSync(weights)) {
      ok("model", weights);
    } else {
      bad("model", `${weights} absent — this run would try to download`);
    }
  }

  if (hasCommand("ffmpeg")) {
    ok("ffmpeg", "present (needed for non-16kHz-mono input)");
  } else {
    log("  note  ffmpeg        absent — only 16 kHz mono WAV input will work");
  }
  if (hasCommand("ffprobe")) {
    ok("ffprobe", "present (used for the session clock)");
  } else {
    log("  note  ffprobe       absent — session clock falls back to transcript length");
  }

  log("");
  if (problems.length) {
    log(`Not ready: ${problems.join(", ")}. Fix these while connected; afterwards no network is needed.`);
    return 1;
  }
  log("Ready. A transcription run on this machine needs no network access.");
  return 0;
}

function defaultStart(audioPath: string | undefined, duration: number): Date {
  const anchor = audioPath ? statSync(audioPath).mtime : new Date();
  return new Date(anchor.getTime() - duration * 1000);
}

function printSummary(plan: TypingPlan, outPath: string, options: CliOptions): void {
  const revisions =
    plan.paragraphs.reduce((sum, p) => sum + p.chunks.length, 0) +
    Math.max(0, plan.paragraphs.length - 1) +
    (options.timestamps ? plan.paragraphs.length : 0);

  log(`wrote ${outPath}`);
  log(`  audio        ${formatClock(plan.audioDuration)}`);
  log(`  words        ${plan.wordCount} in ${plan.paragraphs.length} paragraph(s)`);
  log(`  revisions    ${revisions} tracked insertions, author "${options.author}"`);
  log(`  session      ${plan.sessionStart.toISOString()} -> ${plan.sessionEnd.toISOString()}`);
  log(`  max backlog  ${plan.maxBacklog.toFixed(1)}s behind the audio`);
  if (options.maxBacklog !== null && plan.maxBacklog >= options.maxBacklog - 0.01) {
    log(`  note         backlog is hitting the --max-backlog ceiling; raise --wpm,`);
    log(`               use --chunk sentence, or pass --max-backlog off`);
  }
}

function printPlan(plan: TypingPlan, options: CliOptions): void {
  for (const [index, paragraph] of plan.paragraphs.entries()) {
    log(`¶${index + 1}  audio ${formatClock(paragraph.audioStart)}–${formatClock(paragraph.audioEnd)}`);
    for (const chunk of paragraph.chunks) {
      log(
        `    ${chunk.typedAt.toISOString().slice(11, 19)}  ` +
          `(+${chunk.backlog.toFixed(1)}s)  ${JSON.stringify(chunk.text)}`,
      );
    }
  }
  log("");
  log(`dry run: nothing written. ${plan.wordCount} words, max backlog ${plan.maxBacklog.toFixed(1)}s.`);
  if (!options.verbose) log(`add -v to see backend commands.`);
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.exit(main(process.argv.slice(2)));
