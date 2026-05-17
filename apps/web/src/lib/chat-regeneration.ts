import { SMART_MODEL_ID } from '@hushbox/shared';

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

interface MessageWithMedia extends MessageWithParent {
  mediaItems?: readonly { contentType: 'image' | 'audio' | 'video' }[] | undefined;
}

export type RegenerateModality = 'text' | 'image' | 'audio' | 'video';

/**
 * `targetMessageId` is the user message; walk to its first AI child and read
 * the modality from `mediaItems[0].contentType`. Falls back to `'text'` when
 * no AI reply exists yet (the target hasn't been answered) or when the AI
 * reply has no media (a text reply).
 */
export function inferRegenerateModality(
  targetMessageId: string,
  allMessages: readonly MessageWithMedia[]
): RegenerateModality {
  const aiChild = allMessages.find(
    (m) => m.parentMessageId === targetMessageId && m.role === 'assistant'
  );
  const firstMedia = aiChild?.mediaItems?.[0];
  return firstMedia?.contentType ?? 'text';
}

/**
 * Returns true when at least `n` assistant messages share the given parent,
 * excluding `excludeId` (used to skip the target itself when scanning siblings).
 * Short-circuits as soon as the threshold is met.
 */
function hasAtLeastNAssistantsWithParent(
  messages: MessageWithParent[],
  parentId: string | null | undefined,
  n: number,
  excludeId?: string
): boolean {
  if (!parentId) return false;
  let count = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.parentMessageId === parentId && m.id !== excludeId) {
      count++;
      if (count >= n) return true;
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
 *
 * For per-render bulk checks, prefer {@link getMultiModelMessageIds} which
 * computes the same predicate for every id in a single O(N) pass.
 */
export function isMultiModelResponse(messages: MessageWithParent[], targetId: string): boolean {
  const target = messages.find((m) => m.id === targetId);
  if (!target) return false;

  if (target.role === 'assistant') {
    return hasAtLeastNAssistantsWithParent(messages, target.parentMessageId, 1, target.id);
  }

  return hasAtLeastNAssistantsWithParent(messages, targetId, 2);
}

function buildAssistantChildCount(messages: MessageWithParent[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.parentMessageId) {
      count.set(m.parentMessageId, (count.get(m.parentMessageId) ?? 0) + 1);
    }
  }
  return count;
}

function isMultiModelByCount(m: MessageWithParent, childCount: Map<string, number>): boolean {
  if (m.role === 'assistant' && m.parentMessageId) {
    return (childCount.get(m.parentMessageId) ?? 0) >= 2;
  }
  if (m.role === 'user') {
    return (childCount.get(m.id) ?? 0) >= 2;
  }
  return false;
}

/**
 * Returns the set of message ids that are part of a multi-model response —
 * either an assistant message with ≥1 assistant sibling, or a user message
 * with ≥2 assistant children. Computed in a single O(N) pass so render loops
 * can do O(1) lookups instead of calling {@link isMultiModelResponse} per row
 * (which was O(N) each → O(N²) overall).
 */
export function getMultiModelMessageIds(messages: MessageWithParent[]): Set<string> {
  const childCount = buildAssistantChildCount(messages);
  const multiModelIds = new Set<string>();
  for (const m of messages) {
    if (isMultiModelByCount(m, childCount)) multiModelIds.add(m.id);
  }
  return multiModelIds;
}

interface RegenerateTarget {
  targetMessageId: string;
  action: 'retry';
  /**
   * Set when the click landed on one tile of a multi-model assistant group.
   * Causes the backend to delete only that one assistant and replace it with
   * one new assistant in the same parent — surviving siblings keep their
   * existing rows + costs. Omitted otherwise (retry-all semantics).
   */
  replaceAssistantId?: string;
}

interface MessageWithModelName extends MessageWithParent {
  modelName?: string | null;
  isSmartModel?: boolean;
}

/**
 * Resolves a regenerate/retry click to a unified retry target.
 *
 * - Click on a user message → retry-all (every assistant descendant
 *   replaced; one new assistant per `models[i]`).
 * - Click on an assistant in a single-model turn → walk up to the parent
 *   user message and retry-all (equivalent: only one sibling exists).
 * - Click on an assistant in a multi-model turn → walk up to the parent
 *   user message AND set `replaceAssistantId` so only that single tile gets
 *   replaced; the other siblings stay put.
 */
export function resolveRegenerateTarget(
  messages: MessageWithParent[],
  messageId: string
): RegenerateTarget {
  const msg = messages.find((m) => m.id === messageId);
  if (msg?.role === 'assistant' && msg.parentMessageId) {
    const parentId = msg.parentMessageId;
    const partOfMultiModelGroup = hasAtLeastNAssistantsWithParent(messages, parentId, 2);
    if (partOfMultiModelGroup) {
      return { targetMessageId: parentId, action: 'retry', replaceAssistantId: msg.id };
    }
    return { targetMessageId: parentId, action: 'retry' };
  }
  return { targetMessageId: messageId, action: 'retry' };
}

function collectSiblingModels(messages: MessageWithModelName[], parentId: string): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || m.parentMessageId !== parentId) continue;
    if (m.isSmartModel) {
      out.push(SMART_MODEL_ID);
      continue;
    }
    const name = m.modelName;
    if (name != null && name !== '') out.push(name);
  }
  return out;
}

// `modelName` stores the RESOLVED downstream id for a Smart Model turn (see
// apps/api/src/services/chat/message-persistence.ts:117-124). Sending that
// resolved id back on regenerate would bypass the classifier and downgrade
// the message to a direct-model send; emit the symbolic SMART_MODEL_ID
// instead so the server's pre-inference stage runs again.
function modelOfAssistant(
  messages: MessageWithModelName[],
  assistantId: string
): string | undefined {
  const target = messages.find((m) => m.id === assistantId);
  if (target?.isSmartModel) return SMART_MODEL_ID;
  const name = target?.modelName;
  if (name == null || name === '') return undefined;
  return name;
}

/**
 * Resolves the `models` array for a regenerate request.
 *
 * - regenerate-one (`replaceAssistantId` set) → the single model that
 *   produced the tile being replaced, falling back to `fallbackModelId` if
 *   that tile is missing or has no `modelName`.
 * - retry-all (`replaceAssistantId` undefined) → the model of every
 *   assistant child of `targetMessageId` (the user-message anchor), in
 *   document order. Empty groups (no existing siblings) fall back to
 *   `[fallbackModelId]` so fresh-send-style retries still work.
 */
export function resolveRegenerateModels(
  messages: MessageWithModelName[],
  targetMessageId: string,
  replaceAssistantId: string | undefined,
  fallbackModelId: string
): string[] {
  if (replaceAssistantId !== undefined) {
    return [modelOfAssistant(messages, replaceAssistantId) ?? fallbackModelId];
  }
  const siblingModels = collectSiblingModels(messages, targetMessageId);
  return siblingModels.length > 0 ? siblingModels : [fallbackModelId];
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
