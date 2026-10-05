import { groupConsecutiveMessages, type MessageGroup } from '@/lib/chat/sender';
import type { Message } from '@/lib/api/api';

/** A compare turn's replies, in the order the turn asked its models; never empty. */
export type SiblingReplies = readonly [Message, ...Message[]];

/** One row of the thread: a message alone, or the replies one question drew from several models. */
export type MessageRow =
  | { readonly kind: 'message'; readonly message: Message }
  | { readonly kind: 'compare'; readonly replies: SiblingReplies };

/** One row of a group chat: a run of one sender's messages, or a compare turn's replies. */
export type GroupedRow =
  | { readonly kind: 'group'; readonly group: MessageGroup }
  | { readonly kind: 'compare'; readonly replies: SiblingReplies };

/** The question a reply answers, when it is a reply that names one. */
function questionOf(message: Message): string | undefined {
  if (message.role !== 'assistant') return undefined;
  return message.parentMessageId ?? undefined;
}

function rowOf(replies: SiblingReplies): MessageRow {
  if (replies.length === 1) return { kind: 'message', message: replies[0] };
  return { kind: 'compare', replies };
}

/**
 * The thread as rows. A turn's replies sit next to each other in the history, so a run of
 * replies to one question is that turn's compare group; anything else stays a row of its own.
 */
export function groupSiblingReplies(messages: readonly Message[]): readonly MessageRow[] {
  const rows: MessageRow[] = [];
  let run: [Message, ...Message[]] | undefined;
  let runQuestion: string | undefined;
  for (const message of messages) {
    const question = questionOf(message);
    if (run !== undefined && question !== undefined && question === runQuestion) {
      run.push(message);
      continue;
    }
    if (run !== undefined) rows.push(rowOf(run));
    run = [message];
    runQuestion = question;
  }
  if (run !== undefined) rows.push(rowOf(run));
  return rows;
}

/**
 * A group chat's rows: today's runs of one sender's messages, with each compare turn kept
 * whole between them. A compare turn holds only replies, which never join a sender's run.
 */
export function groupSenderRuns(rows: readonly MessageRow[]): readonly GroupedRow[] {
  const grouped: GroupedRow[] = [];
  let run: Message[] = [];
  const flush = (): void => {
    for (const group of groupConsecutiveMessages(run)) grouped.push({ kind: 'group', group });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === 'message') {
      run.push(row.message);
      continue;
    }
    flush();
    grouped.push(row);
  }
  flush();
  return grouped;
}
