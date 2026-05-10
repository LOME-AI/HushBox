import { eq } from 'drizzle-orm';
import { messages, type DatabaseClient } from '@hushbox/db';
import { deleteMessagesAfterAnchor } from './message-deletion.js';
import { validateParentMessageId } from './message-helpers.js';

/**
 * How a chat turn grafts onto the message tree. Both `/stream` and
 * `/regenerate` share one persistence path; this prelude is the only step
 * that varies.
 *
 * - `regenerate` covers BOTH wire actions `retry` and `regenerate` — they
 *   are functionally identical on the server.
 */
export type TreeAction =
  | {
      kind: 'fresh-send';
      userMessage: { id: string; content: string };
      parentMessageId: string | null;
    }
  | {
      kind: 'regenerate';
      anchorUserMessageId: string;
      forkTipMessageId?: string;
    }
  | {
      kind: 'edit';
      anchorUserMessageId: string;
      newUserMessage: { id: string; content: string };
      forkTipMessageId?: string;
    };

export interface ApplyTreeActionResult {
  parentMessageIdForAssistants: string;
  /** Undefined for regenerate (existing user msg preserved). */
  userMessageInsert: { id: string; content: string; parentMessageId: string | null } | undefined;
  /** Optimistic-concurrency guard passed to `updateForkTip`. */
  forkTipExpectedMessageId: string | null;
}

/** The user message id this turn is keyed off, regardless of kind. */
export function treeActionUserMessageId(action: TreeAction): string {
  switch (action.kind) {
    case 'fresh-send': {
      return action.userMessage.id;
    }
    case 'regenerate': {
      return action.anchorUserMessageId;
    }
    case 'edit': {
      return action.newUserMessage.id;
    }
  }
}

/**
 * Runs inside the caller's transaction. Throws when an `edit` action
 * references a target id that does not exist — caller's txn rolls back.
 */
export async function applyTreeAction(
  tx: DatabaseClient,
  conversationId: string,
  action: TreeAction
): Promise<ApplyTreeActionResult> {
  switch (action.kind) {
    case 'fresh-send': {
      await validateParentMessageId(tx, conversationId, action.parentMessageId);
      return {
        parentMessageIdForAssistants: action.userMessage.id,
        userMessageInsert: {
          id: action.userMessage.id,
          content: action.userMessage.content,
          parentMessageId: action.parentMessageId,
        },
        forkTipExpectedMessageId: action.parentMessageId,
      };
    }
    case 'regenerate': {
      await deleteMessagesAfterAnchor(tx, {
        conversationId,
        anchorMessageId: action.anchorUserMessageId,
        ...(action.forkTipMessageId !== undefined && {
          forkTipMessageId: action.forkTipMessageId,
        }),
      });
      return {
        parentMessageIdForAssistants: action.anchorUserMessageId,
        userMessageInsert: undefined,
        forkTipExpectedMessageId: action.forkTipMessageId ?? null,
      };
    }
    case 'edit': {
      const [target] = await tx
        .select({ parentMessageId: messages.parentMessageId })
        .from(messages)
        .where(eq(messages.id, action.anchorUserMessageId));
      if (!target) {
        throw new Error('Target message not found');
      }
      const targetParentId = target.parentMessageId;
      const forkTipSpread =
        action.forkTipMessageId === undefined ? {} : { forkTipMessageId: action.forkTipMessageId };

      if (targetParentId) {
        await deleteMessagesAfterAnchor(tx, {
          conversationId,
          anchorMessageId: targetParentId,
          ...forkTipSpread,
        });
      } else {
        await deleteMessagesAfterAnchor(tx, {
          conversationId,
          anchorMessageId: action.anchorUserMessageId,
          ...forkTipSpread,
        });
        await tx.delete(messages).where(eq(messages.id, action.anchorUserMessageId));
      }

      return {
        parentMessageIdForAssistants: action.newUserMessage.id,
        userMessageInsert: {
          id: action.newUserMessage.id,
          content: action.newUserMessage.content,
          parentMessageId: targetParentId,
        },
        forkTipExpectedMessageId: action.forkTipMessageId ?? null,
      };
    }
  }
}
