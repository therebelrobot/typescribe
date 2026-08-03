# typescribe

Audio file in, `.docx` out. The document's tracked-change history reproduces the
transcript arriving in time with the recording — each insertion carries the
wall-clock moment a typist listening at that speed would have finished it.

Zero runtime dependencies. Fully offline after setup.

## Run it

Zero to working, from just the executable:

```bash
./typescribe setup            # one time, needs network
./typescribe recording.mp3    # offline from here on
```

`setup` fetches whisper.cpp and a Whisper model into an install directory, then
transcription works with no further flags. From source instead of the
executable:

```bash
node --experimental-strip-types src/cli.ts setup
node --experimental-strip-types src/cli.ts recording.mp3
```

No build step — Node 22.6+ strips the types at load. `npm start -- <args>` does
the same thing.

If you have no local model yet, everything downstream of transcription works on
a transcript file:

```bash
node --experimental-strip-types src/cli.ts --transcript fixtures/whisper-python.json --dry-run
```

## Single executable

```bash
npm ci
npm run build:sea:strip
./dist/typescribe --check
```

Produces one file for the platform you built on: `dist/typescribe`, or
`dist/typescribe.exe` on Windows. Roughly 100–120 MB — the carrier is a whole
Node runtime, of which typescribe's own code is about 45 KB.

It uses Node's built-in Single Executable Application support: esbuild bundles
`src/` to CommonJS, `node --experimental-sea-config` makes a blob, and postject
injects it into a copy of a Node binary. The only third-party build tools are
esbuild and postject, both devDependencies; nothing is fetched at runtime.

Both are called through their JavaScript APIs rather than their CLIs. Shelling
out to `npx` fails on Windows, where the shim is `npx.cmd` and `spawnSync` will
not resolve a `.cmd` without a shell — and enabling `shell: true` to fix that
would put file paths through cmd.exe quoting. The remaining subprocesses
(`strip`, `codesign`, `signtool`) are all optional and platform-guarded: a
machine without them warns and continues.

`npm ci` requires `package-lock.json` to be committed. The workflow falls back
to `npm install` if it is missing.

**All three platforms at once:** push a `v*` tag and
`.github/workflows/release.yml` builds natively on ubuntu, macos, and windows
runners, smoke-tests each binary, and attaches them to the release with
SHA256SUMS. Native builds avoid having to fetch and verify a foreign Node
binary, and macOS signing only works on a macOS runner.

**Cross-building locally** is possible if you prefer: download the target
platform's Node from nodejs.org, verify it against `SHASUMS256.txt`, and point
the script at it.

```bash
node --experimental-strip-types scripts/build-sea.ts \
  --platform win32 --node vendor/node-win32-x64/node.exe
```

The executable contains typescribe only. `whisper-cli`, the model `.bin`, and
ffmpeg stay separate files on the machine — see [HARDWARE.md](HARDWARE.md).

## setup

```
typescribe setup                       fetch whisper.cpp + base.en, prompt first
typescribe setup --list                print pinned URLs and digests, fetch nothing
typescribe setup --model small.en -y   pick a model, skip the prompt
typescribe setup --verify              re-hash what is installed
```

**Install directory** is portable-first: a `typescribe-data` folder beside the
executable when that location is writable, otherwise the platform user data
directory (`%LOCALAPPDATA%`, `~/Library/Application Support`,
`$XDG_DATA_HOME`). `--dir` or `TYPESCRIBE_HOME` override it. Portable-first
means the executable plus its data folder move as a unit — onto a USB stick, or
onto a machine that has never been online.

```
<install-dir>/
  whisper/          whisper-cli and its shared libraries
  models/           ggml-<name>.bin
  installed.json    version, source URL, and digest of each component
```

A run looks for whisper-cli in the install directory first, then `PATH`, so a
`setup` install wins over whatever the host happens to have.

**What it will and will not fetch:**

| Component | Fetched | Source | Integrity |
|---|---|---|---|
| whisper.cpp v1.9.1 | yes | GitHub release | SHA-256 pinned in `src/manifest.ts` |
| Whisper model | yes | Hugging Face | trust on first use, recorded for `--verify` |
| ffmpeg | no | your package manager | — |

The whisper.cpp digests were computed from the published release assets and are
checked before extraction; a mismatch deletes the partial file and aborts.
Upstream publishes no signed checksum list for the models, so the first install
records what it received and `--verify` checks against that recording
afterwards — that detects later tampering with the local copy, it does not
authenticate the original download. `--model-sha256` pins it properly if you
have a digest from another source.

ffmpeg is deliberately not fetched. whisper-cli 1.9+ decodes wav, mp3, ogg, and
flac itself, so ffmpeg only matters for m4a, aac, opus, and video containers,
and the available prebuilt static builds come from unofficial third-party
repositories with no upstream signatures. `setup` reports whether ffmpeg is
present and prints your platform's install command.

