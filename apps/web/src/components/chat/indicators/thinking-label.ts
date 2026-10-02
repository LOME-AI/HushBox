import { shortenModelName } from '@hushbox/shared';

/**
 * Who an answer's status lines name: the shortened model name, or "AI" when
 * there is none. Every sentence that names the working model starts here, so
 * a reader sees one subject across the thinking and searching lines.
 *
 * The `|| 'AI'` arm is load-bearing on its own: `shortenModelName` returns an
 * empty string for a whitespace-only name.
 */
export function answerSubject(modelName?: string): string {
  return shortenModelName(modelName ?? '') || 'AI';
}

/**
 * The one spelling of a turn's thinking announcement. Two surfaces render it —
 * the reasoning row, for a turn that reasons, and the answer-body indicator,
 * for a turn that does not — and a reader who sees both across two turns must
 * read the same sentence, so the sentence is written here and nowhere else.
 */
export function thinkingLabel(modelName?: string): string {
  return `${answerSubject(modelName)} is thinking`;
}
