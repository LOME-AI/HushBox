import { describe, it, expect } from 'vitest';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  rotationSchema,
  conversationResponseSchema,
  conversationListItemSchema,
  messageResponseSchema,
  listConversationsResponseSchema,
  getConversationResponseSchema,
  createConversationResponseSchema,
  updateConversationResponseSchema,
  deleteConversationResponseSchema,
  streamChatRequestSchema,
} from './conversations.js';

// ============================================================
// Deleted schemas — verify they no longer exist
// ============================================================

describe('deleted schemas', () => {
  it('createMessageRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('createMessageRequestSchema' in module_).toBe(false);
  });

  it('CreateMessageRequest type is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('CreateMessageRequest' in module_).toBe(false);
  });

  it('finalizeMessageRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('finalizeMessageRequestSchema' in module_).toBe(false);
  });

  it('FinalizeMessageRequest type is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('FinalizeMessageRequest' in module_).toBe(false);
  });

  it('createMessageResponseSchema is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('createMessageResponseSchema' in module_).toBe(false);
  });

  it('CreateMessageResponse type is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('CreateMessageResponse' in module_).toBe(false);
  });
});

// ============================================================
// createConversationRequestSchema — epoch fields
// ============================================================

describe('createConversationRequestSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid request with all epoch fields', () => {
    const result = createConversationRequestSchema.parse({
      id: validId,
      title: 'base64encodedencryptedtitle',
      epochPublicKey: 'base64epochpubkey',
      confirmationHash: 'base64confirmhash',
      memberWrap: 'base64memberwrap',
    });
    expect(result.id).toBe(validId);
    expect(result.title).toBe('base64encodedencryptedtitle');
    expect(result.epochPublicKey).toBe('base64epochpubkey');
    expect(result.confirmationHash).toBe('base64confirmhash');
    expect(result.memberWrap).toBe('base64memberwrap');
  });

  it('accepts without title (optional)', () => {
    const result = createConversationRequestSchema.parse({
      id: validId,
      epochPublicKey: 'base64epochpubkey',
      confirmationHash: 'base64confirmhash',
      memberWrap: 'base64memberwrap',
    });
    expect(result.title).toBeUndefined();
  });

  it('requires id field', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('rejects invalid UUID', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: 'not-a-uuid',
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('requires epochPublicKey', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('rejects empty epochPublicKey', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: '',
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('requires confirmationHash', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('rejects empty confirmationHash', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: '',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('requires memberWrap', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
      })
    ).toThrow();
  });

  it('rejects empty memberWrap', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
        memberWrap: '',
      })
    ).toThrow();
  });
});

// ============================================================
// updateConversationRequestSchema — unchanged
// ============================================================

describe('updateConversationRequestSchema', () => {
  it('accepts valid encrypted title with titleEpochNumber', () => {
    const result = updateConversationRequestSchema.parse({
      title: 'base64encryptedtitle',
      titleEpochNumber: 3,
    });
    expect(result.title).toBe('base64encryptedtitle');
    expect(result.titleEpochNumber).toBe(3);
  });

  it('rejects empty title', () => {
    expect(() =>
      updateConversationRequestSchema.parse({ title: '', titleEpochNumber: 1 })
    ).toThrow();
  });

  it('rejects missing title', () => {
    expect(() => updateConversationRequestSchema.parse({ titleEpochNumber: 1 })).toThrow();
  });

  it('rejects missing titleEpochNumber', () => {
    expect(() => updateConversationRequestSchema.parse({ title: 'enc' })).toThrow();
  });

  it('rejects non-positive titleEpochNumber', () => {
    expect(() =>
      updateConversationRequestSchema.parse({ title: 'enc', titleEpochNumber: 0 })
    ).toThrow();
  });
});

// ============================================================
// rotationSchema — epoch rotation data
// ============================================================