**macOS** has no prebuilt whisper.cpp CLI upstream — only an xcframework, which
is for embedding. `setup` detects this and prints the two options
(`brew install whisper-cpp`, or a two-minute cmake build that compiles in Metal
acceleration), then fetches the model for you.

### Air-gapped install

```bash
# on a connected machine
typescribe setup --model small.en -y
typescribe setup --bundle ./typescribe-bundle

# copy the folder across, then on the offline machine
typescribe setup --from-bundle ./typescribe-bundle
```

`--from-bundle` uses no network at all. A `base.en` bundle is about 160 MB;
whisper.cpp alone is 28 MB.

## Building whisper.cpp yourself

Only needed if you want Metal/CUDA/Vulkan acceleration, or you are on macOS
where no prebuilt CLI is published.

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp && cmake -B build && cmake --build build -j --config Release
cp build/bin/whisper-cli <install-dir>/whisper/
```

Then `typescribe setup --skip-whisper` fetches just the model.

**Offline guarantee** above.

## Offline guarantee

After setup, no step needs the network. Verify it on the target machine:

```bash
node --experimental-strip-types src/cli.ts --check
```

It reports Node version, which backend resolved, whether the model weights are
on disk, and ffmpeg/ffprobe presence, then says whether a run would need
network. It transcribes nothing and exits 1 if something is missing.

What backs that up:

1. **Network capability is confined to one file.** `src/net.ts` is the only
   module that imports `node:https`, and the only module that imports it is
   `src/setup.ts`. Nothing on the transcription path reaches either, so "does
   this run touch the network" is answerable by looking at one import edge:

   ```bash
   grep -rl "node:https\|node:http" src/    # -> src/net.ts
   grep -rn 'from "./net.ts"' src/           # -> src/setup.ts only
   ```

   Everything else uses `child_process`, `crypto`, `fs`, `os`, `path`, `zlib`,
   and `readline`. There are no runtime dependencies at all.
2. **Running needs no `node_modules`.** `node --experimental-strip-types
   src/cli.ts` runs the TypeScript directly. `npm install` is only for
   `typecheck` and `build`, neither of which is needed to use the tool.
3. **Subprocesses are forced offline.** Backends are spawned with
   `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, and
   `NO_PROXY=*`. `--allow-model-download` is the only way to lift that, and it
   is off by default.
4. **Missing weights are an error, not a download.** The Python backends
   (openai-whisper, faster-whisper, whisperx) resolve a model *name* and will
   fetch it if absent — openai-whisper from an Azure CDN, the others from the
   Hugging Face hub. typescribe checks the weights are on disk before spawning
   and refuses with the path it looked at.

**whisper.cpp is the backend to prefer for a hard offline guarantee.** It takes
an explicit `.bin` file path and contains no downloader, so there is nothing to
suppress. The Python backends work offline too, but the guarantee there rests on
cache state rather than on the binary lacking the capability.

`typescribe setup` is the one command that uses the network, and it says so
before doing anything. Run it once, then disconnect — or skip it entirely with
`--from-bundle`.

## What the output looks like

Every run of text is wrapped in `<w:ins>` with a `w:date`. Open it in Word and
the review pane shows the transcript building up over the length of the
recording; accept all changes and you get the clean transcript. The document is
saved with `w:trackRevisions` on, which is the state a genuinely live-typed
document would be in.

`--timestamps` prefixes each paragraph with its `[mm:ss]` position in the audio,
in a `Timestamp` character style you can restyle or delete.

## The typing model

Three things decide when a piece of text lands:

1. You cannot type a word before you have heard it — `word.end` is the floor.
2. You react rather than transcribe instantly — `+ --lag` seconds.
3. You type at a finite speed — `chars ÷ (--wpm × 5 ÷ 60)`.

Rule 3 is what makes the history look live rather than pasted. English speech
averages roughly 140 wpm; the default typist runs at 100 wpm, so during fast
stretches edits queue up and the transcript trails the audio, then catches up
during pauses. The summary line reports `max backlog` — how far behind the
typist ever fell — so you can tune `--wpm` against a specific recording.

`--max-backlog` (default 15 s) caps that trail. Without it the queue grows for
the whole recording: a dense 60-minute file produced a 98-minute typing session
before the cap existed. The cap moves timestamps only — no text is dropped.

Chunk granularity (`--chunk`) controls how many separate revisions get recorded,
not the timing:

| mode | one insertion per | revisions on a 60-minute talk (approx.) |
|---|---|---|
| `word` | word | ~9,000 |
| `phrase` (default) | pause, sentence end, or `--max-chunk-words` | ~1,800 |
| `sentence` | sentence | ~700 |

`word` mode produces a large `document.xml`. It opens fine; it is just slower to
scroll in Word.

## Flags

