/**
 * ffmpeg/ffprobe wrappers.
 *
 * whisper.cpp only reads 16 kHz mono 16-bit WAV, so anything else gets
 * converted to a temp file first. ffmpeg is optional if the input is already
 * in that format and no duration probe is needed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function hasCommand(command: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

/** Seconds, or null when ffprobe is unavailable or the file is unreadable. */
export function probeDuration(file: string): number | null {
  if (!hasCommand("ffprobe")) return null;
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const seconds = Number(result.stdout.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

/** True when the file is already 16 kHz mono PCM WAV and needs no conversion. */
export function isWhisperReadyWav(file: string): boolean {
  if (!/\.wav$/i.test(file)) return false;
  try {
    const header = readFileSync(file).subarray(0, 44);
    if (header.length < 44) return false;
    if (header.toString("ascii", 0, 4) !== "RIFF") return false;
    if (header.toString("ascii", 8, 12) !== "WAVE") return false;
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    return channels === 1 && sampleRate === 16000 && bitsPerSample === 16;
  } catch {
    return false;
  }
}

export interface PreparedAudio {
  path: string;
  /** Set when a temp file was created, so the caller can clean it up. */
  temporary: boolean;
}

export function prepareForWhisperCpp(file: string): PreparedAudio {
  if (isWhisperReadyWav(file)) return { path: file, temporary: false };

  if (!hasCommand("ffmpeg")) {
    throw new Error(
      `ffmpeg is required to convert "${file}" to the 16 kHz mono WAV whisper.cpp needs.\n` +
        `Install it (macOS: brew install ffmpeg / Debian: apt install ffmpeg), or pre-convert with:\n` +
        `  ffmpeg -i "${file}" -ar 16000 -ac 1 -c:a pcm_s16le converted.wav`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "typescribe-"));
  const out = join(dir, "audio-16k.wav");
  const result = spawnSync(
    "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed converting "${file}":\n${result.stderr?.trim()}`);
  }
  return { path: out, temporary: true };
}
