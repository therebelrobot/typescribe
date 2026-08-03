# Hardware limits

Short version: typescribe itself has no meaningful hardware limits. Every real
constraint belongs to the Whisper model doing the transcription.

## typescribe (measured)

Synthetic transcripts, run through the compiled executable on an x86-64 Linux
container. Peak RSS includes the ~57 MB the Node runtime uses at idle, so
subtract that for the workload's own cost.

| Audio | `--chunk` | Words | Revisions | Peak RSS | Time | .docx | `document.xml` |
|---|---|---|---|---|---|---|---|
| 1 h | sentence | 8,179 | 805 | 79 MB | 0.1 s | 26 KB | 0.1 MB |
| 1 h | phrase | 8,179 | 1,787 | 81 MB | 0.1 s | 42 KB | 0.3 MB |
| 1 h | word | 8,179 | 8,349 | 93 MB | 0.1 s | 108 KB | 1.1 MB |
| 3 h | sentence | 24,405 | 2,402 | 97 MB | 0.1 s | 76 KB | 0.4 MB |
| 3 h | phrase | 24,405 | 5,303 | 102 MB | 0.2 s | 125 KB | 0.8 MB |
| 3 h | word | 24,405 | 24,934 | 133 MB | 0.3 s | 320 KB | 3.2 MB |
| 8 h | sentence | 65,294 | 6,382 | 134 MB | 0.3 s | 0.1 MB | 1.2 MB |
| 8 h | phrase | 65,294 | 14,142 | 143 MB | 0.4 s | 0.2 MB | 2.1 MB |
| 8 h | word | 65,294 | 66,650 | 184 MB | 1.0 s | 0.4 MB | 8.5 MB |

Everything is held in memory — the transcript, the plan, and the assembled
`document.xml` — so RSS scales linearly with recording length. At 8 hours in
`word` mode that is 184 MB. Extrapolating, a 24-hour recording in `word` mode
lands near 450 MB, which is the first point where a small SBC would notice.

Rendering the largest of these (66,650 tracked insertions, 122 pages) took
LibreOffice 3 seconds. Word handles documents of this shape without complaint;
the review pane is the slow part, not the file.

## The Whisper model (the actual constraint)

whisper.cpp file sizes and rough RAM at load, approximate — check the
[whisper.cpp models README](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
for current figures:

| Model | Params | GGML file | RAM (fp16) | RAM (Q5_1) | Use when |
|---|---|---|---|---|---|
| `tiny.en` | 39 M | ~75 MB | ~0.4 GB | ~0.2 GB | Clean single-speaker audio, weak hardware |
| `base.en` | 74 M | ~145 MB | ~0.5 GB | ~0.3 GB | Default; good accuracy-to-cost |
| `small.en` | 244 M | ~465 MB | ~1.0 GB | ~0.4 GB | Accents, some background noise |
| `medium.en` | 769 M | ~1.5 GB | ~2.6 GB | ~0.9 GB | Difficult audio, multiple speakers |
| `large-v3` | 1.55 B | ~3 GB | ~4.7 GB | ~1.2 GB | Best accuracy, non-English |

Quantized variants (`-q5_0`, `-q5_1` in the filename) cut disk and RAM roughly
3–4×. On anything memory-constrained, a quantized larger model usually beats an
unquantized smaller one.

**Practical floors:**

- 4 GB RAM: `base.en` or `small.en-q5_1` comfortably.
- 8 GB RAM: `medium.en` or `large-v3-q5_1`.
- 16 GB+: anything.
- Raspberry Pi 4/5: `tiny.en` or `base.en-q5_1` only, and expect transcription
  to take longer than the recording. Approximate — I have not benchmarked a Pi
  directly.

**Speed** is dominated by CPU core count and SIMD width, and by whether
whisper.cpp was built with an accelerator. On a modern desktop CPU, `base.en`
runs several times faster than real time; `large-v3` on the same CPU can be
slower than real time. Build with Metal (Apple Silicon), CUDA (NVIDIA), or
Vulkan (anything else) if the machine has a GPU — the difference is large,
particularly for `medium` and `large`.

Whisper's audio context is a fixed 30-second window and whisper.cpp streams
through the file in those chunks, so recording length costs time linearly but
does not raise the memory ceiling. A long recording is not a memory problem; it
is a patience problem.

## The executable

- **Roughly 100–120 MB per platform.** The carrier is a complete Node runtime;
  typescribe's own bundled code is about 45 KB of that. `--strip` removes
  ~15% on Linux and macOS. This is inherent to Node SEA — there is no tree
  shaking of the runtime.
- **One binary per OS *and* CPU architecture.** macOS arm64 and macOS x64 are
  separate builds, as are Linux arm64 and x64. The carrier Node binary must
  match the target.
- **The executable does not bundle the transcription stack.** It contains
  typescribe only. `whisper-cli`, the model `.bin`, and ffmpeg remain separate
  files the machine needs. A "portable" setup is the executable plus those three
  in a folder, which is closer to 500 MB with `base.en`.
- **Windows SmartScreen and macOS Gatekeeper** will flag an unsigned binary. The
  build script ad-hoc signs on macOS, which is enough for local use; real
  distribution needs a Developer ID certificate plus notarization, and an
  Authenticode certificate on Windows.

## Input format

whisper.cpp reads only 16 kHz mono 16-bit WAV. Anything else goes through
ffmpeg first, which needs temp space equal to roughly 2 MB per minute of audio
(115 MB for an hour). `--check` reports whether ffmpeg is present.
