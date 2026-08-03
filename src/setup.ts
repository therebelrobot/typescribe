/**
 * `typescribe setup` — takes a bare executable to a working install.
 *
 * Design constraints this is built around:
 *
 *   - Nothing is fetched without the URLs and digests being printable first
 *     (`--list`) and without explicit consent (`--yes`, or an interactive
 *     confirmation).
 *   - Every download is checksum-verified where a digest could be pinned, and
 *     recorded in `installed.json` where it could not, so `--verify` can detect
 *     later tampering with the local copy.
 *   - There is a path that never touches the network on the target machine:
 *     `--bundle <dir>` on a connected machine, copy the folder, then
 *     `--from-bundle <dir>` on the air-gapped one.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { extract } from "./archive.ts";
import {
  DARWIN_INSTRUCTIONS, FFMPEG_INSTRUCTIONS, MODELS, MODEL_SIZES,
  WHISPER_CPP, WHISPER_CPP_VERSION, modelSource,
} from "./manifest.ts";
import { download, progressReporter } from "./net.ts";
import {
  managedWhisperCli, modelPath, modelsDir, readState, resolveHome,
  statePath, whisperDir, writeState, type InstalledState,
} from "./paths.ts";
import { hasCommand } from "./audio.ts";

export interface SetupOptions {
  model: string;
  dir?: string;
  yes: boolean;
  list: boolean;
  verify: boolean;
  bundle?: string;
  fromBundle?: string;
  modelSha256?: string;
  skipWhisper: boolean;
  skipModel: boolean;
}

const log = (line = "") => process.stderr.write(`${line}\n`);

export async function setup(options: SetupOptions): Promise<number> {
  const home = resolveHome(options.dir);
  const platformKey = `${process.platform}-${process.arch}`;
  const whisperSource = WHISPER_CPP[platformKey];

  if (options.list) return list(home, platformKey, options);
  if (options.verify) return verify(home);
  if (options.fromBundle) return installFromBundle(home, options);

  log(`typescribe setup`);
  log(`  install directory  ${home}`);
  log(`  platform           ${platformKey}`);
  log("");

  const plan: { label: string; url: string; sha256?: string; size: string }[] = [];
  const needWhisper = !options.skipWhisper && !managedWhisperCli(home) && !hasCommand("whisper-cli");
  const needModel = !options.skipModel && !existsSync(modelPath(home, options.model));

  if (needWhisper && whisperSource) {
    plan.push({
      label: `whisper.cpp ${WHISPER_CPP_VERSION}`,
      url: whisperSource.url,
      sha256: whisperSource.sha256,
      size: `${((whisperSource.sizeBytes ?? 0) / 1048576).toFixed(0)} MB`,
    });
  }
  if (needModel) {
    plan.push({
      label: `model ggml-${options.model}.bin`,
      url: modelSource(options.model).url,
      sha256: options.modelSha256,
      size: MODEL_SIZES[options.model] ?? "unknown",
    });
  }

  if (needWhisper && !whisperSource) {
    log(DARWIN_INSTRUCTIONS);
    log("");
    if (!needModel) return 1;
  }

  if (!plan.length) {
    log("Everything is already installed. `typescribe setup --verify` checks the digests.");
    return 0;
  }

  log("This will download:");
  log("");
  for (const item of plan) {
    log(`  ${item.label}  (${item.size})`);
    log(`    ${item.url}`);
    log(`    sha256 ${item.sha256 ?? "not pinned — will be recorded on first install (trust on first use)"}`);
  }
  log("");
  log("This is the only step that uses the network. Transcription never does.");
  log("");

  if (!options.yes && !(await confirm("Proceed?"))) {
    log("Cancelled. Nothing was downloaded.");
    return 1;
  }

  const state = readState(home);
  mkdirSync(home, { recursive: true });

  if (needWhisper && whisperSource) {
    await installWhisper(home, whisperSource, state);
  }
  if (needModel) {
    await installModel(home, options.model, options.modelSha256, state);
  }

  state.defaultModel = options.model;
  writeState(home, state);

  log("");
  reportFfmpeg();
  log("");
  log(`Done. Try:  typescribe <audio-file>`);
  log(`Verify:     typescribe setup --verify`);
  return 0;
}

async function installWhisper(
  home: string,
  source: (typeof WHISPER_CPP)[string],
  state: InstalledState,
): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), "typescribe-setup-"));
  const archivePath = join(staging, basename(new URL(source.url).pathname));

  log(`whisper.cpp ${WHISPER_CPP_VERSION}`);
  const result = await download(source.url, archivePath, {
    expectedSha256: source.sha256,
    label: "whisper.cpp",
    onProgress: progressReporter("downloading"),
  });
  log(`  checksum ok  ${result.sha256.slice(0, 16)}…`);

  const target = whisperDir(home);
  rmSync(target, { recursive: true, force: true });
  const staged = join(staging, "extracted");
  extract(archivePath, staged, source.archive === "zip" ? "zip" : "tar.gz");

  // The archives nest everything one level down; flatten so whisper-cli sits
  // directly in whisper/ and its RUNPATH ($ORIGIN) still finds the libraries.
  const inner = join(staged, dirname(source.binaryPath ?? ""));
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(inner)) {
    const from = join(inner, entry);
    if (statSync(from).isDirectory()) continue;
    const to = join(target, entry);
    copyFileSync(from, to);
    if (!/\.(dll|so[.0-9]*|dylib|txt|md)$/i.test(entry)) chmodSync(to, 0o755);
  }
  rmSync(staging, { recursive: true, force: true });

  const cli = managedWhisperCli(home);
  if (!cli) throw new Error(`Extraction finished but no whisper-cli landed in ${target}.`);
  log(`  installed    ${cli}`);

  state.whisperCli = {
    version: WHISPER_CPP_VERSION,
    url: source.url,
    sha256: result.sha256,
    path: cli,
    installedAt: new Date().toISOString(),
  };
}

async function installModel(
  home: string,
  model: string,
  pinnedSha256: string | undefined,
  state: InstalledState,
): Promise<void> {
  mkdirSync(modelsDir(home), { recursive: true });
  const destination = modelPath(home, model);
  const source = modelSource(model);

  log(`model ggml-${model}.bin`);
  const result = await download(source.url, destination, {
    expectedSha256: pinnedSha256,
    label: `ggml-${model}.bin`,
    onProgress: progressReporter("downloading"),
  });
  log(`  sha256       ${result.sha256}`);
  if (!pinnedSha256) {
    log(`  recorded for --verify; pin it on other machines with --model-sha256`);
  }
  log(`  installed    ${destination}`);

  state.models[model] = {
    version: model,
    url: source.url,
    sha256: result.sha256,
    path: destination,
    installedAt: new Date().toISOString(),
  };
}

function list(home: string, platformKey: string, options: SetupOptions): number {
  const whisper = WHISPER_CPP[platformKey];
  log(`typescribe setup --list`);
  log(`  install directory  ${home}`);
  log(`  platform           ${platformKey}`);
  log("");
  log("Sources this build is pinned to. Nothing has been downloaded.");
  log("");
  if (whisper) {
    log(`  whisper.cpp ${WHISPER_CPP_VERSION}`);
    log(`    url     ${whisper.url}`);
    log(`    sha256  ${whisper.sha256}`);
  } else {
    log(`  whisper.cpp — no prebuilt binary published for ${platformKey}`);
  }
  log("");
  log(`  model ggml-${options.model}.bin  (${MODEL_SIZES[options.model] ?? "unknown size"})`);
  log(`    url     ${modelSource(options.model).url}`);
  log(`    sha256  not pinned (trust on first use — see --model-sha256)`);
  log("");
  log(`Available models: ${MODELS.join(", ")}`);
  log("");
  log(`ffmpeg is not fetched. whisper-cli decodes wav, mp3, ogg, and flac itself;`);
  log(`ffmpeg is only needed for m4a, aac, opus, and video containers:`);
  log(`  ${FFMPEG_INSTRUCTIONS[process.platform] ?? "install ffmpeg from your package manager"}`);
  return 0;
}

function verify(home: string): number {
  const state = readState(home);
  let failures = 0;

  log(`typescribe setup --verify`);
  log(`  install directory  ${home}`);
  log("");

  const entries: [string, { path: string; sha256?: string }][] = [];
  if (state.whisperCli) entries.push(["whisper.cpp", state.whisperCli]);
  for (const [name, model] of Object.entries(state.models)) entries.push([`model ${name}`, model]);

  if (!entries.length) {
    log("Nothing recorded in installed.json. Run `typescribe setup` first.");
    return 1;
  }

  for (const [label, component] of entries) {
    if (!existsSync(component.path)) {
      log(`  MISSING  ${label}  ${component.path}`);
      failures++;
      continue;
    }
    // whisper.cpp's recorded digest is of the archive, not the extracted
    // binary, so only file-per-component entries can be re-hashed.
    if (label.startsWith("model ") && component.sha256) {
      const actual = createHash("sha256").update(readFileSync(component.path)).digest("hex");
      if (actual === component.sha256) {
        log(`  ok       ${label}  ${actual.slice(0, 16)}…`);
      } else {
        log(`  CHANGED  ${label}`);
        log(`             recorded ${component.sha256}`);
        log(`             on disk  ${actual}`);
        failures++;
      }
    } else {
      log(`  present  ${label}  ${component.path}`);
    }
  }

  log("");
  log(failures ? `${failures} problem(s). Re-run \`typescribe setup\`.` : "All recorded components verified.");
  return failures ? 1 : 0;
}

/** Copies an existing install into a folder that can be moved by hand. */
function makeBundle(home: string, target: string): number {
  const state = readState(home);
  if (!state.whisperCli && !Object.keys(state.models).length) {
    log("Nothing installed to bundle. Run `typescribe setup` on this machine first.");
    return 1;
  }
  mkdirSync(target, { recursive: true });
  copyTree(whisperDir(home), join(target, "whisper"));
  copyTree(modelsDir(home), join(target, "models"));
  if (existsSync(statePath(home))) copyFileSync(statePath(home), join(target, "installed.json"));

  log(`Bundle written to ${target}`);
  log("");
  log("Copy that folder to the offline machine alongside the executable, then:");
  log(`  typescribe setup --from-bundle <path-to-folder>`);
  return 0;
}

