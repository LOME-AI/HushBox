import { toBase64 } from '@hushbox/shared';
import {
  joinTextParts,
  pickModelName,
  replyDisplayFields,
  type ReplyMergeItem,
} from '@/hooks/crypto/reply-merge';
import type { Message, MessageMediaItem } from '@/lib/api/api';
import type { SharedContentItem, SharedMessageData } from '@/hooks/chat/use-shared-message';

type SharedTextItem = Extract<SharedContentItem, { type: 'text' }>;
type SharedMediaItem = Extract<SharedContentItem, { type: 'media' }>;

function isText(item: SharedContentItem): item is SharedTextItem {
  return item.type === 'text';
}

function isMedia(item: SharedContentItem): item is SharedMediaItem {
  return item.type === 'media';
}

/** `useSharedMessage` carries reasoning only on text items; a stored media item records none. */
function mergeItemOf(item: SharedContentItem): ReplyMergeItem {
  if (isText(item)) return item;
  return {
    modelName: item.modelName,
    isSmartModel: item.isSmartModel,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
  };
}

/**
 * Each row carries the URL the share read minted, so the media renderer never
 * asks the member-only download route for one.
 */
function mediaRow(item: SharedMediaItem): MessageMediaItem {
  return {
    id: item.contentItemId,
    position: item.position,
    contentType: item.contentType,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    downloadUrl: item.downloadUrl,
  };
}

/**
 * The public message share as the chat's own `Message`. Only a reply can be
 * shared, so the row is always an assistant's. It sets no cost, input or output
 * token counts, parent or batch, because the share read serves none of them. What a
 * public page draws is limited by the share dialog's published-row builder
 * (`publishedRowOf`), whatever this mapping sets.
 */
export function sharedMessageReply(data: SharedMessageData): Message {
  if (data.deleted) {
    return {
      id: data.messageId,
      conversationId: data.conversationId,
      role: 'assistant',
      content: '',
      createdAt: data.messageCreatedAt,
      deleted: true,
    };
  }
  const texts = data.contentItems.filter((item) => isText(item));
  const mergeItems = data.contentItems.map((item) => mergeItemOf(item));
  const mediaItems = data.contentItems
    .filter((item) => isMedia(item))
    .map((item) => mediaRow(item));
  return {
    id: data.messageId,
    conversationId: data.conversationId,
    role: 'assistant',
    content: joinTextParts(texts.map((item) => item.content)),
    // The share's own `createdAt` is when the link was made; the reply is dated by its message.
    createdAt: data.messageCreatedAt,
    senderId: data.senderId,
    epochNumber: data.epochNumber,
    wrappedContentKey: toBase64(data.wrappedContentKey),
    modelName: pickModelName(mergeItems),
    ...replyDisplayFields(mergeItems, mediaItems),
  };
}
