interface MessageLike {
  id: string;
  role: string;
  senderId?: string | null;
}

interface MessageWithParent {
  id: string;
  role: string;
  parentMessageId?: string | null;
}

function hasMultipleAssistantSiblings(
  messages: MessageWithParent[],
  target: MessageWithParent
): boolean {
  const parentId = target.parentMessageId;
  if (!parentId) return false;
  return messages.some(
    (m) => m.id !== target.id && m.role === 'assistant' && m.parentMessageId === parentId
  );
}

function hasMultipleAssistantChildren(messages: MessageWithParent[], targetId: string): boolean {
  let assistantChildCount = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.parentMessageId === targetId) {
      assistantChildCount++;
      if (assistantChildCount > 1) return true;
    }
  }
  return false;
}

/**
 * Detects whether a message is part of a multi-model response.
 *
 * Returns true when:
 * - Target is an assistant message and another assistant message shares the same parentMessageId
 * - Target is a user message and multiple assistant messages have parentMessageId === targetId
 */
export function isMultiModelResponse(messages: MessageWithParent[], targetId: string): boolean {
  const target = messages.find((m) => m.id === targetId);
  if (!target) return false;

  if (target.role === 'assistant') {
    return hasMultipleAssistantSiblings(messages, target);
  }

  return hasMultipleAssistantChildren(messages, targetId);
}

interface RegenerateTarget {
  targetMessageId: string;
  action: 'retry';
}

/**
 * Resolves a regenerate/retry click to a unified retry target.
 *
 * When clicking on an assistant message, resolves to its parent user message
 * so both "retry" and "regenerate" follow the same code path.
 */
export function resolveRegenerateTarget(
  messages: MessageWithParent[],
  messageId: string
): RegenerateTarget {
  const msg = messages.find((m) => m.id === messageId);
  if (msg?.role === 'assistant' && msg.parentMessageId) {
    return { targetMessageId: msg.parentMessageId, action: 'retry' };
  }
  return { targetMessageId: messageId, action: 'retry' };
}

type RegenerateAction = 'retry' | 'edit';

interface RegenerationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface InferenceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function getMessagesSlice(
  allMessages: RegenerationMessage[],
  targetIndex: number,
  action: RegenerateAction
): RegenerationMessage[] {
  if (action === 'edit') {
    return targetIndex > 0 ? allMessages.slice(0, targetIndex) : [];
  }

  if (targetIndex < 0) {
    return allMessages;
  }

  return allMessages.slice(0, targetIndex + 1);
}

/**
 * Builds the messagesForInference array for a regeneration request.
 *
 * For retry: includes messages up to and including the target user message.
 * For edit: excludes the target message and appends the edited content.
 */
export function buildMessagesForRegeneration(
  allMessages: RegenerationMessage[],
  targetMessageId: string,
  action: RegenerateAction,
  editedContent?: string
): InferenceMessage[] {
  const targetIndex = allMessages.findIndex((m) => m.id === targetMessageId);
  const messagesUpToTarget = getMessagesSlice(allMessages, targetIndex, action);

  const result: InferenceMessage[] = messagesUpToTarget.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (action === 'edit' && editedContent) {
    result.push({ role: 'user', content: editedContent });
  }

  return result;
}

function isOtherUserMessage(msg: MessageLike, userId: string): boolean {
  return msg.role === 'user' && msg.senderId != null && msg.senderId !== userId;
}

function hasOtherUserMessageAfter(
  messages: MessageLike[],
  startIndex: number,
  userId: string
): boolean {
  for (let index = startIndex; index < messages.length; index++) {
    const msg = messages[index];
    if (msg && isOtherUserMessage(msg, userId)) return true;
  }
  return false;
}

/**
 * Client-side guard for whether a user can regenerate a message.
 *
 * Solo chats: always allowed.
 * Group chats:
 *   - Cannot retry/edit another user's message
 *   - Cannot retry/edit if a different user sent a message after the target
 */
export function canRegenerateMessage(
  messages: MessageLike[],
  targetId: string,
  userId: string,
  isGroupChat: boolean
): boolean {
  if (!isGroupChat) return true;

  const targetIndex = messages.findIndex((m) => m.id === targetId);
  if (targetIndex === -1) return true;

  const target = messages[targetIndex];
  if (!target) return true;

  if (isOtherUserMessage(target, userId)) return false;

  return !hasOtherUserMessageAfter(messages, targetIndex + 1, userId);
}