describe('rotationSchema', () => {
  const validRotation = {
    expectedEpoch: 1,
    epochPublicKey: 'base64epochpubkey',
    confirmationHash: 'base64confirmhash',
    chainLink: 'base64chainlink',
    memberWraps: [
      {
        memberPublicKey: 'base64memberpubkey',
        wrap: 'base64wrap',
      },
    ],
    encryptedTitle: 'base64encryptedtitle',
  };

  it('accepts valid rotation with memberWraps containing only memberPublicKey and wrap', () => {
    const result = rotationSchema.parse(validRotation);
    expect(result.expectedEpoch).toBe(1);
    expect(result.memberWraps).toHaveLength(1);
    expect(result.memberWraps[0]!.memberPublicKey).toBe('base64memberpubkey');
    expect(result.memberWraps[0]!.wrap).toBe('base64wrap');
  });

  it('rejects empty memberWraps array', () => {
    expect(() => rotationSchema.parse({ ...validRotation, memberWraps: [] })).toThrow();
  });

  it('requires memberPublicKey in memberWraps', () => {
    expect(() =>
      rotationSchema.parse({
        ...validRotation,
        memberWraps: [{ wrap: 'base64wrap' }],
      })
    ).toThrow();
  });

  it('requires wrap in memberWraps', () => {
    expect(() =>
      rotationSchema.parse({
        ...validRotation,
        memberWraps: [{ memberPublicKey: 'base64memberpubkey' }],
      })
    ).toThrow();
  });

  it('strips visibleFromEpoch from memberWraps (no longer part of wire format)', () => {
    const result = rotationSchema.parse({
      ...validRotation,
      memberWraps: [
        {
          memberPublicKey: 'base64memberpubkey',
          wrap: 'base64wrap',
          visibleFromEpoch: 1,
        },
      ],
    });
    // Zod strips unknown keys — visibleFromEpoch should not be present
    expect('visibleFromEpoch' in result.memberWraps[0]!).toBe(false);
  });
});

// ============================================================
// streamChatRequestSchema — plaintext user message
// ============================================================

describe('streamChatRequestSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';
  const validMsgId = '550e8400-e29b-41d4-a716-446655440001';

  it('accepts valid stream request with plaintext user message', () => {
    const result = streamChatRequestSchema.parse({
      conversationId: validId,
      model: 'gpt-4',
      userMessage: {
        id: validMsgId,
        content: 'Hello, how are you?',
      },
      messagesForInference: [{ role: 'user', content: 'Hello, how are you?' }],
      fundingSource: 'personal_balance',
    });
    expect(result.conversationId).toBe(validId);
    expect(result.model).toBe('gpt-4');
    expect(result.userMessage.id).toBe(validMsgId);
    expect(result.userMessage.content).toBe('Hello, how are you?');
    expect(result.messagesForInference).toHaveLength(1);
  });

  it('requires at least one message for inference', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: validId,
        model: 'gpt-4',
        userMessage: {
          id: validMsgId,
          content: 'Hello',
        },
        messagesForInference: [],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('accepts multiple messages for inference', () => {
    const result = streamChatRequestSchema.parse({
      conversationId: validId,
      model: 'gpt-4',
      userMessage: {
        id: validMsgId,
        content: 'How are you?',
      },
      messagesForInference: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' },
      ],
      fundingSource: 'personal_balance',
    });
    expect(result.messagesForInference).toHaveLength(3);
  });

  it('rejects non-UUID conversationId', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: 'not-a-uuid',
        model: 'gpt-4',
        userMessage: {
          id: validMsgId,
          content: 'Hello',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects missing conversationId', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        model: 'gpt-4',
        userMessage: {
          id: validMsgId,
          content: 'Hello',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects missing model', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: validId,
        userMessage: {
          id: validMsgId,
          content: 'Hello',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects empty user message content', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: validId,
        model: 'gpt-4',
        userMessage: {
          id: validMsgId,
          content: '',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects missing user message content', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: validId,
        model: 'gpt-4',
        userMessage: {
          id: validMsgId,
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('accepts valid fundingSource values', () => {
    const validId = '550e8400-e29b-41d4-a716-446655440000';
    const validMsgId = '550e8400-e29b-41d4-a716-446655440001';
    const base = {
      conversationId: validId,
      model: 'gpt-4',
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user' as const, content: 'Hello' }],
    };

    for (const source of ['owner_balance', 'personal_balance', 'free_allowance', 'guest_fixed']) {
      const result = streamChatRequestSchema.parse({ ...base, fundingSource: source });
      expect(result.fundingSource).toBe(source);
    }
  });

  it('rejects missing fundingSource (required)', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        model: 'gpt-4',
        userMessage: { id: '550e8400-e29b-41d4-a716-446655440001', content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
      })
    ).toThrow();
  });

  it('rejects invalid fundingSource value', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        model: 'gpt-4',
        userMessage: { id: '550e8400-e29b-41d4-a716-446655440001', content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'invalid_source',
      })
    ).toThrow();
  });

  it('does not accept contentEncrypted or iv on userMessage', () => {
    const result = streamChatRequestSchema.parse({
      conversationId: validId,
      model: 'gpt-4',
      userMessage: {
        id: validMsgId,
        content: 'Hello',
        contentEncrypted: 'should-be-stripped',
        iv: 'should-be-stripped',
      },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    // Zod strips unknown keys by default
    expect('contentEncrypted' in result.userMessage).toBe(false);
    expect('iv' in result.userMessage).toBe(false);
  });
});

// ============================================================
// Response Schema Tests
// ============================================================

describe('conversationResponseSchema', () => {
  it('accepts valid conversation with epoch fields', () => {
    const result = conversationResponseSchema.parse({
      id: 'conv-123',
      userId: 'user-456',
      title: 'base64encryptedtitle',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 3,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    });
    expect(result.id).toBe('conv-123');
    expect(result.userId).toBe('user-456');
    expect(result.title).toBe('base64encryptedtitle');
    expect(result.currentEpoch).toBe(1);
    expect(result.titleEpochNumber).toBe(1);
    expect(result.nextSequence).toBe(3);
  });

  it('rejects missing currentEpoch', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        titleEpochNumber: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing titleEpochNumber', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing nextSequence', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        titleEpochNumber: 1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects zero currentEpoch', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 0,
        titleEpochNumber: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects negative nextSequence', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: -1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects non-integer epoch values', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1.5,
        titleEpochNumber: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
      })
    ).toThrow();
  });
});

