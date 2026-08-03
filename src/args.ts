/** Hand-rolled flag parsing — keeps the dependency count at zero. */

import type { ChunkMode } from "./typing.ts";
import type { BackendName } from "./backends.ts";

export interface CliOptions {
  input?: string;
  transcript?: string;
  backend: BackendName | "auto";
  model?: string;
  whisperBin?: string;
  modelDir?: string;
  dir?: string;
  language: string;
  threads?: number;
  allowModelDownload: boolean;

  out?: string;
  title?: string;
  author: string;
  keepTranscript: boolean;

  lag: number;
  wpm: number;
  chunkMode: ChunkMode;
  maxChunkWords: number;
  pauseGap: number;
  paragraphGap: number;
  maxBacklog: number | null;
  start?: Date;
  timestamps: boolean;

  dryRun: boolean;
  jsonPlan?: string;
  verbose: boolean;
  check: boolean;
  help: boolean;
  version: boolean;
}

const DEFAULTS: CliOptions = {
  backend: "auto",
  language: "en",
  allowModelDownload: false,
  author: "Live Transcript",
  keepTranscript: false,
  lag: 1.2,
  wpm: 100,
  chunkMode: "phrase",
  maxChunkWords: 6,
  pauseGap: 0.6,
  paragraphGap: 2.0,
  maxBacklog: 15,
  timestamps: false,
  dryRun: false,
  verbose: false,
  check: false,
  help: false,
  version: false,
};

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value.`);
      return next;
    };
    const num = (label: string) => {
      const parsed = Number(value());
      if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
      return parsed;
    };

    switch (arg) {
      case "--transcript": options.transcript = value(); break;
      case "--backend": {
        const backend = value();
        if (backend !== "auto" && backend !== "whisper-cpp" && backend !== "whisper") {
          throw new Error(`--backend must be auto, whisper-cpp, or whisper (got "${backend}").`);
        }
        options.backend = backend;
        break;
      }
      case "--model": options.model = value(); break;
      case "--whisper-bin": options.whisperBin = value(); break;
      case "--model-dir": options.modelDir = value(); break;
      case "--dir": options.dir = value(); break;
      case "--allow-model-download": options.allowModelDownload = true; break;
      case "--language": options.language = value(); break;
      case "--threads": options.threads = num("--threads"); break;

      case "-o":
      case "--out": options.out = value(); break;
      case "--title": options.title = value(); break;
      case "--author": options.author = value(); break;
      case "--keep-transcript": options.keepTranscript = true; break;

      case "--lag": options.lag = num("--lag"); break;
      case "--wpm": options.wpm = num("--wpm"); break;
      case "--chunk": {
        const mode = value();
        if (mode !== "word" && mode !== "phrase" && mode !== "sentence") {
          throw new Error(`--chunk must be word, phrase, or sentence (got "${mode}").`);
        }
        options.chunkMode = mode;
        break;
      }
      case "--max-chunk-words": options.maxChunkWords = num("--max-chunk-words"); break;
      case "--pause-gap": options.pauseGap = num("--pause-gap"); break;
      case "--paragraph-gap": options.paragraphGap = num("--paragraph-gap"); break;
      case "--max-backlog": {
        const raw = value();
        if (raw === "off") { options.maxBacklog = null; break; }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`--max-backlog must be a non-negative number of seconds, or "off" (got "${raw}").`);
        }
        options.maxBacklog = parsed;
        break;
      }
      case "--start": {
        const raw = value();
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(`--start is not a parseable date: "${raw}". Use e.g. 2026-08-03T09:15:00Z.`);
        }
        options.start = parsed;
        break;
      }
      case "--timestamps": options.timestamps = true; break;

      case "--dry-run": options.dryRun = true; break;
      case "--check": options.check = true; break;
      case "--json-plan": options.jsonPlan = value(); break;
      case "-v":
      case "--verbose": options.verbose = true; break;
      case "-h":
      case "--help": options.help = true; break;
      case "--version": options.version = true; break;

      default:
        if (arg.startsWith("-") && arg !== "-") {
          throw new Error(`Unknown flag: ${arg}. Run typescribe --help for the flag list.`);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Expected one audio file, got ${positional.length}: ${positional.join(", ")}`);
  }
  options.input = positional[0];

  if (options.wpm <= 0) throw new Error("--wpm must be greater than 0.");
  if (options.maxChunkWords < 1) throw new Error("--max-chunk-words must be at least 1.");
  if (options.lag < 0) throw new Error("--lag cannot be negative.");

  return options;
}

