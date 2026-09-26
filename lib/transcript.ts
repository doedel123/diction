/**
 * Assemble xAI streaming STT events into committed utterances and a live tail.
 *
 * Documented states of `transcript.partial` (docs.x.ai speech-to-text):
 * - is_final=false: interim text, may still change
 * - is_final=true, speech_final=false: chunk final, about 3s of locked speech
 * - is_final=true, speech_final=true: utterance final, the complete stitched utterance
 *
 * Events carry `start`, and the server revises a segment by reusing that start.
 * A speech-final event may be the stitched utterance (same start as earlier
 * chunks, text contains them) or only the last chunk. Both are handled:
 * pieces are kept until a stitched speech-final absorbs later segments.
 */

export type SttWord = {
  text?: string;
};

export type SttEvent = {
  type?: string;
  text?: string;
  words?: SttWord[];
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
};

export type Segment = {
  start: number;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
};

export type TranscriptState = {
  segments: Segment[];
  closed: boolean;
};

export type TranscriptView = {
  finalText: string;
  partialText: string;
  fullText: string;
};

export function emptyTranscript(): TranscriptState {
  return { segments: [], closed: false };
}

export function applySttEvent(state: TranscriptState, event: SttEvent): TranscriptState {
  if (event.type === "transcript.done") {
    const text = eventText(event);
    if (text) {
      return {
        closed: true,
        segments: [{ start: 0, text, isFinal: true, speechFinal: true }],
      };
    }
    if (state.segments.length === 0) {
      return { ...state, closed: true };
    }
    const sorted = [...state.segments].sort((a, b) => a.start - b.start);
    const last = sorted[sorted.length - 1];
    return {
      closed: true,
      segments: sorted.map((segment) =>
        segment === last ? { ...segment, isFinal: true, speechFinal: true } : segment,
      ),
    };
  }

  if (event.type !== "transcript.partial" || state.closed) return state;

  const text = eventText(event);
  if (!text) return state;

  const speechFinal = event.speech_final === true;
  const isFinal = event.is_final === true || speechFinal;
  const start =
    typeof event.start === "number" && Number.isFinite(event.start) ? event.start : -1;

  const next: Segment = { start, text, isFinal, speechFinal };
  return { ...state, segments: upsertSegment(state.segments, next) };
}

export function projectTranscript(state: TranscriptState): TranscriptView {
  const sorted = [...state.segments].sort((a, b) => a.start - b.start);
  const utterances: string[] = [];
  let current: string[] = [];

  for (const segment of sorted) {
    current.push(segment.text);
    if (segment.speechFinal) {
      const utterance = joinTexts(current);
      if (utterance) utterances.push(utterance);
      current = [];
    }
  }

  const finalText = utterances.join("\n\n");
  const partialText = joinTexts(current);
  const fullText = joinBlocks(finalText, partialText);
  return { finalText, partialText, fullText };
}

function upsertSegment(segments: Segment[], next: Segment): Segment[] {
  const kept = segments.filter((segment) => {
    if (segment.start === next.start) return false;
    if (
      next.speechFinal &&
      segment.start > next.start &&
      phraseIncluded(next.text, segment.text)
    ) {
      return false;
    }
    return true;
  });
  kept.push(next);
  return kept;
}

function phraseIncluded(haystack: string, needle: string): boolean {
  const right = needle.trim().toLowerCase();
  if (right.length < 2) return false;
  return haystack.toLowerCase().includes(right);
}

function eventText(event: SttEvent): string {
  if (typeof event.text === "string" && event.text.trim()) return event.text.trim();
  if (!Array.isArray(event.words)) return "";
  return event.words
    .map((word) => (typeof word.text === "string" ? word.text.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

function joinTexts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinBlocks(finalText: string, partialText: string): string {
  if (finalText && partialText) return `${finalText}\n\n${partialText}`;
  return finalText || partialText;
}
