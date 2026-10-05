import { describe, it, expect } from 'vitest';
import {
  generateContentKey,
  generateEpochKeyPair,
  wrapContentKeyToEpoch,
  type ContentKey,
  type WrappedSecret,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { sharedMessageReply } from '@/hooks/chat/shared-message-reply';
import type { SharedContentItem, SharedMessageData } from '@/hooks/chat/use-shared-message';

type LiveShare = Extract<SharedMessageData, { deleted: false }>;
type DeletedShare = Extract<SharedMessageData, { deleted: true }>;
type TextItem = Extract<SharedContentItem, { type: 'text' }>;
type MediaItem = Extract<SharedContentItem, { type: 'media' }>;

const CONVERSATION_ID = '00000000-0000-7000-8000-00000000c0de';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000001';
const SENDER_ID = '00000000-0000-7000-8000-000000005e11';
const EPOCH_NUMBER = 3;
const SHARE_CREATED_AT = isoAt(TEST_DAY_START + 10 * HOUR_MS);
const MESSAGE_CREATED_AT = isoAt(TEST_DAY_START + 9 * HOUR_MS);

const contentKey: ContentKey = generateContentKey();
const epochWrap: WrappedSecret = wrapContentKeyToEpoch(
  generateEpochKeyPair().publicKey,
  contentKey
);

function textItem(overrides: Partial<TextItem> = {}): TextItem {
  return {
    type: 'text',
    position: 0,
    content: 'An answer.',
    modelName: null,
    isSmartModel: false,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
    ...overrides,
  };
}

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    type: 'media',
    position: 1,
    contentItemId: 'ci-media-1',
    contentType: 'image',
    mimeType: 'image/png',
    sizeBytes: 2048,
    width: 640,
    height: 480,
    durationMs: null,
    modelName: null,
    isSmartModel: false,
    downloadUrl: 'https://media.example/share-minted',
    expiresAt: isoAt(TEST_DAY_START + 11 * HOUR_MS),
    ...overrides,
  };
}

function liveShare(contentItems: SharedContentItem[] = [textItem()]): LiveShare {
  return {
    deleted: false,
    contentKey,
    wrappedContentKey: epochWrap,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    epochNumber: EPOCH_NUMBER,
    senderId: SENDER_ID,
    createdAt: SHARE_CREATED_AT,
    messageCreatedAt: MESSAGE_CREATED_AT,
    contentItems,
  };
}

function deletedShare(): DeletedShare {
  return {
    deleted: true,
    messageId: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    createdAt: SHARE_CREATED_AT,
    messageCreatedAt: MESSAGE_CREATED_AT,
  };
}

