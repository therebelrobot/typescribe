/**
 * Where setup puts things, and how a run finds them again.
 *
 * Resolution is portable-first: if the directory holding the executable is
 * writable, components land next to it, so the executable plus its data folder
 * can be copied to a USB stick or an air-gapped machine as a unit. Otherwise
 * they go to the platform's user data directory.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface InstalledComponent {
  version: string;
  url?: string;
  sha256?: string;
  path: string;
  installedAt: string;
}

export interface InstalledState {
  whisperCli?: InstalledComponent;
  models: Record<string, InstalledComponent>;
  defaultModel?: string;
}

const EMPTY: InstalledState = { models: {} };

export function resolveHome(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env["TYPESCRIBE_HOME"]) return resolve(process.env["TYPESCRIBE_HOME"]);

  // Portable mode: alongside the executable, when that location is writable.
  // process.execPath is the executable itself in a SEA build, and the node
  // binary when running from source — only the former should trigger portable
  // mode, which `process.argv[1] === undefined` distinguishes for a SEA build.
  const isSea = !process.argv[1] || process.argv[1] === process.execPath;
  if (isSea) {
    const beside = join(dirname(process.execPath), "typescribe-data");
    if (isWritable(dirname(process.execPath))) return beside;
  }

  return userDataDir();
}

function userDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "typescribe");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "typescribe");
  }
  const base = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  return join(base, "typescribe");
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function whisperDir(home: string): string {
  return join(home, "whisper");
}
export function modelsDir(home: string): string {
  return join(home, "models");
}
export function modelPath(home: string, model: string): string {
  return join(modelsDir(home), `ggml-${model}.bin`);
}
export function statePath(home: string): string {
  return join(home, "installed.json");
}

export function readState(home: string): InstalledState {
  const file = statePath(home);
  if (!existsSync(file)) return { ...EMPTY, models: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<InstalledState>;
    return { ...parsed, models: parsed.models ?? {} };
  } catch {
    return { ...EMPTY, models: {} };
  }
}

export function writeState(home: string, state: InstalledState): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath(home), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** The managed whisper-cli, if setup has installed one. */
export function managedWhisperCli(home: string): string | null {
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const candidate = join(whisperDir(home), name);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Turns whatever `--model` was given into a file path.
 * An existing path wins; otherwise a bare name resolves against the managed
 * models directory, so `--model base.en` works after setup.
 */
export function resolveModelPath(home: string, model: string | undefined): string | null {
  if (model && existsSync(model)) return resolve(model);
  if (model) {
    const managed = modelPath(home, model.replace(/^ggml-/, "").replace(/\.bin$/, ""));
    if (existsSync(managed)) return managed;
    return null;
  }
  const state = readState(home);
  if (state.defaultModel) {
    const managed = modelPath(home, state.defaultModel);
    if (existsSync(managed)) return managed;
  }
  return null;
}
