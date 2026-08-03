/**
 * Normalizes every transcript shape this tool accepts into one flat, ordered
 * list of words with second-resolution start/end times.
 *
 * Supported inputs:
 *   - whisper.cpp  `-oj` / `-ojf`   ({ transcription: [...] }, optional per-token times)
 *   - openai-whisper / faster-whisper / whisperx JSON ({ segments: [...] })
 *   - SRT
 *   - WebVTT
 *
 * When a source has no per-word timing, word times are interpolated across the
 * segment in proportion to character length. `interpolated` records that, so
 * `--verbose` can say which timings are real.
 */

export interface TranscriptWord {
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  interpolated: boolean;
}

export interface Transcript {
  words: TranscriptWord[];
  /** Seconds; the end of the last word unless the caller knows the media duration. */
  duration: number;
  source: string;
}

interface RawSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

const BLANK_MARKERS = new Set([
  "[BLANK_AUDIO]",
  "(blank audio)",
  "[SILENCE]",
  "[MUSIC]",
  "[ Silence ]",
]);

export function parseTranscript(raw: string, sourceLabel: string): Transcript {
  const trimmed = raw.trim();
  let segments: RawSegment[];
  let source: string;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    const detected = fromJson(parsed);
    segments = detected.segments;
    source = detected.source;
  } else if (/^WEBVTT/i.test(trimmed)) {
    segments = fromCues(trimmed, "vtt");
    source = "webvtt";
  } else {
    segments = fromCues(trimmed, "srt");
    source = "srt";
  }

  const words: TranscriptWord[] = [];
  for (const segment of segments) {
    if (segment.words?.length) {
      words.push(...segment.words);
    } else {
      words.push(...interpolateSegment(segment));
    }
  }

  const cleaned = words
    .map((word) => ({ ...word, text: word.text.trim() }))
    .filter((word) => word.text.length > 0 && !BLANK_MARKERS.has(word.text));

  // ASR backends occasionally emit a token whose end precedes its start, or a
  // pair that overlaps. Both break the typing model's monotonic assumption.
  let cursor = 0;
  for (const word of cleaned) {
    if (!Number.isFinite(word.start) || word.start < cursor) word.start = cursor;
    if (!Number.isFinite(word.end) || word.end < word.start) word.end = word.start;
    cursor = word.end;
  }

  return {
    words: cleaned,
    duration: cleaned.length ? cleaned[cleaned.length - 1]!.end : 0,
    source: `${source} (${sourceLabel})`,
  };
}

function fromJson(parsed: unknown): { segments: RawSegment[]; source: string } {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Transcript JSON is not an object.");
  }
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj["transcription"])) {
    return { segments: fromWhisperCpp(obj["transcription"]), source: "whisper.cpp json" };
  }
  if (Array.isArray(obj["segments"])) {
    return { segments: fromWhisperPython(obj["segments"]), source: "whisper json" };
  }
  throw new Error(
    "Unrecognized transcript JSON: expected a top-level `transcription` (whisper.cpp) or `segments` (whisper/faster-whisper) array.",
  );
}

/** whisper.cpp: offsets are integer milliseconds; `-ojf` adds a `tokens` array. */
function fromWhisperCpp(entries: unknown[]): RawSegment[] {
  const segments: RawSegment[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, any>;
    const start = msToSeconds(e["offsets"]?.from);
    const end = msToSeconds(e["offsets"]?.to);
    const text = String(e["text"] ?? "");
    const segment: RawSegment = { start, end, text };

    if (Array.isArray(e["tokens"])) {
      const words = mergeTokens(
        e["tokens"].map((token: Record<string, any>) => ({
          text: String(token["text"] ?? ""),
          start: msToSeconds(token["offsets"]?.from),
          end: msToSeconds(token["offsets"]?.to),
        })),
      );
      if (words.length) segment.words = words;
    }
    segments.push(segment);
  }
  return segments;
}

/** openai-whisper / faster-whisper / whisperx: seconds, optional `words` array. */
function fromWhisperPython(entries: unknown[]): RawSegment[] {
  const segments: RawSegment[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, any>;
    const segment: RawSegment = {
      start: Number(e["start"] ?? 0),
      end: Number(e["end"] ?? 0),
      text: String(e["text"] ?? ""),
    };
    if (Array.isArray(e["words"])) {
      const words: TranscriptWord[] = [];
      for (const w of e["words"] as Record<string, any>[]) {
        const text = String(w["word"] ?? w["text"] ?? "").trim();
        if (!text) continue;
        words.push({
          text,
          start: Number(w["start"] ?? segment.start),
          end: Number(w["end"] ?? w["start"] ?? segment.end),
          interpolated: false,
        });
      }
      if (words.length) segment.words = words;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Whisper emits BPE pieces. A piece that begins with a space opens a new word;
 * everything else glues onto the current one. Special tokens (`[_BEG_]`,
 * `[_TT_240]`, timestamps) are dropped.
 */
function mergeTokens(
  tokens: { text: string; start: number; end: number }[],
): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const token of tokens) {
    const text = token.text;
    if (!text || /^\[_.*_\]$/.test(text.trim()) || BLANK_MARKERS.has(text.trim())) {
      continue;
    }
    const startsWord = /^\s/.test(text) || words.length === 0;
    const piece = text.trim();
    if (!piece) continue;

    const current = words[words.length - 1];
    if (startsWord || !current) {
      words.push({ text: piece, start: token.start, end: token.end, interpolated: false });
    } else {
      current.text += piece;
      current.end = Math.max(current.end, token.end);
    }
  }
  return words;
}

/** Split a segment's text into words and spread the times by character weight. */
function interpolateSegment(segment: RawSegment): TranscriptWord[] {
  const pieces = segment.text.trim().split(/\s+/).filter(Boolean);
  if (!pieces.length) return [];
  const span = Math.max(0, segment.end - segment.start);
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;

  let cursor = segment.start;
  return pieces.map((piece) => {
    const width = (piece.length / totalChars) * span;
    const word: TranscriptWord = {
      text: piece,
      start: cursor,
      end: cursor + width,
      interpolated: true,
    };
    cursor += width;
    return word;
  });
}

function msToSeconds(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n / 1000 : 0;
}

const CUE_TIME =
  /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function fromCues(raw: string, kind: "srt" | "vtt"): RawSegment[] {
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const segments: RawSegment[] = [];

  for (const block of blocks) {
    if (kind === "vtt" && /^WEBVTT/i.test(block.trim())) continue;
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    const timeIndex = lines.findIndex((line) => CUE_TIME.test(line));
    if (timeIndex === -1) continue;

    const match = CUE_TIME.exec(lines[timeIndex]!)!;
    const start = cueSeconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end = cueSeconds(match[5]!, match[6]!, match[7]!, match[8]!);
    const text = lines
      .slice(timeIndex + 1)
      .join(" ")
      // Strip subtitle markup only. A blanket /<[^>]+>/ would also eat spoken
      // text that happens to sit in angle brackets.
      .replace(/<\/?(?:b|i|u|s|ruby|rt|v|c|lang|font)(?:[ .:][^>]*)?>/gi, "")
      .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, "")
      .trim();
    if (text) segments.push({ start, end, text });
  }

  if (!segments.length) {
    throw new Error(
      `No cues found in the ${kind.toUpperCase()} transcript. Check the file is a subtitle file and not plain text.`,
    );
  }
  return segments;
}

function cueSeconds(h: string, m: string, s: string, frac: string): number {
  return (
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(frac.padEnd(3, "0")) / 1000
  );
}
