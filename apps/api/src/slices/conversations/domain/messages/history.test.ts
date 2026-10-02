import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { okAsync } from '../../../../lib/result/index.js';
import { getMessageHistory } from './history.js';
import { fakeStores, memberRecord } from '../test-fixtures.js';
import type { ContentItemRow, HistoryMessageRow } from '../../ports/index.js';

function contentItemRow(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id: 'ci-1',
    messageId: 'msg-1',
    position: 0,
    contentType: 'text',
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    encryptedBlob: new Uint8Array([1, 2, 3]),
    costNanoUsd: null,
    modelId: null,
    isSmartModel: false,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  };
}

const MESSAGE_CREATED_AT = new Date(TEST_DAY_START);

function historyRow(items: ContentItemRow[]): HistoryMessageRow {
  return {
    id: 'msg-1',
    parentMessageId: null,
    sequenceNumber: 1,
    epochNumber: 1,
    senderType: 'assistant',
    senderId: null,
    wrappedContentKey: new Uint8Array([9]),
    batchId: 'batch-1',
    deletedAt: null,
    createdAt: MESSAGE_CREATED_AT,
    contentItems: items,
  };
}

function historyStores(items: ContentItemRow[]): ReturnType<typeof fakeStores> {
  return fakeStores({
    members: { activeByUser: () => okAsync(memberRecord({ visibleFromEpoch: 1 })) },
    messages: { history: () => okAsync([historyRow(items)]) },
  });
}

describe('getMessageHistory view validation', () => {
  it('rejects a fractional sequence number the view schema declares integral (a defect)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ visibleFromEpoch: 1 })) },
      messages: {
        history: () => okAsync([{ ...historyRow([contentItemRow()]), sequenceNumber: 1.5 }]),
      },
    });
    await expect(
      getMessageHistory(stores, {
        conversationId: 'c1',
        caller: { kind: 'user', userId: 'owner' },
      })
    ).rejects.toThrow(ZodError);
  });
});

describe('getMessageHistory message projection', () => {
  it('serves the message creation instant as an ISO string', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messages[0]?.createdAt).toBe(MESSAGE_CREATED_AT.toISOString());
  });
});

describe('getMessageHistory content-item projection', () => {
  it('surfaces the billed cost, model name, and smart-model flag for an AI content item', async () => {
    const stores = historyStores([
      contentItemRow({ costNanoUsd: 1_360_000n, modelId: 'anthropic/claude', isSmartModel: true }),
    ]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.cost).toBe('1360000');
    expect(item?.modelName).toBe('anthropic/claude');
    expect(item?.isSmartModel).toBe(true);
  });

  it('serves a link guest a null cost for a billed content item', async () => {
    const stores = fakeStores({
      members: {
        activeLinkGuest: () =>
          okAsync({
            member: memberRecord({ userId: null, linkId: 'l1', privilege: 'read' }),
            publicKey: new Uint8Array(32),
            displayName: null,
          }),
      },
      messages: {
        history: () => okAsync([historyRow([contentItemRow({ costNanoUsd: 1_360_000n })])]),
      },
    });
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'linkGuest', linkId: 'l1', conversationId: 'c1' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messages[0]?.contentItems[0]?.cost).toBeNull();
  });

  it('serves a link guest null token counts for a billed content item', async () => {
    const stores = fakeStores({
      members: {
        activeLinkGuest: () =>
          okAsync({
            member: memberRecord({ userId: null, linkId: 'l1', privilege: 'read' }),
            publicKey: new Uint8Array(32),
            displayName: null,
          }),
      },
      messages: {
        history: () =>
          okAsync([historyRow([contentItemRow({ inputTokens: 10, outputTokens: 20 })])]),
      },
    });
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'linkGuest', linkId: 'l1', conversationId: 'c1' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.inputTokens).toBeNull();
    expect(item?.outputTokens).toBeNull();
  });

  it('surfaces the input and output token counts for an AI content item', async () => {
    const stores = historyStores([contentItemRow({ inputTokens: 10, outputTokens: 20 })]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.inputTokens).toBe(10);
    expect(item?.outputTokens).toBe(20);
  });

  it('serializes missing token counts as null', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.inputTokens).toBeNull();
    expect(item?.outputTokens).toBeNull();
  });

  it('serializes a null cost/model as null and defaults the smart flag to false', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.cost).toBeNull();
    expect(item?.modelName).toBeNull();
    expect(item?.isSmartModel).toBe(false);
  });

  it('surfaces the persisted reasoning token count for an AI content item', async () => {
    const stores = historyStores([contentItemRow({ reasoningTokens: 1204 })]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messages[0]?.contentItems[0]?.reasoningTokens).toBe(1204);
  });

  it('serializes a missing reasoning token count as null', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messages[0]?.contentItems[0]?.reasoningTokens).toBeNull();
  });

  it('serves the recorded reasoning time of an AI content item', async () => {
    const stores = historyStores([contentItemRow({ reasoningDurationMs: 14_000 })]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messages[0]?.contentItems[0]?.reasoningDurationMs).toBe(14_000);
  });

  it('serves an unrecorded reasoning time as null', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    expect(view.messages[0]?.contentItems[0]?.reasoningDurationMs).toBeNull();
  });

  it('surfaces persisted pixel dimensions and duration for a media content item', async () => {
    const stores = historyStores([
      contentItemRow({
        contentType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: 4096,
        width: 1920,
        height: 1080,
        durationMs: 5000,
      }),
    ]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.width).toBe(1920);
    expect(item?.height).toBe(1080);
    expect(item?.durationMs).toBe(5000);
  });

  it('serializes null dimensions and duration for a non-media content item', async () => {
    const stores = historyStores([contentItemRow()]);
    const result = await getMessageHistory(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'owner' },
    });
    const view = result._unsafeUnwrap();
    if ('refusal' in view) throw new Error('unexpected refusal');
    const item = view.messages[0]?.contentItems[0];
    expect(item?.width).toBeNull();
    expect(item?.height).toBeNull();
    expect(item?.durationMs).toBeNull();
  });
});