export const HELP = `typescribe — audio in, Word document out, with a tracked-change history
that reproduces the transcript being typed live against the recording.

USAGE
  typescribe setup                          one-time, needs network
  typescribe <audio-file> [options]         offline from here on
  typescribe --transcript notes.json --start 2026-08-03T09:15:00Z

INPUT
  --transcript <file>     Skip speech-to-text; read an existing .json (whisper.cpp
                          or whisper/faster-whisper), .srt, or .vtt.
  --backend <name>        auto | whisper-cpp | whisper           (default: auto)
  --model <name|path>     Model name resolved against the install directory
                          (e.g. base.en), or an explicit file path.
                          Defaults to whatever setup installed.
  --whisper-bin <path>    Explicit path to the backend binary.
  --dir <path>            typescribe install directory (where setup put
                          whisper.cpp and the models).
                          (default: beside the executable, else the platform
                          user data directory; TYPESCRIBE_HOME overrides)
  --model-dir <dir>       Where the Python backend looks for weights.
                                          (default: ~/.cache/whisper)
  --allow-model-download  Permit the backend to fetch weights over the
                          network. Off by default: runs are offline and a
                          missing model is an error, not a download.
  --language <code>       Spoken language.                       (default: en)
  --threads <n>           Passed through to the backend.

OUTPUT
  -o, --out <file>        Output .docx.        (default: <audio basename>.docx)
  --title <string>        dc:title of the document.
  --author <string>       Revision author on every tracked change.
                                                (default: "Live Transcript")
  --keep-transcript       Also write the intermediate transcript JSON.
  --timestamps            Prefix each paragraph with its [mm:ss] audio position.

TYPING MODEL
  --lag <seconds>         Delay between hearing a word and typing it.  (default: 1.2)
  --wpm <n>               Typing speed. Lower values make the transcript
                          fall behind during fast speech.              (default: 100)
  --chunk <mode>          word | phrase | sentence — granularity of each
                          tracked insertion.                      (default: phrase)
  --max-chunk-words <n>   Cap on words per insertion in phrase mode.   (default: 6)
  --pause-gap <seconds>   Silence that ends an insertion.              (default: 0.6)
  --paragraph-gap <secs>  Silence that starts a new paragraph.         (default: 2.0)
  --max-backlog <secs>    Ceiling on how far behind the audio an edit may be
                          recorded, or "off" for no ceiling. Without a ceiling,
                          dense speech makes the session run far longer than
                          the recording.                                (default: 15)
  --start <iso-datetime>  Wall-clock time of audio t=0.
                          (default: audio file mtime minus its duration)

OTHER
  --check                 Report whether this machine can transcribe offline,
                          then exit. Transcribes nothing.
  --dry-run               Print the typing plan; write nothing.
  --json-plan <file>      Write the typing plan as JSON.
  -v, --verbose           Show backend commands and timing detail.
  -h, --help              This text.
  --version               Print version.

EXAMPLES
  typescribe interview.m4a --model ~/models/ggml-base.en.bin
  typescribe lecture.wav --chunk word --wpm 55 --timestamps -o lecture.docx
  typescribe --transcript lecture.srt --start "2026-08-03T09:15:00Z" -o lecture.docx
`;

// ---------------------------------------------------------------------------
// `typescribe setup`
// ---------------------------------------------------------------------------

export interface SetupCliOptions {
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
  help: boolean;
}

export function parseSetupArgs(argv: string[]): SetupCliOptions {
  const options: SetupCliOptions = {
    model: "base.en",
    yes: false,
    list: false,
    verify: false,
    skipWhisper: false,
    skipModel: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value.`);
      return next;
    };
    switch (arg) {
      case "--model": options.model = value(); break;
      case "--dir": options.dir = value(); break;
      case "-y":
      case "--yes": options.yes = true; break;
      case "--list": options.list = true; break;
      case "--verify": options.verify = true; break;
      case "--bundle": options.bundle = value(); break;
      case "--from-bundle": options.fromBundle = value(); break;
      case "--model-sha256": options.modelSha256 = value(); break;
      case "--skip-whisper": options.skipWhisper = true; break;
      case "--skip-model": options.skipModel = true; break;
      case "-h":
      case "--help": options.help = true; break;
      default:
        throw new Error(`Unknown flag for \`setup\`: ${arg}. Run typescribe setup --help.`);
    }
  }
  return options;
}

export const SETUP_HELP = `typescribe setup — take a bare executable to a working install

USAGE
  typescribe setup [options]

  Downloads whisper.cpp and a Whisper model into an install directory, then
  transcription works with no further flags. This is the only command that
  uses the network.

OPTIONS
  --model <name>          Model to fetch.                     (default: base.en)
                          tiny.en base.en small.en medium.en large-v3
                          large-v3-turbo, and -q5_1 quantized variants.
  --dir <path>            Install directory. Default is a typescribe-data
                          folder beside the executable when that is writable,
                          otherwise the platform user data directory.
                          TYPESCRIBE_HOME overrides both.
  -y, --yes               Skip the confirmation prompt.
  --list                  Print the pinned URLs and digests and exit.
                          Downloads nothing.
  --verify                Re-hash what is installed against what was recorded.
  --model-sha256 <hex>    Pin the model digest instead of trusting on first use.
  --skip-whisper          Fetch only the model.
  --skip-model            Fetch only whisper.cpp.

AIR-GAPPED INSTALL
  --bundle <dir>          On a connected machine: copy this install into <dir>
                          as a portable folder.
  --from-bundle <dir>     On the offline machine: install from that folder.
                          Uses no network.

EXAMPLES
  typescribe setup --list
  typescribe setup --model small.en -y
  typescribe setup --bundle ./typescribe-bundle          # connected machine
  typescribe setup --from-bundle ./typescribe-bundle     # air-gapped machine
`;