describe('sharedMessageReply', () => {
  describe('a live share', () => {
    it("takes the message's id from the share's message id", () => {
      expect(sharedMessageReply(liveShare()).id).toBe(MESSAGE_ID);
    });

    it("takes the share's conversation id", () => {
      expect(sharedMessageReply(liveShare()).conversationId).toBe(CONVERSATION_ID);
    });

    it("takes the share's epoch number", () => {
      expect(sharedMessageReply(liveShare()).epochNumber).toBe(EPOCH_NUMBER);
    });

    it("takes the share's sender id", () => {
      expect(sharedMessageReply(liveShare()).senderId).toBe(SENDER_ID);
    });

    it('is an assistant reply, since only a reply can be shared', () => {
      expect(sharedMessageReply(liveShare()).role).toBe('assistant');
    });

    it("is dated by the message's own creation, not the share's", () => {
      expect(sharedMessageReply(liveShare()).createdAt).toBe(MESSAGE_CREATED_AT);
    });

    it('joins the text items in their given order into one answer', () => {
      const share = liveShare([
        textItem({ position: 0, content: 'First, ' }),
        textItem({ position: 1, content: 'then second.' }),
      ]);
      expect(sharedMessageReply(share).content).toBe('First, then second.');
    });

    it('leaves media items out of the answer text', () => {
      const share = liveShare([textItem({ content: 'Caption.' }), mediaItem()]);
      expect(sharedMessageReply(share).content).toBe('Caption.');
    });

    it('sets no deleted flag on a live reply', () => {
      expect(sharedMessageReply(liveShare())).not.toHaveProperty('deleted');
    });

    it('names the first model any item recorded', () => {
      const share = liveShare([
        textItem({ position: 0, modelName: null }),
        mediaItem({ position: 1, modelName: 'openai/gpt-image-1' }),
      ]);
      expect(sharedMessageReply(share).modelName).toBe('openai/gpt-image-1');
    });

    it('names no model when no item recorded one', () => {
      expect(sharedMessageReply(liveShare()).modelName).toBeNull();
    });

    it('marks the reply Smart when any item was routed', () => {
      const share = liveShare([textItem(), mediaItem({ isSmartModel: true })]);
      expect(sharedMessageReply(share).isSmartModel).toBe(true);
    });

    it('leaves the Smart flag absent when no item was routed', () => {
      expect(sharedMessageReply(liveShare())).not.toHaveProperty('isSmartModel');
    });

    it('sums the reasoning tokens the text items recorded', () => {
      const share = liveShare([
        textItem({ position: 0, reasoningTokens: 120 }),
        textItem({ position: 1, reasoningTokens: 30 }),
      ]);
      expect(sharedMessageReply(share).reasoningTokens).toBe(150);
    });

    it('leaves the reasoning token count absent when it sums to zero', () => {
      const share = liveShare([textItem({ reasoningTokens: 0 })]);
      expect(sharedMessageReply(share)).not.toHaveProperty('reasoningTokens');
    });

    it('takes the first reasoning level a text item recorded', () => {
      const share = liveShare([
        textItem({ position: 0, reasoningEffort: null }),
        textItem({ position: 1, reasoningEffort: 'high' }),
      ]);
      expect(sharedMessageReply(share).reasoningEffort).toBe('high');
    });

    it('keeps a level resolved to off', () => {
      const share = liveShare([textItem({ reasoningEffort: 'off' })]);
      expect(sharedMessageReply(share).reasoningEffort).toBe('off');
    });

    it('leaves the reasoning level absent when none was recorded', () => {
      expect(sharedMessageReply(liveShare())).not.toHaveProperty('reasoningEffort');
    });

    it('sums the reasoning durations the text items recorded', () => {
      const share = liveShare([
        textItem({ position: 0, reasoningDurationMs: 1500 }),
        textItem({ position: 1, reasoningDurationMs: 500 }),
      ]);
      expect(sharedMessageReply(share).reasoningDurationMs).toBe(2000);
    });

    it('leaves the reasoning duration absent when none was recorded', () => {
      expect(sharedMessageReply(liveShare())).not.toHaveProperty('reasoningDurationMs');
    });

    it("carries the message's epoch wrap as base64", () => {
      expect(sharedMessageReply(liveShare()).wrappedContentKey).toBe(toBase64(epochWrap));
    });

    it('maps each media item to a media row carrying its share-minted download URL', () => {
      const share = liveShare([
        textItem({ position: 0 }),
        mediaItem({
          position: 1,
          contentItemId: 'ci-video-1',
          contentType: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 4096,
          width: 1280,
          height: 720,
          durationMs: 8000,
          downloadUrl: 'https://media.example/video-share-minted',
        }),
      ]);
      expect(sharedMessageReply(share).mediaItems).toEqual([
        {
          id: 'ci-video-1',
          position: 1,
          contentType: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 4096,
          width: 1280,
          height: 720,
          durationMs: 8000,
          downloadUrl: 'https://media.example/video-share-minted',
        },
      ]);
    });

    it('leaves the media rows absent when the share has no media', () => {
      expect(sharedMessageReply(liveShare())).not.toHaveProperty('mediaItems');
    });
  });

  describe('a share whose message was deleted', () => {
    it("takes the message's id from the share's message id", () => {
      expect(sharedMessageReply(deletedShare()).id).toBe(MESSAGE_ID);
    });

    it("takes the share's conversation id", () => {
      expect(sharedMessageReply(deletedShare()).conversationId).toBe(CONVERSATION_ID);
    });

    it('is an assistant reply', () => {
      expect(sharedMessageReply(deletedShare()).role).toBe('assistant');
    });

    it('is marked deleted', () => {
      expect(sharedMessageReply(deletedShare()).deleted).toBe(true);
    });

    it('has empty content', () => {
      expect(sharedMessageReply(deletedShare()).content).toBe('');
    });

    it("is dated by the message's own creation, not the share's", () => {
      expect(sharedMessageReply(deletedShare()).createdAt).toBe(MESSAGE_CREATED_AT);
    });
  });

  // The share read serves none of these, so the reply's footer draws no cost pill or
  // token counts and no "replying to" line for a public reader.
  const WITHHELD_FIELDS = [
    'cost',
    'inputTokens',
    'outputTokens',
    'parentMessageId',
    'batchId',
    'errorCode',
  ] as const;

  it.each(WITHHELD_FIELDS)('sets no %s on a live reply', (field) => {
    const share = liveShare([
      textItem({ reasoningTokens: 50, reasoningEffort: 'low', reasoningDurationMs: 900 }),
      mediaItem({ modelName: 'openai/gpt-image-1', isSmartModel: true }),
    ]);
    expect(sharedMessageReply(share)).not.toHaveProperty(field);
  });

  it.each(WITHHELD_FIELDS)('sets no %s on a deleted reply', (field) => {
    expect(sharedMessageReply(deletedShare())).not.toHaveProperty(field);
  });
});
