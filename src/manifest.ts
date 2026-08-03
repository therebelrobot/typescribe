/**
 * What `typescribe setup` is allowed to fetch.
 *
 * Everything here is pinned by version and, where a hash could be verified,
 * by SHA-256. `typescribe setup --list` prints this table so the URLs and
 * digests can be audited before anything is downloaded.
 *
 * The whisper.cpp digests were computed from the published v1.9.1 release
 * assets. The model digests are trust-on-first-use: upstream publishes no
 * signed checksum list for them, so the first install records what it received
 * into `installed.json` and `--verify` checks against that recording
 * afterwards. That detects later tampering with the local copy; it does not
 * authenticate the original download. Pin your own values with --model-sha256
 * if you have them from another source.
 */

export interface ComponentSource {
  url: string;
  sha256?: string;
  /** Path inside the archive to the binary, once extracted. */
  binaryPath?: string;
  archive?: "tar.gz" | "zip" | "raw";
  sizeBytes?: number;
}

export const WHISPER_CPP_VERSION = "v1.9.1";

/** Keyed by `${process.platform}-${process.arch}`. */
export const WHISPER_CPP: Record<string, ComponentSource> = {
  "linux-x64": {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
    archive: "tar.gz",
    binaryPath: "whisper-bin-ubuntu-x64/whisper-cli",
    sizeBytes: 9_437_184,
  },
  "linux-arm64": {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
    archive: "tar.gz",
    binaryPath: "whisper-bin-ubuntu-arm64/whisper-cli",
    sizeBytes: 4_613_734,
  },
  "win32-x64": {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`,
    sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    archive: "zip",
    binaryPath: "Release/whisper-cli.exe",
    sizeBytes: 8_074_035,
  },
  "win32-ia32": {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-Win32.zip`,
    sha256: "be1ea26c9665f1165a2f3afb64f24476c09ba7da479c844bf33ef2870d47c954",
    archive: "zip",
    binaryPath: "Release/whisper-cli.exe",
    sizeBytes: 5_138_022,
  },
};

/**
 * Upstream publishes no prebuilt macOS CLI — only an xcframework, which is for
 * embedding rather than command-line use. Setup falls back to these on darwin.
 */
export const DARWIN_INSTRUCTIONS = `whisper.cpp publishes no prebuilt macOS CLI, so setup cannot fetch one.

Two ways to get it:

  brew install whisper-cpp

or build it (about 2 minutes on Apple Silicon, and Metal acceleration is
compiled in by default, which is meaningfully faster than the Homebrew build):

  git clone https://github.com/ggml-org/whisper.cpp
  cd whisper.cpp && cmake -B build && cmake --build build -j --config Release
  cp build/bin/whisper-cli <install-dir>/whisper/

Then re-run \`typescribe setup --model <size>\` to fetch just the model.`;

export const MODELS = [
  "tiny.en", "tiny", "base.en", "base", "small.en", "small",
  "medium.en", "medium", "large-v3", "large-v3-turbo",
  "tiny.en-q5_1", "base.en-q5_1", "small.en-q5_1", "medium.en-q5_1", "large-v3-q5_0",
] as const;

export type ModelName = (typeof MODELS)[number];

/** Approximate download sizes, for the confirmation prompt. */
export const MODEL_SIZES: Record<string, string> = {
  "tiny.en": "75 MB", "tiny": "75 MB",
  "base.en": "145 MB", "base": "145 MB",
  "small.en": "465 MB", "small": "465 MB",
  "medium.en": "1.5 GB", "medium": "1.5 GB",
  "large-v3": "3.1 GB", "large-v3-turbo": "1.6 GB",
  "tiny.en-q5_1": "31 MB", "base.en-q5_1": "57 MB",
  "small.en-q5_1": "182 MB", "medium.en-q5_1": "539 MB",
  "large-v3-q5_0": "1.1 GB",
};

export function modelSource(model: string): ComponentSource {
  return {
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin?download=true`,
    archive: "raw",
  };
}

/**
 * ffmpeg is deliberately not fetched. whisper-cli 1.9+ decodes wav, mp3, ogg,
 * and flac itself, so ffmpeg only matters for m4a, aac, opus, and video
 * containers. The available prebuilt static builds come from unofficial
 * third-party repositories with no upstream signatures, which is a worse
 * supply-chain position than the platform's own package manager.
 */
export const FFMPEG_INSTRUCTIONS: Record<string, string> = {
  darwin: "brew install ffmpeg",
  linux: "sudo apt install ffmpeg   (or dnf/pacman/apk equivalent)",
  win32: "winget install Gyan.FFmpeg   (or: choco install ffmpeg)",
};
