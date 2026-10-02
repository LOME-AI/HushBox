import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateKeyPair,
  createFirstEpoch,
  unwrapContentKeyFromEpoch,
  decryptContentEnvelope,
  decryptTextFromEpoch,
  asEpochPrivateKey,
  verifyKeyChain,
  type KeyPair,
  type WrappedSecret,
} from '@hushbox/crypto';
import {
  fromBase64,
  toBase64,
  getSpendableResponseSchema,
  keyChainResponseSchema,
  listConversationsResponseSchema,
} from '@hushbox/shared';
import { DemoBackendStore } from './store';
import { DEMO_CONVERSATIONS, DEMO_BOOT_ID, DEMO_GROUP_MODEL_ID, DEMO_USER } from './fixtures';
import { DEMO_SCENE_IMAGE, DEMO_GENERATED_VIDEO } from './media-assets';

/** The epoch key the account holds for a conversation, verified through the served keychain. */
function verifiedEpochKey(
  store: DemoBackendStore,
  account: KeyPair,
  conversationId: string,
  epochNumber: number
): Uint8Array {
  const keyChain = store.getKeyChain(conversationId);
  if (keyChain === undefined) throw new Error('no keychain');
  const epochKey = verifyKeyChain(keyChain, account.privateKey, conversationId).keys.get(
    epochNumber
  );
  if (epochKey === undefined) throw new Error('no epoch key');
  return epochKey;
}

/**
 * The new-chat request body: the client makes the first epoch and sends its
 * public record and the owner's wrap, keeping the private key.
 */
function newChatRequest(
  account: KeyPair,
  id: string
): {
  epochPrivateKey: Uint8Array;
  request: { id: string; epochPublicKey: string; confirmationHash: string; memberWrap: string };
} {
  const epoch = createFirstEpoch([account.publicKey], id, 1);
  const ownerWrap = epoch.memberWraps[0];
  if (ownerWrap === undefined) throw new Error('no owner wrap');
  return {
    epochPrivateKey: epoch.epochPrivateKey,
    request: {
      id,
      epochPublicKey: toBase64(epoch.epochPublicKey),
      confirmationHash: toBase64(epoch.confirmationHash),
      memberWrap: toBase64(ownerWrap.wrap),
    },
  };
}

function decryptMessageTexts(
  store: DemoBackendStore,
  account: KeyPair,
  conversationId: string
): { senderType: string; text: string }[] {
  const messages = store.getMessages(conversationId);
  if (messages === undefined) throw new Error('no conversation');
  return messages.map((message) => {
    const epochKey = verifiedEpochKey(store, account, conversationId, message.epochNumber);
    const wrapped = fromBase64(message.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
    const senderId = message.senderId ?? '';
    const text = message.contentItems
      .filter((item) => item.contentType === 'text' && item.encryptedBlob !== null)
      .map((item) =>
        new TextDecoder().decode(
          decryptContentEnvelope(
            contentKey,
            wrapped,
            {
              conversationId,
              messageId: message.id,
              contentItemId: item.id,
              position: item.position,
              epochNumber: message.epochNumber,
              senderId,
            },
            fromBase64(item.encryptedBlob ?? '')
          )
        )
      )
      .join('');
    return { senderType: message.senderType, text };
  });
}

/** The served creation instants of a conversation and of its messages, in sequence order. */
function servedInstants(
  store: DemoBackendStore,
  conversationId: string
): { conversationMs: number; messageMs: number[] } {
  const conversation = store.getConversation(conversationId);
  const messages = store.getMessages(conversationId);
  if (conversation === undefined || messages === undefined) throw new Error('no conversation');
  if (messages.length === 0) throw new Error('no messages to date');
  const ordered = messages.toSorted((a, b) => a.sequenceNumber - b.sequenceNumber);
  return {
    conversationMs: Date.parse(conversation.conversation.createdAt),
    messageMs: ordered.map((message) => Date.parse(message.createdAt)),
  };
}

function isNonDecreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value >= (values[index - 1] ?? value));
}

