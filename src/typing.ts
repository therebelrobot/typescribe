/**
 * Turns a word timeline into a schedule of edits.
 *
 * The model has three moving parts:
 *
 *   1. A typist cannot type a word before hearing it end  -> `heardAt = word.end`
 *   2. A typist reacts, they do not transcribe instantly  -> `+ lag`
 *   3. A typist has a finite speed                        -> `chars / cps`
 *
 * Rule 3 is what makes the output look live rather than pasted: when speech
 * outruns the typist, edits queue up and the transcript trails the audio, and
 * the backlog only drains during pauses. `maxBacklog` reports how far behind
 * the typist ever fell, so `--wpm` can be tuned against a given recording.
 */

import type { Transcript, TranscriptWord } from "./transcript.ts";

export type ChunkMode = "word" | "phrase" | "sentence";

export interface TypingOptions {
  /** Seconds between hearing a word and starting to type it. */
  lag: number;
  /** Words per minute, standard 5-characters-per-word definition. */
  wpm: number;
  chunkMode: ChunkMode;
  maxChunkWords: number;
  /** Silence longer than this ends a chunk. */
  pauseGap: number;
  /** Silence longer than this starts a new paragraph. */
  paragraphGap: number;
  /**
   * Ceiling on how far behind the audio an edit may be recorded, in seconds.
   * null disables the cap. Without one, dense speech makes the queue grow for
   * the whole recording and the session ends long after the audio does.
   */
  maxBacklog: number | null;
  /** Wall-clock time corresponding to audio t=0. */
  sessionStart: Date;
}

export interface TypingChunk {
  /** Text as it lands in the document, including any trailing space. */
  text: string;
  audioStart: number;
  audioEnd: number;
  /** Wall-clock time the text finished landing — this becomes `w:date`. */
  typedAt: Date;
  /** Seconds this chunk landed behind the audio position it transcribes. */
  backlog: number;
}

export interface TypingParagraph {
  chunks: TypingChunk[];
  audioStart: number;
  audioEnd: number;
  /** When Enter was pressed to close this paragraph. */
  markTypedAt: Date;
}

export interface TypingPlan {
  paragraphs: TypingParagraph[];
  sessionStart: Date;
  sessionEnd: Date;
  audioDuration: number;
  maxBacklog: number;
  wordCount: number;
  characterCount: number;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

export function buildTypingPlan(
  transcript: Transcript,
  options: TypingOptions,
): TypingPlan {
  const paragraphGroups = groupParagraphs(transcript.words, options.paragraphGap);
  const charsPerSecond = (options.wpm * 5) / 60;
  // The cap can never be tighter than the reaction delay itself.
  const backlogCap =
    options.maxBacklog === null ? null : Math.max(options.maxBacklog, options.lag);

  const paragraphs: TypingParagraph[] = [];
  let typistFreeAt = 0; // seconds on the audio clock
  let maxBacklog = 0;
  let wordCount = 0;
  let characterCount = 0;

  for (let p = 0; p < paragraphGroups.length; p++) {
    const group = paragraphGroups[p]!;
    const chunkGroups = groupChunks(group, options);
    const chunks: TypingChunk[] = [];

    for (let c = 0; c < chunkGroups.length; c++) {
      const words = chunkGroups[c]!;
      const isLastInParagraph = c === chunkGroups.length - 1;
      const text =
        words.map((word) => word.text).join(" ") + (isLastInParagraph ? "" : " ");

      // Typing on a chunk begins once its first word has been heard, but it
      // cannot *finish* before the last word has been heard — you can't type
      // ahead of the speaker.
      const firstHeard = words[0]!.start;
      const lastHeard = words[words.length - 1]!.end;
      const startTyping = Math.max(firstHeard + options.lag, typistFreeAt);
      let finishTyping = Math.max(
        startTyping + text.length / charsPerSecond,
        lastHeard + options.lag,
      );
      // Clamp the queue. A real notetaker who falls a long way behind catches
      // up in bursts rather than trailing by an hour; without this the session
      // length diverges from the recording length on any dense recording.
      if (backlogCap !== null) {
        finishTyping = Math.min(finishTyping, lastHeard + backlogCap);
      }
      typistFreeAt = finishTyping;

      const backlog = finishTyping - lastHeard;
      if (backlog > maxBacklog) maxBacklog = backlog;

      chunks.push({
        text,
        audioStart: words[0]!.start,
        audioEnd: words[words.length - 1]!.end,
        typedAt: atOffset(options.sessionStart, finishTyping),
        backlog: Math.round(backlog * 100) / 100,
      });

      wordCount += words.length;
      characterCount += text.length;
    }

    // Enter is one keystroke, pressed immediately after the last chunk lands.
    typistFreeAt += 1 / charsPerSecond;

    paragraphs.push({
      chunks,
      audioStart: group[0]!.start,
      audioEnd: group[group.length - 1]!.end,
      markTypedAt: atOffset(options.sessionStart, typistFreeAt),
    });
  }

  const audioDuration = Math.max(transcript.duration, 0);

  return {
    paragraphs,
    sessionStart: options.sessionStart,
    sessionEnd: atOffset(options.sessionStart, Math.max(typistFreeAt, audioDuration)),
    audioDuration,
    maxBacklog: Math.round(maxBacklog * 100) / 100,
    wordCount,
    characterCount,
  };
}

function groupParagraphs(
  words: TranscriptWord[],
  paragraphGap: number,
): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous && word.start - previous.end > paragraphGap) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

function groupChunks(
  words: TranscriptWord[],
  options: TypingOptions,
): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    current.push(word);

    const next = words[i + 1];
    if (!next) break;

    const endsSentence = SENTENCE_END.test(word.text);
    const gap = next.start - word.end;

    let shouldBreak: boolean;
    switch (options.chunkMode) {
      case "word":
        shouldBreak = true;
        break;
      case "sentence":
        shouldBreak = endsSentence;
        break;
      case "phrase":
      default:
        shouldBreak =
          endsSentence || gap > options.pauseGap || current.length >= options.maxChunkWords;
        break;
    }

    if (shouldBreak) flush();
  }

  flush();
  return groups;
}

function atOffset(base: Date, seconds: number): Date {
  return new Date(base.getTime() + Math.round(seconds * 1000));
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