function installFromBundle(home: string, options: SetupOptions): number {
  const bundle = resolve(options.fromBundle!);
  if (!existsSync(bundle)) {
    log(`Bundle not found: ${bundle}`);
    return 1;
  }
  mkdirSync(home, { recursive: true });
  copyTree(join(bundle, "whisper"), whisperDir(home));
  copyTree(join(bundle, "models"), modelsDir(home));
  const bundledState = join(bundle, "installed.json");
  if (existsSync(bundledState)) copyFileSync(bundledState, statePath(home));

  // Recorded paths came from the machine that built the bundle.
  const state = readState(home);
  const cli = managedWhisperCli(home);
  if (state.whisperCli && cli) state.whisperCli.path = cli;
  for (const [name, model] of Object.entries(state.models)) {
    model.path = modelPath(home, name);
  }
  writeState(home, state);

  if (cli) chmodSync(cli, 0o755);
  log(`Installed from bundle into ${home}`);
  log(`No network was used. Verify with: typescribe setup --verify`);
  return 0;
}

function copyTree(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const destination = join(to, entry);
    if (statSync(source).isDirectory()) copyTree(source, destination);
    else copyFileSync(source, destination);
  }
}

function reportFfmpeg(): void {
  if (hasCommand("ffmpeg")) {
    log("ffmpeg: present.");
    return;
  }
  log("ffmpeg: not found — optional.");
  log("  whisper-cli decodes wav, mp3, ogg, and flac on its own. ffmpeg is only");
  log("  needed for m4a, aac, opus, and video containers. To add it:");
  log(`    ${FFMPEG_INSTRUCTIONS[process.platform] ?? "install ffmpeg from your package manager"}`);
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    log(`(not a terminal — pass --yes to proceed without a prompt)`);
    return Promise.resolve(false);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveAnswer) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export { makeBundle };