describe('messageResponseSchema', () => {
  it('accepts valid epoch-based message', () => {
    const result = messageResponseSchema.parse({
      id: 'msg-123',
      conversationId: 'conv-456',
      encryptedBlob: 'base64eciesblob',
      senderType: 'user',
      senderId: 'user-789',
      senderDisplayName: 'Alice',
      payerId: null,
      cost: null,
      epochNumber: 1,
      sequenceNumber: 0,
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(result.id).toBe('msg-123');
    expect(result.encryptedBlob).toBe('base64eciesblob');
    expect(result.senderType).toBe('user');
    expect(result.senderId).toBe('user-789');
    expect(result.senderDisplayName).toBe('Alice');
    expect(result.payerId).toBeNull();
    expect(result.cost).toBeNull();
    expect(result.epochNumber).toBe(1);
    expect(result.sequenceNumber).toBe(0);
  });

  it('accepts AI message with null senderId and payerId', () => {
    const result = messageResponseSchema.parse({
      id: 'msg-124',
      conversationId: 'conv-456',
      encryptedBlob: 'base64airesponseblob',
      senderType: 'ai',
      senderId: null,
      senderDisplayName: null,
      payerId: 'user-789',
      cost: '0.00136000',
      epochNumber: 1,
      sequenceNumber: 1,
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(result.senderType).toBe('ai');
    expect(result.senderId).toBeNull();
    expect(result.senderDisplayName).toBeNull();
    expect(result.payerId).toBe('user-789');
    expect(result.cost).toBe('0.00136000');
  });

  it('accepts message with null cost (user messages)', () => {
    const result = messageResponseSchema.parse({
      id: 'msg-125',
      conversationId: 'conv-456',
      encryptedBlob: 'base64blob',
      senderType: 'user',
      senderId: 'user-789',
      senderDisplayName: null,
      payerId: null,
      cost: null,
      epochNumber: 1,
      sequenceNumber: 0,
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(result.cost).toBeNull();
  });

  it('rejects invalid senderType', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'system',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 1,
        sequenceNumber: 0,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing encryptedBlob', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 1,
        sequenceNumber: 0,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects non-integer epochNumber', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 1.5,
        sequenceNumber: 0,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects non-integer sequenceNumber', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 1,
        sequenceNumber: 0.5,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing epochNumber', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        sequenceNumber: 0,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects zero epochNumber', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 0,
        sequenceNumber: 0,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects negative sequenceNumber', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 1,
        sequenceNumber: -1,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing sequenceNumber', () => {
    expect(() =>
      messageResponseSchema.parse({
        id: 'msg-123',
        conversationId: 'conv-456',
        encryptedBlob: 'base64eciesblob',
        senderType: 'user',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        cost: null,
        epochNumber: 1,
        createdAt: '2024-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('does not accept old DEK fields (role, content, iv, pendingReEncryption)', () => {
    // Old fields should be stripped by Zod (object strips unknown keys)
    const result = messageResponseSchema.parse({
      id: 'msg-123',
      conversationId: 'conv-456',
      encryptedBlob: 'base64eciesblob',
      senderType: 'user',
      senderId: null,
      senderDisplayName: null,
      payerId: null,
      cost: null,
      epochNumber: 1,
      sequenceNumber: 0,
      createdAt: '2024-01-01T00:00:00Z',
      // old fields — should be stripped
      role: 'user',
      content: 'plaintext',
      iv: 'oldiv',
      pendingReEncryption: false,
    });
    expect('role' in result).toBe(false);
    expect('content' in result).toBe(false);
    expect('iv' in result).toBe(false);
    expect('pendingReEncryption' in result).toBe(false);
  });
});

// ============================================================
// Response wrapper schemas
// ============================================================

describe('conversationListItemSchema', () => {
  it('accepts conversation with accepted true and null inviter', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
    });
    expect(result.accepted).toBe(true);
    expect(result.invitedByUsername).toBeNull();
    expect(result.privilege).toBe('owner');
  });

  it('accepts conversation with accepted false and inviter username', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-2',
      userId: 'user-1',
      title: 'base64title2',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 0,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: false,
      invitedByUsername: 'sarah',
      privilege: 'write',
    });
    expect(result.accepted).toBe(false);
    expect(result.invitedByUsername).toBe('sarah');
    expect(result.privilege).toBe('write');
  });

  it('rejects missing accepted field', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        invitedByUsername: null,
      })
    ).toThrow();
  });

  it('rejects missing invitedByUsername field', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        accepted: true,
        privilege: 'owner',
      })
    ).toThrow();
  });

  it('accepts valid privilege values', () => {
    const base = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
    };

    for (const privilege of ['read', 'write', 'admin', 'owner']) {
      const result = conversationListItemSchema.parse({ ...base, privilege });
      expect(result.privilege).toBe(privilege);
    }
  });

  it('rejects missing privilege field', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        accepted: true,
        invitedByUsername: null,
      })
    ).toThrow();
  });

  it('rejects invalid privilege value', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        accepted: true,
        invitedByUsername: null,
        privilege: 'superadmin',
      })
    ).toThrow();
  });
});

