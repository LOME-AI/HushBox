/**
 * SentenceChunker — accumulates streamed tokens, emits completed sentences.
 * Used to feed Kokoro TTS sentence-by-sentence for chat-aloud streaming.
 *
 * Handles:
 * - Sentence boundaries on `.`, `!`, `?` followed by whitespace or end-of-stream
 * - Common abbreviations (Mr., Mrs., Ms., Dr., Prof., e.g., i.e., etc., vs., St.)
 * - Markdown stripping: code fences, link syntax (keeps label only)
 * - Multi-sentence batches in a single feed() call
 */

const ABBREVIATION_PATTERN =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e|etc|Sr|Jr|Inc|Ltd|Co|Corp)\.\s*$/i;

interface StripStep {
  /** Characters to append to the output (may be empty). */
  readonly out: string;
  /** Number of characters consumed from the input. */
  readonly consumed: number;
}

const PASSTHROUGH_CONSUMED = 1;

export class SentenceChunker {
  private buffer = '';
  private inCodeBlock = false;

  /** Feed a chunk of streamed text. Returns any newly-completed sentences. */
  feed(chunk: string): string[] {
    this.buffer += this.stripMarkdown(chunk);
    const completed: string[] = [];
    while (this.buffer.length > 0) {
      const match = this.findSentenceEnd();
      if (match === -1) break;
      // Slice always includes a non-whitespace boundary char (.,!,?), so the
      // trimmed result is guaranteed non-empty — no length-0 guard needed.
      completed.push(this.buffer.slice(0, match + 1).trim());
      this.buffer = this.buffer.slice(match + 1).trimStart();
    }
    return completed;
  }

  /** Return any remaining buffered text (for end-of-stream). Clears buffer. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining.length === 0) return null;
    return remaining;
  }

  private findSentenceEnd(): number {
    for (let index = 0; index < this.buffer.length; index++) {
      const ch = this.buffer.charAt(index);
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      // require whitespace or end-of-buffer after the punctuation
      const next = this.buffer.charAt(index + 1);
      if (next !== '' && !/\s/.test(next)) continue;
      // skip common abbreviations (Mr., Dr., e.g., etc.) so they don't split
      const before = this.buffer.slice(Math.max(0, index - 10), index + 1);
      if (ABBREVIATION_PATTERN.test(before)) continue;
      return index;
    }
    return -1;
  }

  private stripMarkdown(text: string): string {
    let out = '';
    let index = 0;
    while (index < text.length) {
      const step = this.stripNext(text, index);
      out += step.out;
      index += step.consumed;
    }
    return out;
  }

  /** Decide what to emit (and how far to advance) for one position in `text`. */
  private stripNext(text: string, index: number): StripStep {
    if (text.startsWith('```', index)) {
      this.inCodeBlock = !this.inCodeBlock;
      return { out: '', consumed: 3 };
    }
    if (this.inCodeBlock) {
      return { out: '', consumed: PASSTHROUGH_CONSUMED };
    }
    const ch = text.charAt(index);
    if (ch === '`') return stripInlineCode(text, index);
    if (ch === '[') return stripMarkdownLink(text, index);
    return { out: ch, consumed: PASSTHROUGH_CONSUMED };
  }
}

function stripInlineCode(text: string, index: number): StripStep {
  const close = text.indexOf('`', index + 1);
  if (close === -1) {
    // Orphan backtick — keep it so the surrounding sentence still parses.
    return { out: text.charAt(index), consumed: PASSTHROUGH_CONSUMED };
  }
  return { out: '', consumed: close + 1 - index };
}

function stripMarkdownLink(text: string, index: number): StripStep {
  const closeBracket = text.indexOf(']', index + 1);
  if (closeBracket === -1) {
    return { out: text.charAt(index), consumed: PASSTHROUGH_CONSUMED };
  }
  if (text.charAt(closeBracket + 1) !== '(') {
    return { out: text.charAt(index), consumed: PASSTHROUGH_CONSUMED };
  }
  const closeParen = text.indexOf(')', closeBracket + 2);
  if (closeParen === -1) {
    return { out: text.charAt(index), consumed: PASSTHROUGH_CONSUMED };
  }
  // Keep the label only — drop the URL.
  return { out: text.slice(index + 1, closeBracket), consumed: closeParen + 1 - index };
}