describe('DemoBackendStore', () => {
  let account: KeyPair;
  let store: DemoBackendStore;

  beforeEach(() => {
    account = generateKeyPair();
    store = new DemoBackendStore(account.publicKey);
  });

  it('lists one schema-valid conversation per fixture with a decryptable title', () => {
    const list = store.listConversations();
    expect(() => listConversationsResponseSchema.parse(list)).not.toThrow();
    expect(list.conversations).toHaveLength(DEMO_CONVERSATIONS.length);
    expect(list.nextCursor).toBeNull();

    for (const item of list.conversations) {
      const epochKey = verifiedEpochKey(store, account, item.id, item.titleEpochNumber);
      const title = decryptTextFromEpoch(epochKey, fromBase64(item.title), {
        conversationId: item.id,
        epochNumber: item.titleEpochNumber,
      });
      const fixture = DEMO_CONVERSATIONS.find((c) => c.id === item.id);
      expect(title).toBe(fixture?.title);
      expect(item.privilege).toBe('owner');
      expect(item.accepted).toBe(true);
    }
  });

  it('serves every conversation empty (scripted + group are replayed live)', () => {
    for (const fixture of DEMO_CONVERSATIONS) {
      expect(store.getMessages(fixture.id)).toHaveLength(0);
      expect(decryptMessageTexts(store, account, fixture.id)).toHaveLength(0);
    }
  });

  it('attributes a smart-model script reply to the selected model, keeping the Smart chip', () => {
    const id = 'demo-smart-model';
    // The reply is attributed to the model the send selected (D-D), not a
    // per-fixture constant; `isSmartModel` still comes from the fixture turn.
    store.recordSendTurn(id, { content: 'hi' }, 'anthropic/claude-opus-4');
    const aiMessage = store.getMessages(id)?.find((m) => m.senderType === 'assistant');
    if (aiMessage === undefined) throw new Error('no ai message');
    const aiItem = aiMessage.contentItems[0];
    expect(aiItem?.isSmartModel).toBe(true);
    expect(aiItem?.modelName).toBe('anthropic/claude-opus-4');
  });

  it('carries seeded cost and selected-model attribution through the history page', () => {
    const id = DEMO_BOOT_ID;
    store.recordSendTurn(id, { content: 'What is HushBox?' }, 'openai/gpt-5');
    const page = store.getMessagesPage(id);
    if (page === undefined) throw new Error('no page');
    const aiMessage = page.messages.find((m) => m.senderType === 'assistant');
    if (aiMessage === undefined) throw new Error('no ai message');
    const item = aiMessage.contentItems[0];
    // Seeded on the first demo-welcome AI turn; surfaces through getMessagesPage
    // in the shared content-item wire shape the decrypt pipeline reads.
    expect(item?.cost).toBe('1360000');
    expect(item?.modelName).toBe('openai/gpt-5');
    expect(item?.isSmartModel).toBe(false);
  });

  it('anchors the reply cost to the first content item only', () => {
    const id = DEMO_BOOT_ID;
    store.recordSendTurn(id, { content: 'What is HushBox?' }, 'openai/gpt-5');
    const aiMessage = store.getMessages(id)?.find((m) => m.senderType === 'assistant');
    if (aiMessage === undefined) throw new Error('no ai message');
    expect(aiMessage.contentItems[0]?.cost).toBe('1360000');
    for (const item of aiMessage.contentItems.slice(1)) {
      expect(item.cost).toBeNull();
    }
  });

  it('attributes filled (no-picker) replies to the documented constant model', () => {
    const id = DEMO_BOOT_ID;
    store.fillConversation(id);
    const aiMessage = store.getMessages(id)?.find((m) => m.senderType === 'assistant');
    expect(aiMessage?.contentItems[0]?.modelName).toBe(DEMO_GROUP_MODEL_ID);
  });

  it('serves an encrypted image via a same-origin blob URL that decrypts to the original asset', () => {
    store.recordSendTurn('demo-image', { content: 'go' }, 'm');
    const messages = store.getMessages('demo-image');
    if (messages === undefined) throw new Error('no conversation');
    const aiMessage = messages.find((m) => m.senderType === 'assistant');
    if (aiMessage === undefined) throw new Error('no ai message');
    const mediaItem = aiMessage.contentItems.find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');

    expect(mediaItem.mimeType).toBe(DEMO_SCENE_IMAGE.mimeType);
    expect(mediaItem.byteLength).toBe(DEMO_SCENE_IMAGE.bytes.length);
    expect(mediaItem.width).toBe(DEMO_SCENE_IMAGE.width);
    expect(mediaItem.encryptedBlob).toBeNull();

    const presign = store.getMediaDownloadUrl(mediaItem.id);
    if (presign === undefined) throw new Error('no presign');
    // A same-origin path, NOT a data: URL — so the demo CSP `connect-src 'self'`
    // permits the real useDecryptBlob fetch (the shim serves the ciphertext bytes).
    expect(presign.downloadUrl).toBe(`/media/${mediaItem.id}/blob`);

    const epochKey = verifiedEpochKey(store, account, 'demo-image', aiMessage.epochNumber);
    const wrapped = fromBase64(aiMessage.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
    const ciphertext = store.getMediaBytes(mediaItem.id);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: 'demo-image',
        messageId: aiMessage.id,
        contentItemId: mediaItem.id,
        position: mediaItem.position,
        epochNumber: aiMessage.epochNumber,
        senderId: aiMessage.senderId ?? '',
      },
      ciphertext
    );
    expect(toBase64(plaintext)).toBe(toBase64(DEMO_SCENE_IMAGE.bytes));
  });

  it('serves a video content item with duration via a same-origin blob URL that decrypts to the clip', () => {
    store.recordSendTurn('demo-video', { content: 'go' }, 'm');
    const messages = store.getMessages('demo-video');
    if (messages === undefined) throw new Error('no conversation');
    const aiMessage = messages.find((m) => m.senderType === 'assistant');
    if (aiMessage === undefined) throw new Error('no ai message');
    const mediaItem = aiMessage.contentItems.find((item) => item.contentType === 'video');
    if (mediaItem === undefined) throw new Error('no video item');

    expect(mediaItem.mimeType).toBe(DEMO_GENERATED_VIDEO.mimeType);
    expect(mediaItem.durationMs).toBe(DEMO_GENERATED_VIDEO.durationMs);
    expect(mediaItem.byteLength).toBe(DEMO_GENERATED_VIDEO.bytes.length);
    expect(mediaItem.encryptedBlob).toBeNull();

    const presign = store.getMediaDownloadUrl(mediaItem.id);
    if (presign === undefined) throw new Error('no presign');
    expect(presign.downloadUrl).toBe(`/media/${mediaItem.id}/blob`);

    const epochKey = verifiedEpochKey(store, account, 'demo-video', aiMessage.epochNumber);
    const wrapped = fromBase64(aiMessage.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
    const ciphertext = store.getMediaBytes(mediaItem.id);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: 'demo-video',
        messageId: aiMessage.id,
        contentItemId: mediaItem.id,
        position: mediaItem.position,
        epochNumber: aiMessage.epochNumber,
        senderId: aiMessage.senderId ?? '',
      },
      ciphertext
    );
    expect(toBase64(plaintext)).toBe(toBase64(DEMO_GENERATED_VIDEO.bytes));
  });

  it('returns undefined for an unknown media content item id', () => {
    expect(store.getMediaDownloadUrl('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for an unknown conversation id', () => {
    expect(store.getConversation('does-not-exist')).toBeUndefined();
    expect(store.getKeyChain('does-not-exist')).toBeUndefined();
  });

  it('serves a key-chain batch for known ids and reports unknown ids as missing', () => {
    const ids = [...DEMO_CONVERSATIONS.map((c) => c.id), 'unknown-id'];
    const batch = store.getKeyChainBatch(ids);
    for (const fixture of DEMO_CONVERSATIONS) {
      expect(batch.keys[fixture.id]).toBeDefined();
    }
    expect(batch.keys['unknown-id']).toBeUndefined();
    expect(batch.missing).toContain('unknown-id');
  });

  it('serves the conversation detail in the membership wire shape', () => {
    const id = DEMO_CONVERSATIONS[0]!.id;
    const detail = store.getConversation(id);
    if (detail === undefined) throw new Error('expected built conversation');
    expect(detail.membership).toEqual({
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
      lastReadSeq: 0,
      linkId: null,
    });
    expect(detail.conversation.id).toBe(id);
    expect(detail.forks).toEqual([]);
    expect(detail).not.toHaveProperty('messages');
  });

  it('serves the stored transcript as the history page, adapting nothing', () => {
    const id = DEMO_CONVERSATIONS[0]!.id;
    store.fillConversation(id);
    const full = store.getMessages(id);
    const page = store.getMessagesPage(id);
    if (page === undefined || full === undefined) throw new Error('expected built conversation');
    expect(page.nextCursor).toBeNull();
    expect(full.length).toBeGreaterThan(0);
    expect(page.messages).toEqual(full);
    expect(store.getMessagesPage('unknown-id')).toBeUndefined();
  });

  it('serves a positive balance and a single solo member with no links', () => {
    const balance = store.getBalance();
    expect(BigInt(balance.purchased.balanceNanoUsd)).toBeGreaterThan(0n);
    expect(BigInt(balance.free.balanceNanoUsd)).toBe(0n);
    expect(balance.allowance.day).toBe('2026-06-01');
    expect(balance.allowance.remainingNanoUsd).toBe(balance.allowance.limitNanoUsd);
    expect(balance.allowance.spentNanoUsd).toBe('0');

    const members = store.getMembers('demo-smart-model');
    expect(members.members).toHaveLength(1);
    expect(members.members[0]?.userId).toBe(DEMO_USER.id);

    expect(store.getLinks('demo-smart-model').links).toEqual([]);
  });

  it('derives the spendable funding snapshot from the stored balance', () => {
    const balance = store.getBalance();
    expect(getSpendableResponseSchema.parse(store.getSpendable())).toEqual({
      spendableNanoUsd: balance.purchased.balanceNanoUsd,
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'self',
      ownerFundingLimit: null,
    });
  });

  it('reports the stored purchased balance as the owner balance on conversation budgets', () => {
    const budgets = store.getConversationBudgets('demo-group');
    expect(budgets.ownerBalanceNanoUsd).toBe(store.getBalance().purchased.balanceNanoUsd);
    expect(budgets.conversationCapNanoUsd).toBe('0');
    expect(budgets.conversationSpentNanoUsd).toBe('0');
  });

  it('mirrors every conversation member into an uncapped budget row', () => {
    const { members } = store.getMembers('demo-group');
    expect(store.getConversationBudgets('demo-group').members).toEqual(
      members.map((member) => ({
        memberId: member.id,
        userId: member.userId,
        username: member.username,
        privilege: member.privilege,
        capNanoUsd: '0',
        spentNanoUsd: '0',
        effectiveRemainingNanoUsd: '0',
      }))
    );
  });

  it('serves a multi-member roster for the group conversation including the demo user', () => {
    const { members } = store.getMembers('demo-group');
    expect(members.length).toBeGreaterThan(1);
    expect(members.some((m) => m.userId === DEMO_USER.id)).toBe(true);
    expect(members.map((m) => m.username)).toContain('amir');
    for (const m of members) expect(m.linkId).toBeNull();
  });

  it("lists each seeded conversation with its own roster's member count", () => {
    for (const item of store.listConversations().conversations) {
      expect(item.memberCount).toBe(store.getMembers(item.id).members.length);
    }
  });

  it('lists the group conversation with more than one member', () => {
    const group = store.listConversations().conversations.find((c) => c.id === 'demo-group');
    expect(group?.memberCount).toBeGreaterThan(1);
  });

  it('appendNextGroupMessage replays the transcript with decryptable per-participant messages', () => {
    expect(store.isGroupConversation('demo-group')).toBe(true);
    expect(store.isGroupConversation('demo-image')).toBe(false);
    // Group starts empty; drive the whole transcript as the director would.
    expect(store.getMessages('demo-group')).toHaveLength(0);
    while (store.appendNextGroupMessage('demo-group') !== null) {
      /* replay every transcript message */
    }

    const messages = store.getMessages('demo-group');
    if (messages === undefined) throw new Error('no conversation');
    const senderIds = messages.map((m) => m.senderId);
    expect(senderIds).toContain(DEMO_USER.id);
    expect(senderIds).toContain('demo-user-amir');

    const decrypted = decryptMessageTexts(store, account, 'demo-group');
    expect(decrypted).toHaveLength(messages.length);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(decrypted.every((row) => row.text.length > 0)).toBe(true);
  });

  it('group replay shows typing for other members and omits the demo user self-skip', () => {
    // Transcript order (we start the group): demo (own), amir, sana.
    expect(store.peekNextGroupMessage('demo-group')).toEqual({ typingUserId: null });
    const own = store.appendNextGroupMessage('demo-group');
    expect(own?.senderId).toBeUndefined();
    expect(own?.senderType).toBe('user');

    expect(store.peekNextGroupMessage('demo-group')).toEqual({ typingUserId: 'demo-user-amir' });
    const amir = store.appendNextGroupMessage('demo-group');
    expect(amir?.senderId).toBe('demo-user-amir');

    expect(store.peekNextGroupMessage('demo-group')).toEqual({ typingUserId: 'demo-user-sana' });
    store.appendNextGroupMessage('demo-group');
    expect(store.peekNextGroupMessage('demo-group')).toBeNull();
    expect(store.appendNextGroupMessage('demo-group')).toBeNull();
  });

  it('recordSendTurn appends a decryptable user + assistant turn for the refetch', () => {
    const id = 'demo-smart-model';
    const before = store.getMessages(id)?.length ?? 0;
    const turn = store.recordSendTurn(
      id,
      { content: 'Does letting it choose cost me more?' },
      'openai/gpt-4o'
    );
    expect(turn).toBeDefined();

    const decrypted = decryptMessageTexts(store, account, id);
    expect(decrypted).toHaveLength(before + 2);
    expect(decrypted.at(-2)).toEqual({
      senderType: 'user',
      text: 'Does letting it choose cost me more?',
    });
    expect(decrypted.at(-1)?.senderType).toBe('assistant');
    expect(decrypted.at(-1)?.text).toBe(turn?.content);
  });

  it('recordSendTurn stores the user row under an id it mints, and returns that id', () => {
    const id = 'demo-smart-model';
    const turn = store.recordSendTurn(id, { content: 'whose id is this' }, 'm');
    const storedUser = store.getMessages(id)?.findLast((m) => m.senderType === 'user');
    expect(turn?.userMessageId).toEqual(expect.any(String));
    expect(turn?.userMessageId).toBe(storedUser?.id);
  });

  it('recordSendTurn returns undefined for an unknown conversation', () => {
    expect(store.recordSendTurn('nope', { content: 'hi' }, 'm')).toBeUndefined();
  });

  it('recordSendTurn reports media attributes for an image turn', () => {
    const turn = store.recordSendTurn('demo-image', { content: 'go' }, 'm');
    expect(turn?.media).toEqual({ mediaType: 'image', mimeType: DEMO_SCENE_IMAGE.mimeType });
  });

  it('recordSendTurn reports media attributes for a video turn', () => {
    const turn = store.recordSendTurn('demo-video', { content: 'go' }, 'm');
    expect(turn?.media).toEqual({ mediaType: 'video', mimeType: DEMO_GENERATED_VIDEO.mimeType });
  });

  it('recordSendTurn omits media attributes for a text turn', () => {
    const turn = store.recordSendTurn('demo-smart-model', { content: 'hi' }, 'm');
    expect(turn?.media).toBeUndefined();
  });

  it('recordRegenerateTurn swaps the AI reply for a fresh clone under the same user message', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { content: 'hi' }, 'm');
    const before = store.getMessages(id);
    if (before === undefined) throw new Error('no conversation');
    const userMessage = before.find((m) => m.senderType === 'user');
    const oldAi = before.find((m) => m.senderType === 'assistant');
    if (userMessage === undefined || oldAi === undefined) throw new Error('missing messages');
    const beforeCount = before.length;

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      models: ['openai/gpt-4o'],
    });
    if (turn === undefined) throw new Error('no turn');
    expect(turn.userMessageId).toBe(userMessage.id);

    const after = store.getMessages(id);
    if (after === undefined) throw new Error('no after');
    expect(after).toHaveLength(beforeCount);
    expect(after.some((m) => m.id === oldAi.id)).toBe(false);
    const clone = after.find((m) => m.id === turn.assistantMessageId);
    if (clone === undefined) throw new Error('no clone');
    expect(clone.senderType).toBe('assistant');
    expect(clone.parentMessageId).toBe(userMessage.id);
  });

  it("recordRegenerateTurn's clone decrypts to the re-streamed reply text", () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { content: 'hi' }, 'm');
    const userMessage = store.getMessages(id)?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
    });
    if (turn === undefined) throw new Error('no turn');
    expect(turn.content.length).toBeGreaterThan(0);

    const lastRow = decryptMessageTexts(store, account, id).at(-1);
    expect(lastRow?.senderType).toBe('assistant');
    expect(lastRow?.text).toBe(turn.content);
  });

  it('recordRegenerateTurn reports media attributes when regenerating a media reply', () => {
    store.recordSendTurn('demo-image', { content: 'go' }, 'm');
    const userMessage = store.getMessages('demo-image')?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    const turn = store.recordRegenerateTurn({
      conversationId: 'demo-image',
      targetMessageId: userMessage.id,
    });
    expect(turn?.media).toEqual({ mediaType: 'image', mimeType: DEMO_SCENE_IMAGE.mimeType });
  });

  it('recordRegenerateTurn tolerates a user-message target, filling defaults from the lenient mock', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { content: 'hi' }, 'openai/gpt-4o');
    const userMessage = store.getMessages(id)?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    // The first user message has a null parent, no registered AI text/content, and no
    // model on its content item — every regenerate fallback path is exercised here.
    expect(userMessage.parentMessageId).toBeNull();
    expect(userMessage.contentItems[0]?.modelName).toBeNull();

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      replaceAssistantId: userMessage.id,
    });
    if (turn === undefined) throw new Error('no turn');

    // parentMessageId null → falls back to the request's targetMessageId.
    expect(turn.userMessageId).toBe(userMessage.id);
    // No models supplied and no modelName on the target → the default model id.
    expect(turn.modelId).toBe('demo-model');
    // No AI text/content is registered for a user message → an empty clone.
    expect(turn.content).toBe('');
    expect(turn.media).toBeUndefined();

    const clone = store.getMessages(id)?.find((m) => m.id === turn.assistantMessageId);
    expect(clone?.contentItems).toEqual([]);
  });

  it('recordRegenerateTurn returns undefined for an unknown conversation or message', () => {
    expect(
      store.recordRegenerateTurn({ conversationId: 'nope', targetMessageId: 'x' })
    ).toBeUndefined();
    expect(
      store.recordRegenerateTurn({ conversationId: 'demo-smart-model', targetMessageId: 'no-user' })
    ).toBeUndefined();
  });

  it('createConversation registers a new chat whose turn the client epoch key decrypts', () => {
    const { epochPrivateKey, request } = newChatRequest(account, 'new-1');
    const created = store.createConversation({ ...request, title: '' });
    expect(created.created).toBe(true);

    const turn = store.recordSendTurn('new-1', { content: 'hello there' }, 'some-model');
    expect(turn).toBeDefined();

    const messages = store.getMessages('new-1');
    if (messages === undefined) throw new Error('no conversation');
    expect(messages).toHaveLength(2);
    const userMessage = messages[0];
    if (userMessage === undefined) throw new Error('no user message');
    const wrapped = fromBase64(userMessage.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochPrivateKey), wrapped);
    const contentItem = userMessage.contentItems[0];
    if (contentItem === undefined) throw new Error('no content item');
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: 'new-1',
        messageId: userMessage.id,
        contentItemId: contentItem.id,
        position: contentItem.position,
        epochNumber: userMessage.epochNumber,
        senderId: userMessage.senderId ?? '',
      },
      fromBase64(contentItem.encryptedBlob ?? '')
    );
    expect(new TextDecoder().decode(plaintext)).toBe('hello there');
  });

  it('dates no filled seeded message before its conversation', () => {
    for (const conversation of DEMO_CONVERSATIONS) {
      store.fillConversation(conversation.id);
      const { conversationMs, messageMs } = servedInstants(store, conversation.id);
      expect(Math.min(...messageMs)).toBeGreaterThanOrEqual(conversationMs);
    }
  });

  it('dates filled seeded messages in non-decreasing sequence order', () => {
    for (const conversation of DEMO_CONVERSATIONS) {
      store.fillConversation(conversation.id);
      expect(isNonDecreasing(servedInstants(store, conversation.id).messageMs)).toBe(true);
    }
  });

  it('dates no message of a chat created live before the chat', () => {
    store.createConversation({ ...newChatRequest(account, 'live-dated').request, title: '' });
    store.recordSendTurn('live-dated', { content: 'first' }, 'some-model');
    store.recordSendTurn('live-dated', { content: 'second' }, 'some-model');
    const { conversationMs, messageMs } = servedInstants(store, 'live-dated');
    expect(Math.min(...messageMs)).toBeGreaterThanOrEqual(conversationMs);
  });

  it('dates the messages of a chat created live in non-decreasing sequence order', () => {
    store.createConversation({ ...newChatRequest(account, 'live-ordered').request, title: '' });
    store.recordSendTurn('live-ordered', { content: 'first' }, 'some-model');
    store.recordSendTurn('live-ordered', { content: 'second' }, 'some-model');
    expect(isNonDecreasing(servedInstants(store, 'live-ordered').messageMs)).toBe(true);
  });

  it('lists the boot conversation as a normal sidebar entry', () => {
    const listed = store.listConversations().conversations.map((c) => c.id);
    expect(listed).toContain(DEMO_BOOT_ID);
    expect(listed).toHaveLength(DEMO_CONVERSATIONS.length);
  });

  it('createConversation has no script, so a user-initiated new chat gets the generic reply', () => {
    store.createConversation({ ...newChatRequest(account, 'user-chat').request, title: '' });
    expect(store.getModality('user-chat')).toBeUndefined();
    store.recordSendTurn('user-chat', { content: 'anything' }, 'ignored');
    const aiItem = store.getMessages('user-chat')?.find((m) => m.senderType === 'assistant')
      ?.contentItems[0];
    expect(aiItem?.isSmartModel).toBe(false);
    expect(aiItem?.modelName).toBe('ignored');
  });

  it('getModality reports a scripted conversation modality and undefined for the group', () => {
    expect(store.getModality('demo-image')).toBe('image');
    expect(store.getModality('demo-video')).toBe('video');
    expect(store.getModality('demo-group')).toBeUndefined();
    expect(store.getModality('unknown')).toBeUndefined();
  });

  it('fillConversation builds a scripted conversation straight to its finished state', () => {
    store.fillConversation('demo-smart-model');
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    // Two scripted turns → four messages (user + ai each), no replay needed.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.senderType)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
  });

  it('fillConversation with a limit fills only the first N turns and advances the cursor by N', () => {
    store.fillConversation('demo-smart-model', 1);
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    // One scripted turn filled → two messages (user + ai); the second turn remains.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.senderType)).toEqual(['user', 'assistant']);
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'What if I want to choose the model myself?'
    );
  });

  it('fillConversation with a limit leaves the next turn to stream live via recordSendTurn', () => {
    store.fillConversation('demo-smart-model', 1);
    store.recordSendTurn(
      'demo-smart-model',
      { content: 'What if I want to choose the model myself?' },
      'm'
    );
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    expect(rows).toHaveLength(4);
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
  });

  it('fillConversation with limit 0 fills nothing and leaves the cursor at the start', () => {
    store.fillConversation('demo-smart-model', 0);
    expect(store.getMessages('demo-smart-model')).toHaveLength(0);
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'There are so many AI models. How do I know which one to use?'
    );
  });

  it('fillConversation with a limit beyond the script length fills the whole script', () => {
    store.fillConversation('demo-smart-model', 99);
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    expect(rows).toHaveLength(4);
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
  });

  it('fillConversation builds the group transcript in one shot', () => {
    store.fillConversation('demo-group');
    const rows = decryptMessageTexts(store, account, 'demo-group');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.text).toContain('Welcome to the group');
  });

  it('peekNextGroupText returns the demo user opener for the welcome lead-in', () => {
    expect(store.peekNextGroupText('demo-group')).toBe(
      'Welcome to the group! This is a shared chat we can all use together, with AI right here in it.'
    );
    expect(store.peekNextGroupText('demo-image')).toBeNull();
    expect(store.peekNextGroupText('unknown')).toBeNull();
  });

  it('getMembers falls back to the solo member for an unknown conversation', () => {
    const { members } = store.getMembers('does-not-exist');
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(DEMO_USER.id);
  });

  it('resetConversation and fillConversation are no-ops for an unknown conversation', () => {
    expect(() => {
      store.resetConversation('does-not-exist');
    }).not.toThrow();
    expect(() => {
      store.fillConversation('does-not-exist');
    }).not.toThrow();
    expect(store.getMessages('does-not-exist')).toBeUndefined();
  });

  it('recordRegenerateTurn matches by replaceAssistantId when given one', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { content: 'hi' }, 'm');
    const before = store.getMessages(id);
    if (before === undefined) throw new Error('no conversation');
    const userMessage = before.find((m) => m.senderType === 'user');
    const oldAi = before.find((m) => m.senderType === 'assistant');
    if (userMessage === undefined || oldAi === undefined) throw new Error('missing messages');

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      replaceAssistantId: oldAi.id,
    });
    if (turn === undefined) throw new Error('no turn');

    const after = store.getMessages(id);
    if (after === undefined) throw new Error('no after');
    // The specific assistant referenced by replaceAssistantId is swapped for the clone.
    expect(after.some((m) => m.id === oldAi.id)).toBe(false);
    expect(after.some((m) => m.id === turn.assistantMessageId)).toBe(true);
  });

  it('createConversation defaults the title to an empty string when none is given', () => {
    const created = store.createConversation(newChatRequest(account, 'no-title').request);
    expect(created.conversation.title).toBe('');
  });

  it('createConversation serves a keychain the shared response schema accepts', () => {
    store.createConversation(newChatRequest(account, 'new-schema').request);

    expect(keyChainResponseSchema.safeParse(store.getKeyChain('new-schema')).success).toBe(true);
  });

  it('createConversation serves a keychain that verifies to the client-made epoch key', () => {
    const { epochPrivateKey, request } = newChatRequest(account, 'new-verified');
    store.createConversation(request);

    expect(verifiedEpochKey(store, account, 'new-verified', 1)).toEqual(epochPrivateKey);
  });

  it('serves a fixture keychain the shared response schema accepts', () => {
    for (const fixture of DEMO_CONVERSATIONS) {
      expect(keyChainResponseSchema.safeParse(store.getKeyChain(fixture.id)).success).toBe(true);
    }
  });

  it('peekNextUserText returns the next scripted prompt and null once the script is exhausted', () => {
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'There are so many AI models. How do I know which one to use?'
    );
    store.recordSendTurn('demo-smart-model', { content: 'x' }, 'm');
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'What if I want to choose the model myself?'
    );
    store.recordSendTurn('demo-smart-model', { content: 'y' }, 'm');
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
    expect(store.peekNextUserText('demo-group')).toBeNull();
    expect(store.peekNextUserText('unknown')).toBeNull();
  });
});
