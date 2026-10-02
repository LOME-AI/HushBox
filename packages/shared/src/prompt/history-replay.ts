import { assistantHistoryText } from '../assistant-text/projection.ts';
import type { ChatHistoryMessage } from '../workflow/inference.ts';

/**
 * Reduces resent assistant turns to what a model may read before a run starts.
 * A stored assistant message carries its whole segment tree (reasoning, search
 * rows, answer text), and BOTH client history sources resend it verbatim: rows
 * the client decrypted (E2EE means the server never reads them from the DB) and
 * the client's live-built optimistic messages. Only the root answer text
 * survives: feeding thoughts back changes model behavior and cost, and a search
 * row resent would add input no reservation covers.
 *
 * Only assistant turns are read; user text is never interpreted. An assistant
 * turn with no answer text (a reasoning-only aborted partial) is dropped: an
 * empty assistant message has no replay value and some providers reject empty
 * content.
 *
 * One linear pass per message: the grammar reads frames by length and never
 * scans a body, so no nesting a client sends can multiply the work.
 *
 * A history with nothing to strip returns the SAME array. That is why the
 * return is `readonly` and why callers wanting a mutable array spread it
 * themselves: the common path (every conversation of plain answers)
 * allocates nothing, on a function the run route calls per request and the
 * client's history counters call per render. This module's own test pins the
 * identity.
 */
export function stripReplayHistory(
  history: readonly ChatHistoryMessage[]
): readonly ChatHistoryMessage[] {
  let changed = false;
  const stripped: ChatHistoryMessage[] = [];
  for (const message of history) {
    if (message.role !== 'assistant') {
      stripped.push(message);
      continue;
    }
    const answer = assistantHistoryText(message.content);
    if (answer === message.content) {
      stripped.push(message);
      continue;
    }
    changed = true;
    if (answer !== '') {
      stripped.push({ role: 'assistant', content: answer });
    }
  }
  return changed ? stripped : history;
}
