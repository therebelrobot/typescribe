/** Hand-rolled flag parsing — keeps the dependency count at zero. */

import type { ChunkMode } from "./typing.ts";
import type { BackendName } from "./backends.ts";

export interface CliOptions {
  input?: string;
  transcript?: string;
  backend: BackendName | "auto";
  model: string;
  whisperBin?: string;
  modelDir?: string;
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
  model: "base.en",
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
  typescribe <audio-file> [options]
  typescribe --transcript notes.json --start 2026-08-03T09:15:00Z

INPUT
  --transcript <file>     Skip speech-to-text; read an existing .json (whisper.cpp
                          or whisper/faster-whisper), .srt, or .vtt.
  --backend <name>        auto | whisper-cpp | whisper           (default: auto)
  --model <path|size>     whisper.cpp: path to a ggml .bin model.
                          whisper: a size name.                  (default: base.en)
  --whisper-bin <path>    Explicit path to the backend binary.
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