```
INPUT
  --transcript <file>     Skip speech-to-text; read an existing .json
                          (whisper.cpp or whisper/faster-whisper), .srt, or .vtt
  --backend <name>        auto | whisper-cpp | whisper           (default: auto)
  --model <path|size>     whisper.cpp: path to a ggml .bin model
                          whisper: a size name                   (default: base.en)
  --whisper-bin <path>    Explicit path to the backend binary
  --model-dir <dir>       Where the Python backend looks for weights
                                                 (default: ~/.cache/whisper)
  --allow-model-download  Permit the backend to fetch weights over the network.
                          Off by default: runs are offline and a missing model
                          is an error, not a download
  --language <code>       Spoken language                        (default: en)
  --threads <n>           Passed through to the backend

OUTPUT
  -o, --out <file>        Output .docx           (default: <audio basename>.docx)
  --title <string>        dc:title of the document
  --author <string>       Revision author on every tracked change
                                                 (default: "Live Transcript")
  --keep-transcript       Also write the intermediate transcript JSON
  --timestamps            Prefix each paragraph with its [mm:ss] audio position

TYPING MODEL
  --lag <seconds>         Delay between hearing a word and typing it (default: 1.2)
  --wpm <n>               Typing speed                            (default: 100)
  --chunk <mode>          word | phrase | sentence                (default: phrase)
  --max-chunk-words <n>   Cap on words per insertion in phrase mode (default: 6)
  --pause-gap <seconds>   Silence that ends an insertion          (default: 0.6)
  --paragraph-gap <secs>  Silence that starts a new paragraph     (default: 2.0)
  --max-backlog <secs>    Ceiling on how far behind the audio an edit may be
                          recorded, or "off" for none. Without a ceiling, dense
                          speech makes the session run far longer than the
                          recording                                (default: 15)
  --start <iso-datetime>  Wall-clock time of audio t=0
                          (default: audio file mtime minus its duration)

OTHER
  --check                 Report whether this machine can transcribe offline,
                          then exit. Transcribes nothing
  --dry-run               Print the typing plan; write nothing
  --json-plan <file>      Write the typing plan as JSON
  -v, --verbose           Show backend commands and timing detail
  -h, --help              Usage
  --version               Print version
```

## Transcript formats accepted

| Source | Detected by | Word-level timing |
|---|---|---|
| whisper.cpp `-oj -ojf` | top-level `transcription` array | yes, from per-token offsets (BPE pieces are merged back into words) |
| openai-whisper / faster-whisper / whisperx | top-level `segments` array | yes, when `words` is present |
| SRT | `-->` cue lines | no — interpolated across each cue by character weight |
| WebVTT | leading `WEBVTT` | no — interpolated |

Interpolated timings are marked internally; `--verbose` reports which source was
used. Subtitle markup (`<b>`, `<v Speaker>`, cue timestamps) is stripped;
arbitrary angle-bracketed speech such as `5 < 7` is preserved.

## What this deliberately does not do

No fabricated typo/correction pairs, and no synthetic `rsid` save-session
identifiers. Both exist only to make machine output survive forensic authorship
examination, which is a different tool from "show the transcript arriving in
time with the audio." What is here is visible in Word's ordinary review pane,
and `docProps/app.xml` names `typescribe` as the generating application.

## Layout

```
src/cli.ts          argument handling, orchestration, summary output
src/args.ts         flag parser and help text
src/audio.ts        ffprobe duration, ffmpeg 16 kHz mono conversion
src/backends.ts     whisper.cpp and whisper CLI detection and invocation
src/transcript.ts   every input format -> one flat word timeline
src/typing.ts       word timeline -> scheduled edits with lag and backlog
src/docx/build.ts   OOXML parts
src/docx/zip.ts     minimal ZIP writer (node:zlib, no deps)
src/docx/xml.ts     escaping and OOXML date format
src/setup.ts        the setup subcommand
src/manifest.ts     pinned component sources and digests
src/net.ts          the only file that can reach the network
src/archive.ts      tar.gz and zip extraction (node:zlib only)
src/paths.ts        install directory and component resolution
scripts/build-sea.ts  single-executable build (esbuild -> SEA blob -> postject)
fixtures/           sample transcripts for testing without a model
```

Verified against the ISO 29500 WordprocessingML schema, and round-tripped
through LibreOffice: insertions are recognized as tracked changes and accepting
them yields the clean transcript.

## Scripts

None of these are needed to run the tool offline; `node
--experimental-strip-types src/cli.ts` works with no `node_modules` present.

```bash
npm start -- <args>       # run
npm run build:sea:strip   # single executable for this platform
npm run dev -- <args>     # run via tsx
npm run typecheck         # tsc --noEmit
npm run build             # esbuild bundle -> dist/typescribe.mjs
```

## Hardware

See [HARDWARE.md](HARDWARE.md) for measured memory, time, and output size across
recording lengths, plus Whisper model sizing.

## License

Unlicense.