describe('listConversationsResponseSchema', () => {
  it('accepts empty conversations array', () => {
    const result = listConversationsResponseSchema.parse({ conversations: [] });
    expect(result.conversations).toEqual([]);
  });

  it('accepts array of conversation list items with accepted, inviter, and privilege fields', () => {
    const result = listConversationsResponseSchema.parse({
      conversations: [
        {
          id: 'conv-1',
          userId: 'user-1',
          title: 'base64title1',
          currentEpoch: 1,
          titleEpochNumber: 1,
          nextSequence: 5,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          accepted: true,
          invitedByUsername: null,
          privilege: 'owner',
        },
        {
          id: 'conv-2',
          userId: 'user-1',
          title: 'base64title2',
          currentEpoch: 2,
          titleEpochNumber: 2,
          nextSequence: 10,
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          accepted: false,
          invitedByUsername: 'mike',
          privilege: 'write',
        },
      ],
    });
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]?.accepted).toBe(true);
    expect(result.conversations[0]?.privilege).toBe('owner');
    expect(result.conversations[1]?.invitedByUsername).toBe('mike');
    expect(result.conversations[1]?.privilege).toBe('write');
  });
});

describe('getConversationResponseSchema', () => {
  it('accepts conversation with epoch-based messages and acceptance state', () => {
    const result = getConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 2,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      messages: [
        {
          id: 'msg-1',
          conversationId: 'conv-123',
          encryptedBlob: 'base64blob',
          senderType: 'user',
          senderId: 'user-456',
          senderDisplayName: 'Alice',
          payerId: null,
          cost: null,
          epochNumber: 1,
          sequenceNumber: 0,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      accepted: true,
      invitedByUsername: null,
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.messages).toHaveLength(1);
    expect(result.accepted).toBe(true);
    expect(result.invitedByUsername).toBeNull();
  });

  it('accepts unaccepted conversation with inviter username', () => {
    const result = getConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      messages: [],
      accepted: false,
      invitedByUsername: 'sarah',
    });
    expect(result.accepted).toBe(false);
    expect(result.invitedByUsername).toBe('sarah');
  });

  it('rejects missing accepted field', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: {
          id: 'conv-123',
          userId: 'user-456',
          title: 'base64encryptedtitle',
          currentEpoch: 1,
          titleEpochNumber: 1,
          nextSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        invitedByUsername: null,
      })
    ).toThrow();
  });

  it('rejects missing invitedByUsername field', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: {
          id: 'conv-123',
          userId: 'user-456',
          title: 'base64encryptedtitle',
          currentEpoch: 1,
          titleEpochNumber: 1,
          nextSequence: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        accepted: true,
      })
    ).toThrow();
  });
});

