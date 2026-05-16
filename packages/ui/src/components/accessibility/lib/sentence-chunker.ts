/**
 * SentenceChunker — accumulates streamed tokens, emits completed sentences.
 * Used to feed Kokoro TTS sentence-by-sentence for chat-aloud streaming.
 *
 * Pre-buffer responsibility: only fenced code blocks. Fence content can
 * contain `.` followed by whitespace, which would trigger false sentence
 * boundaries; stripping fences during ingestion keeps boundary detection
 * honest. Everything else (links, inline code, bold, headings, lists, raw
 * URLs, HTML, tables) is left intact in the buffer and removed at emission
 * time via `normalizeForSpeech` — this preserves the inner text of inline
 * code spans (the LLM said "use `npm install`" — the user wants to hear
 * "npm install", not silence).
 *
 * Handles:
 * - Sentence boundaries on `.`, `!`, `?` followed by whitespace or end-of-stream
 * - Common abbreviations (Mr., Mrs., Ms., Dr., Prof., e.g., i.e., etc., vs., St.)
 * - Fenced code blocks across feed() calls
 * - Multi-sentence batches in a single feed() call
 * - Markdown cleanup at emission time
 */

import { normalizeForSpeech } from './text-normalizer';

const ABBREVIATION_PATTERN =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e|etc|Sr|Jr|Inc|Ltd|Co|Corp)\.\s*$/i;

interface StripStep {
  readonly out: string;
  readonly consumed: number;
}

const PASSTHROUGH_CONSUMED = 1;

export class SentenceChunker {
  private buffer = '';
  private inCodeBlock = false;

  /** Feed a chunk of streamed text. Returns any newly-completed sentences. */
  feed(chunk: string): string[] {
    this.buffer += this.stripFences(chunk);
    const completed: string[] = [];
    while (this.buffer.length > 0) {
      const match = this.findSentenceEnd();
      if (match === -1) break;
      const raw = this.buffer.slice(0, match + 1).trim();
      this.buffer = this.buffer.slice(match + 1).trimStart();
      const normalized = normalizeForSpeech(raw);
      if (normalized.length > 0) completed.push(normalized);
    }
    return completed;
  }

  /** Return any remaining buffered text (for end-of-stream). Clears buffer. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining.length === 0) return null;
    const normalized = normalizeForSpeech(remaining);
    return normalized.length === 0 ? null : normalized;
  }

  private findSentenceEnd(): number {
    for (let index = 0; index < this.buffer.length; index++) {
      const ch = this.buffer.charAt(index);
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      const next = this.buffer.charAt(index + 1);
      if (next !== '' && !/\s/.test(next)) continue;
      const before = this.buffer.slice(Math.max(0, index - 10), index + 1);
      if (ABBREVIATION_PATTERN.test(before)) continue;
      return index;
    }
    return -1;
  }

  /**
   * Strip fenced code blocks (```...```) from incoming text. State (open or
   * closed) persists across feed() calls so a fence opened in one chunk and
   * closed in another is correctly handled.
   */
  private stripFences(text: string): string {
    let out = '';
    let index = 0;
    while (index < text.length) {
      const step = this.fenceStep(text, index);
      out += step.out;
      index += step.consumed;
    }
    return out;
  }

  private fenceStep(text: string, index: number): StripStep {
    if (text.startsWith('```', index)) {
      this.inCodeBlock = !this.inCodeBlock;
      return { out: '', consumed: 3 };
    }
    if (this.inCodeBlock) {
      return { out: '', consumed: PASSTHROUGH_CONSUMED };
    }
    return { out: text.charAt(index), consumed: PASSTHROUGH_CONSUMED };
  }
}