describe('createConversationResponseSchema', () => {
  const validConversation = {
    id: 'conv-123',
    userId: 'user-456',
    title: 'base64encryptedtitle',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  it('accepts new conversation without messages', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      isNew: true,
      accepted: true,
      invitedByUsername: null,
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.messages).toBeUndefined();
    expect(result.isNew).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.invitedByUsername).toBeNull();
  });

  it('accepts idempotent return with messages array', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      messages: [
        {
          id: 'msg-1',
          conversationId: 'conv-123',
          encryptedBlob: 'base64blob',
          senderType: 'user',
          senderId: 'user-456',
          senderDisplayName: 'Alice',
          payerId: null,
          cost: null,
          epochNumber: 1,
          sequenceNumber: 0,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      isNew: false,
      accepted: true,
      invitedByUsername: null,
    });
    expect(result.isNew).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it('does not have a singular message field', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      message: {
        id: 'msg-1',
        conversationId: 'conv-123',
        encryptedBlob: 'base64blob',
        senderType: 'user',
        senderId: 'user-456',
        senderDisplayName: 'Alice',
        payerId: null,
        cost: null,
        epochNumber: 1,
        sequenceNumber: 0,
        createdAt: '2024-01-01T00:00:00Z',
      },
      isNew: true,
      accepted: true,
      invitedByUsername: null,
    });
    // Zod strips unknown keys - singular 'message' should not be present
    expect('message' in result).toBe(false);
  });

  it('requires isNew field', () => {
    expect(() =>
      createConversationResponseSchema.parse({
        conversation: validConversation,
        accepted: true,
        invitedByUsername: null,
      })
    ).toThrow();
  });

  it('requires accepted field', () => {
    expect(() =>
      createConversationResponseSchema.parse({
        conversation: validConversation,
        isNew: true,
        invitedByUsername: null,
      })
    ).toThrow();
  });
});

describe('updateConversationResponseSchema', () => {
  it('accepts updated conversation with epoch fields and acceptance state', () => {
    const result = updateConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64updatedtitle',
        currentEpoch: 2,
        titleEpochNumber: 2,
        nextSequence: 15,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      },
      accepted: true,
      invitedByUsername: null,
    });
    expect(result.conversation.title).toBe('base64updatedtitle');
    expect(result.conversation.currentEpoch).toBe(2);
    expect(result.accepted).toBe(true);
    expect(result.invitedByUsername).toBeNull();
  });

  it('rejects missing accepted field', () => {
    expect(() =>
      updateConversationResponseSchema.parse({
        conversation: {
          id: 'conv-123',
          userId: 'user-456',
          title: 'base64updatedtitle',
          currentEpoch: 2,
          titleEpochNumber: 2,
          nextSequence: 15,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
        invitedByUsername: null,
      })
    ).toThrow();
  });
});

describe('deleteConversationResponseSchema', () => {
  it('accepts deleted true', () => {
    const result = deleteConversationResponseSchema.parse({ deleted: true });
    expect(result.deleted).toBe(true);
  });

  it('accepts deleted false', () => {
    const result = deleteConversationResponseSchema.parse({ deleted: false });
    expect(result.deleted).toBe(false);
  });

  it('rejects missing deleted field', () => {
    expect(() => deleteConversationResponseSchema.parse({})).toThrow();
  });
});
