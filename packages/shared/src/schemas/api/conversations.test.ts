import { describe, it, expect, expectTypeOf } from 'vitest';
import { toBase64 } from '../../utils/base64.ts';
import { DAY_MS, TEST_DAY_START, isoAt } from '../../testing/test-time.ts';
import {
  createConversationBodySchema,
  updateTitleBodySchema,
  rotationBodySchema,
  rotateEpochBodySchema,
  rotateEpochOutcomeSchema,
  createForkBodySchema,
  renameForkBodySchema,
  startTurnBodySchema,
  regenerateTurnBodySchema,
  stopTurnBodySchema,
  trialTurnBodySchema,
  runStartedResponseSchema,
  runAttachResponseSchema,
  conversationResponseSchema,
  conversationListItemSchema,
  messageResponseSchema,
  contentItemResponseSchema,
  sharedContentItemResponseSchema,
  sharedMessageResponseSchema,
  listConversationsResponseSchema,
  getConversationResponseSchema,
  createConversationResponseSchema,
  updateConversationResponseSchema,
  deleteConversationResponseSchema,
  forkResponseSchema,
  keyChainResponseSchema,
  userOnlyMessageSchema,
} from './conversations.ts';
import type { HistoryContentItemResponse, SharedContentItemResponse } from './conversations.ts';

describe('deleted schemas', () => {
  it('createMessageRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('createMessageRequestSchema' in module_).toBe(false);
  });

  it('CreateMessageRequest type is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('CreateMessageRequest' in module_).toBe(false);
  });

  it('finalizeMessageRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('finalizeMessageRequestSchema' in module_).toBe(false);
  });

  it('FinalizeMessageRequest type is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('FinalizeMessageRequest' in module_).toBe(false);
  });

  it('createMessageResponseSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('createMessageResponseSchema' in module_).toBe(false);
  });

  // The live chat and regenerate request shapes are `startTurnBodySchema` and
  // `regenerateTurnBodySchema`. These two were a second, drifting
  // representation of the same wire contract, reachable only from this test.
  it('streamChatRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('streamChatRequestSchema' in module_).toBe(false);
  });

  it('regenerateRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('regenerateRequestSchema' in module_).toBe(false);
  });

  it('CreateMessageResponse type is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('CreateMessageResponse' in module_).toBe(false);
  });

  // The live fork request shapes are `createForkBodySchema` and
  // `renameForkBodySchema`, which enforce the real name cap. These two were a
  // second, drifting representation of the same wire contract, reachable only
  // from this test.
  it('createForkRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('createForkRequestSchema' in module_).toBe(false);
  });

  it('renameForkRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('renameForkRequestSchema' in module_).toBe(false);
  });

  // The live create, title and rotation request bodies are
  // `createConversationBodySchema`, `updateTitleBodySchema` and
  // `rotationBodySchema`. These three were the weaker twins: no base64
  // refinement, no length cap, and no bound on the rotation's wrap set.
  it('createConversationRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('createConversationRequestSchema' in module_).toBe(false);
  });

  it('updateConversationRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('updateConversationRequestSchema' in module_).toBe(false);
  });

  it('rotationSchema is not exported', async () => {
    const module_ = await import('./conversations.ts');
    expect('rotationSchema' in module_).toBe(false);
  });
});

/**
 * The title cap, spelled as literals rather than imported: a pin that follows
 * the constant would move with a widening instead of catching it. Over-cap is
 * four characters over, not one — base64 has no valid length ≡ 1 (mod 4), so a
 * 1,025-character string would be refused for its encoding rather than its size.
 */
const TITLE_AT_CAP = 'A'.repeat(1024);
const TITLE_OVER_CAP = 'A'.repeat(1028);

/**
 * The key-material cap, spelled as literals for the same reason, and over-cap by
 * four for the same reason. Every `base64Field(KEY_MATERIAL_MAX)` field shares
 * this one constant, so pinning it on the create body's epoch public key pins
 * the number itself.
 */
const KEY_MATERIAL_AT_CAP = 'A'.repeat(4096);
const KEY_MATERIAL_OVER_CAP = 'A'.repeat(4100);

const B64 = toBase64(new Uint8Array([1, 2, 3]));
const REQUEST_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_UUID = '550e8400-e29b-41d4-a716-446655440001';

/**
 * `base64Field` refuses oversize (`too_big`) and undecodable (`custom`) input
 * alike, so a size pin that only asserted failure would still pass if the cap
 * were removed and the string happened to be invalid base64.
 */
function rejectedForSize(result: {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly { readonly code: string }[] };
}): boolean {
  return !result.success && (result.error?.issues ?? []).some((issue) => issue.code === 'too_big');
}

const rotation = {
  expectedEpoch: 1,
  epochPublicKey: B64,
  confirmationHash: B64,
  chainLink: B64,
  memberWraps: [{ memberPublicKey: B64, wrap: B64 }],
  encryptedTitle: B64,
};

describe('createConversationBodySchema', () => {
  const body = {
    id: REQUEST_UUID,
    title: B64,
    epochPublicKey: B64,
    confirmationHash: B64,
    memberWrap: B64,
  };

  it('accepts a complete create body', () => {
    expect(createConversationBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts an absent title (untitled conversation)', () => {
    const rest: Record<string, unknown> = { ...body };
    delete rest['title'];
    expect(createConversationBodySchema.safeParse(rest).success).toBe(true);
  });

  it('rejects a non-uuid id', () => {
    expect(createConversationBodySchema.safeParse({ ...body, id: 'nope' }).success).toBe(false);
  });

  it('rejects a non-base64 epoch public key', () => {
    expect(createConversationBodySchema.safeParse({ ...body, epochPublicKey: '!!!' }).success).toBe(
      false
    );
  });

  it('accepts key material at the cap', () => {
    expect(
      createConversationBodySchema.safeParse({ ...body, epochPublicKey: KEY_MATERIAL_AT_CAP })
        .success
    ).toBe(true);
  });

  it('rejects key material over the cap', () => {
    expect(
      rejectedForSize(
        createConversationBodySchema.safeParse({ ...body, epochPublicKey: KEY_MATERIAL_OVER_CAP })
      )
    ).toBe(true);
  });

  it('accepts a title at the ciphertext cap', () => {
    expect(createConversationBodySchema.safeParse({ ...body, title: TITLE_AT_CAP }).success).toBe(
      true
    );
  });

  it('rejects a title over the ciphertext cap', () => {
    expect(
      rejectedForSize(createConversationBodySchema.safeParse({ ...body, title: TITLE_OVER_CAP }))
    ).toBe(true);
  });
});

describe('rotationBodySchema', () => {
  it('accepts a complete rotation', () => {
    expect(rotationBodySchema.safeParse(rotation).success).toBe(true);
  });

  it('rejects an expectedEpoch below 1', () => {
    expect(rotationBodySchema.safeParse({ ...rotation, expectedEpoch: 0 }).success).toBe(false);
  });

  it('rejects an empty wrap set', () => {
    expect(rotationBodySchema.safeParse({ ...rotation, memberWraps: [] }).success).toBe(false);
  });

  it('rejects a wrap set larger than a conversation can hold', () => {
    const wraps = Array.from({ length: 101 }, () => ({ memberPublicKey: B64, wrap: B64 }));
    expect(rotationBodySchema.safeParse({ ...rotation, memberWraps: wraps }).success).toBe(false);
  });

  it('accepts a wrap set at the member cap', () => {
    const wraps = Array.from({ length: 100 }, () => ({ memberPublicKey: B64, wrap: B64 }));
    expect(rotationBodySchema.safeParse({ ...rotation, memberWraps: wraps }).success).toBe(true);
  });

  it('rejects a wrap entry without its member public key', () => {
    expect(
      rotationBodySchema.safeParse({ ...rotation, memberWraps: [{ wrap: B64 }] }).success
    ).toBe(false);
  });

  it('rejects a wrap entry without its wrap', () => {
    expect(
      rotationBodySchema.safeParse({ ...rotation, memberWraps: [{ memberPublicKey: B64 }] }).success
    ).toBe(false);
  });

  it('strips an unknown key from a wrap entry', () => {
    const result = rotationBodySchema.parse({
      ...rotation,
      memberWraps: [{ memberPublicKey: B64, wrap: B64, visibleFromEpoch: 1 }],
    });
    expect('visibleFromEpoch' in result.memberWraps[0]!).toBe(false);
  });

  it('accepts a re-encrypted title at the ciphertext cap', () => {
    expect(
      rotationBodySchema.safeParse({ ...rotation, encryptedTitle: TITLE_AT_CAP }).success
    ).toBe(true);
  });

  it('rejects a re-encrypted title over the ciphertext cap', () => {
    expect(
      rejectedForSize(rotationBodySchema.safeParse({ ...rotation, encryptedTitle: TITLE_OVER_CAP }))
    ).toBe(true);
  });
});

describe('rotateEpochBodySchema', () => {
  it('accepts a rotation with no predecessor epoch', () => {
    const result = rotateEpochBodySchema.parse(rotation);
    expect(result.predecessorEpoch).toBeUndefined();
  });

  it('carries every field of the rotation body', () => {
    expect(rotateEpochBodySchema.parse(rotation)).toEqual(rotation);
  });

  it('accepts a predecessor epoch of one', () => {
    expect(rotateEpochBodySchema.parse({ ...rotation, predecessorEpoch: 1 }).predecessorEpoch).toBe(
      1
    );
  });

  it('rejects a predecessor epoch of zero', () => {
    expect(rotateEpochBodySchema.safeParse({ ...rotation, predecessorEpoch: 0 }).success).toBe(
      false
    );
  });

  it('rejects a fractional predecessor epoch', () => {
    expect(rotateEpochBodySchema.safeParse({ ...rotation, predecessorEpoch: 1.5 }).success).toBe(
      false
    );
  });

  it('rejects an expectedEpoch below 1', () => {
    expect(rotateEpochBodySchema.safeParse({ ...rotation, expectedEpoch: 0 }).success).toBe(false);
  });
});

describe('rotateEpochOutcomeSchema', () => {
  it('accepts a landed rotation with its new epoch number', () => {
    expect(rotateEpochOutcomeSchema.parse({ rotated: true, newEpochNumber: 3 })).toEqual({
      rotated: true,
      newEpochNumber: 3,
    });
  });

  it('accepts a lost race with the current epoch', () => {
    expect(rotateEpochOutcomeSchema.parse({ rotated: false, currentEpoch: 3 })).toEqual({
      rotated: false,
      currentEpoch: 3,
    });
  });

  it('rejects a landed rotation without its new epoch number', () => {
    expect(rotateEpochOutcomeSchema.safeParse({ rotated: true, currentEpoch: 3 }).success).toBe(
      false
    );
  });

  it('rejects a lost race without the current epoch', () => {
    expect(rotateEpochOutcomeSchema.safeParse({ rotated: false, newEpochNumber: 3 }).success).toBe(
      false
    );
  });

  it('rejects an epoch number below one', () => {
    expect(rotateEpochOutcomeSchema.safeParse({ rotated: true, newEpochNumber: 0 }).success).toBe(
      false
    );
  });
});

describe('updateTitleBodySchema', () => {
  it('accepts the first epoch', () => {
    expect(updateTitleBodySchema.safeParse({ title: B64, titleEpochNumber: 1 }).success).toBe(true);
  });

  it('rejects a zero titleEpochNumber', () => {
    expect(updateTitleBodySchema.safeParse({ title: B64, titleEpochNumber: 0 }).success).toBe(
      false
    );
  });

  it('rejects a negative titleEpochNumber', () => {
    expect(updateTitleBodySchema.safeParse({ title: B64, titleEpochNumber: -1 }).success).toBe(
      false
    );
  });

  it('rejects a missing title', () => {
    expect(updateTitleBodySchema.safeParse({ titleEpochNumber: 1 }).success).toBe(false);
  });

  it('accepts a title at the ciphertext cap', () => {
    expect(
      updateTitleBodySchema.safeParse({ title: TITLE_AT_CAP, titleEpochNumber: 1 }).success
    ).toBe(true);
  });

  it('rejects a title over the ciphertext cap', () => {
    expect(
      rejectedForSize(
        updateTitleBodySchema.safeParse({ title: TITLE_OVER_CAP, titleEpochNumber: 1 })
      )
    ).toBe(true);
  });
});

describe('fork request bodies', () => {
  it('accepts a create with a client-generated id and source message', () => {
    expect(
      createForkBodySchema.safeParse({ id: REQUEST_UUID, fromMessageId: SECOND_UUID }).success
    ).toBe(true);
  });

  it('rejects a blank fork name', () => {
    expect(
      createForkBodySchema.safeParse({ id: REQUEST_UUID, fromMessageId: SECOND_UUID, name: '' })
        .success
    ).toBe(false);
  });

  it('accepts a fork name at the length cap', () => {
    expect(
      createForkBodySchema.safeParse({
        id: REQUEST_UUID,
        fromMessageId: SECOND_UUID,
        name: 'x'.repeat(100),
      }).success
    ).toBe(true);
  });

  it('rejects a create name over the length cap', () => {
    expect(
      createForkBodySchema.safeParse({
        id: REQUEST_UUID,
        fromMessageId: SECOND_UUID,
        name: 'x'.repeat(101),
      }).success
    ).toBe(false);
  });

  it('rejects a rename over the length cap', () => {
    expect(renameForkBodySchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
  });

  it('accepts a rename at the length cap', () => {
    expect(renameForkBodySchema.safeParse({ name: 'x'.repeat(100) }).success).toBe(true);
  });
});

const ANSWER_SOURCES = [{ kind: 'model' as const, id: 'answer-model' }];

const startBase = {
  conversationId: REQUEST_UUID,
  turnSources: ANSWER_SOURCES,
  userMessage: { content: 'hello' },
};

const regenerateBase = {
  conversationId: REQUEST_UUID,
  turnSources: ANSWER_SOURCES,
  targetMessageId: REQUEST_UUID,
  action: 'retry' as const,
  userMessage: { content: 'hello' },
};

const trialBase = { turnSources: ANSWER_SOURCES, prompt: 'hello' };

describe('the turn bodies carry no client-chosen user message id', () => {
  it('accepts a send whose user message is content alone', () => {
    expect(startTurnBodySchema.safeParse(startBase).success).toBe(true);
  });

  it('refuses a send whose user message carries an id', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      userMessage: { id: SECOND_UUID, content: 'hello' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an edit whose replacement message is content alone', () => {
    const parsed = regenerateTurnBodySchema.safeParse({ ...regenerateBase, action: 'edit' });
    expect(parsed.success).toBe(true);
  });

  it('refuses an edit whose replacement message carries an id', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      action: 'edit',
      userMessage: { id: SECOND_UUID, content: 'hello' },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a retry whose re-sent prompt carries an id', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      userMessage: { id: SECOND_UUID, content: 'hello' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('startTurnBodySchema customInstructions', () => {
  it('accepts an omitted custom-instructions field', () => {
    expect(startTurnBodySchema.safeParse(startBase).success).toBe(true);
  });

  it('accepts a custom-instructions string up to the 5000-char bound', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      customInstructions: 'x'.repeat(5000),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-string custom-instructions value', () => {
    const parsed = startTurnBodySchema.safeParse({ ...startBase, customInstructions: 42 });
    expect(parsed.success).toBe(false);
  });
});

describe('a media body that parses always names a model to generate with', () => {
  // The media build reads the pinned ids and has no arm for an empty list. The
  // body shape is what guarantees the list is non-empty: the slot names no model
  // and cannot answer a media turn, and the source list requires an entry.
  const slotOnlyImage = { modality: 'image', turnSources: [{ kind: 'smart' }] };

  it('rejects a send whose only media source is the Smart slot', () => {
    expect(startTurnBodySchema.safeParse({ ...startBase, ...slotOnlyImage }).success).toBe(false);
  });

  it('rejects a regenerate whose only media source is the Smart slot', () => {
    expect(
      regenerateTurnBodySchema.safeParse({ ...regenerateBase, ...slotOnlyImage }).success
    ).toBe(false);
  });

  it('accepts a text send carrying the Smart slot', () => {
    expect(
      startTurnBodySchema.safeParse({ ...startBase, turnSources: [{ kind: 'smart' }] }).success
    ).toBe(true);
  });

  it('rejects a media send carrying no source at all', () => {
    expect(
      startTurnBodySchema.safeParse({ ...startBase, modality: 'image', turnSources: [] }).success
    ).toBe(false);
  });
});

describe('startTurnBodySchema media modality', () => {
  it('rejects the deferred audio modality', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      modality: 'audio',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults an omitted modality to text (existing bodies unchanged)', () => {
    const parsed = startTurnBodySchema.safeParse(startBase);
    expect(parsed.success && parsed.data.modality).toBe('text');
  });

  it('rejects a video send missing its config', () => {
    const parsed = startTurnBodySchema.safeParse({ ...startBase, modality: 'video' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a video send carrying its full config', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      modality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('startTurnBodySchema history', () => {
  it('leaves an omitted history absent rather than defaulting it', () => {
    const parsed = startTurnBodySchema.safeParse(startBase);
    expect(parsed.success && 'history' in parsed.data).toBe(false);
  });

  it('accepts a history of prior turns', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      history: [{ role: 'user', content: 'earlier' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('regenerateTurnBodySchema customInstructions', () => {
  it('accepts a bounded custom-instructions string', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      customInstructions: 'be terse',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('regenerateTurnBodySchema media modality', () => {
  it('defaults an omitted modality to text (existing bodies unchanged)', () => {
    const parsed = regenerateTurnBodySchema.safeParse(regenerateBase);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.modality).toBe('text');
  });

  it('accepts an image regenerate carrying an image config', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      modality: 'image',
      imageConfig: { aspectRatio: '4:3' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects the deferred audio modality', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      modality: 'audio',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a video regenerate missing its config', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      modality: 'video',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a video regenerate carrying its full config', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      modality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
    });
    expect(parsed.success).toBe(true);
  });
});

// `replaceAssistantId` names the single reply a RETRY replaces. An edit's delete
// is bounded by the anchor, not by a named reply, and never reads the field, so
// a body carrying both describes two different deletes at once. Refusing it at the
// boundary is what lets the pre-run guard discriminate its retry-one arm on
// `action` and `replaceAssistantId` together, exactly as the settlement's own
// dispatch does.
describe('regenerateTurnBodySchema replaceAssistantId is retry-only', () => {
  it('accepts a retry carrying a replaceAssistantId', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      replaceAssistantId: SECOND_UUID,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an edit carrying a replaceAssistantId', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      action: 'edit',
      replaceAssistantId: SECOND_UUID,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an edit that carries no replaceAssistantId', () => {
    const parsed = regenerateTurnBodySchema.safeParse({ ...regenerateBase, action: 'edit' });
    expect(parsed.success).toBe(true);
  });
});

describe('the turn-sources arity contract, symmetric across send and regenerate', () => {
  // Send and regenerate carry ONE list with one bound: the earlier asymmetry
  // (a send's `models` needing two, a regenerate's needing one) existed only
  // because a send's single model rode a separate anchor field. With the anchor
  // gone, a width-1 list is a single-model turn on both routes.
  const sourcesOf = (...ids: readonly string[]): { kind: string; id: string }[] =>
    ids.map((id) => ({ kind: 'model', id }));

  it('accepts a one-source list on regenerate', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      turnSources: sourcesOf('answer-model'),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty source list on regenerate', () => {
    const parsed = regenerateTurnBodySchema.safeParse({ ...regenerateBase, turnSources: [] });
    expect(parsed.success).toBe(false);
  });

  it('accepts a two-source list on regenerate', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      turnSources: sourcesOf('a', 'b'),
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a one-source list on send', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      turnSources: sourcesOf('answer-model'),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty source list on send', () => {
    const parsed = startTurnBodySchema.safeParse({ ...startBase, turnSources: [] });
    expect(parsed.success).toBe(false);
  });

  it('accepts a two-source list on send', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      turnSources: sourcesOf('a', 'b'),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a second Smart slot on send', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      turnSources: [{ kind: 'smart' }, { kind: 'smart' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a second Smart slot on regenerate', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      turnSources: [{ kind: 'smart' }, { kind: 'model', id: 'a' }, { kind: 'smart' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a second source on trial, which has no fan-out', () => {
    const parsed = trialTurnBodySchema.safeParse({
      ...trialBase,
      turnSources: sourcesOf('a', 'b'),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('trialTurnBodySchema', () => {
  it('accepts a single-source trial turn', () => {
    expect(trialTurnBodySchema.safeParse(trialBase).success).toBe(true);
  });

  it('rejects an empty prompt', () => {
    expect(trialTurnBodySchema.safeParse({ ...trialBase, prompt: '' }).success).toBe(false);
  });

  it('declares no custom-instructions field, which is an account feature', () => {
    const parsed = trialTurnBodySchema.safeParse({ ...trialBase, customInstructions: 'be terse' });
    expect(parsed.success && 'customInstructions' in parsed.data).toBe(false);
  });
});

describe('stopTurnBodySchema', () => {
  it('accepts a conversation id', () => {
    expect(stopTurnBodySchema.safeParse({ conversationId: REQUEST_UUID }).success).toBe(true);
  });

  it('rejects an empty conversation id', () => {
    expect(stopTurnBodySchema.safeParse({ conversationId: '' }).success).toBe(false);
  });
});

describe('runStartedResponseSchema', () => {
  const started = {
    runId: 'run-1',
    deadlineAt: 1000,
    userMessageId: 'user-1',
    assistantMessageIds: ['answer-1', 'answer-2'],
  };

  it('parses a paid run start naming its run, deadline, user message and answers', () => {
    expect(runStartedResponseSchema.parse(started)).toEqual(started);
  });

  it('rejects a run start that names no answer ids', () => {
    const withoutIds = { runId: 'run-1', deadlineAt: 1000, userMessageId: 'user-1' };
    expect(runStartedResponseSchema.safeParse(withoutIds).success).toBe(false);
  });

  it('rejects a run start naming an empty answer list, since a paid run stores at least one', () => {
    expect(
      runStartedResponseSchema.safeParse({ ...started, assistantMessageIds: [] }).success
    ).toBe(false);
  });

  it('rejects a run start that names no user message id', () => {
    const withoutUser = { runId: 'run-1', deadlineAt: 1000, assistantMessageIds: ['answer-1'] };
    expect(runStartedResponseSchema.safeParse(withoutUser).success).toBe(false);
  });
});

describe('runAttachResponseSchema', () => {
  it("parses an attach naming the live run's message ids", () => {
    const attach = { outcome: 'attach', userMessageId: 'user-1', assistantMessageIds: ['a-1'] };
    expect(runAttachResponseSchema.parse(attach)).toEqual(attach);
  });

  it('parses an attach that found no live run, naming no ids', () => {
    const attach = { outcome: 'attach', userMessageId: null, assistantMessageIds: null };
    expect(runAttachResponseSchema.parse(attach)).toEqual(attach);
  });

  it('rejects an attach without the answer id field', () => {
    expect(
      runAttachResponseSchema.safeParse({ outcome: 'attach', userMessageId: null }).success
    ).toBe(false);
  });
});

describe('userOnlyMessageSchema', () => {
  const validMsgId = '550e8400-e29b-41d4-a716-446655440010';
  const validForkId = '550e8400-e29b-41d4-a716-446655440011';

  it('accepts optional forkId as a valid UUID', () => {
    const result = userOnlyMessageSchema.parse({ content: 'hello', forkId: validForkId });
    expect(result.forkId).toBe(validForkId);
  });

  it('allows omitting forkId (linear send)', () => {
    const result = userOnlyMessageSchema.parse({ content: 'hello' });
    expect(result.forkId).toBeUndefined();
  });

  it('rejects an invalid forkId (non-UUID string)', () => {
    expect(() => userOnlyMessageSchema.parse({ content: 'hello', forkId: 'not-a-uuid' })).toThrow();
  });

  it('refuses a body that names its own message id', () => {
    expect(
      userOnlyMessageSchema.safeParse({ messageId: validMsgId, content: 'hello' }).success
    ).toBe(false);
  });
});

describe('conversationResponseSchema', () => {
  it('accepts valid conversation with epoch fields', () => {
    const result = conversationResponseSchema.parse({
      id: 'conv-123',
      title: 'base64encryptedtitle',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 3,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START + DAY_MS),
    });
    expect(result.id).toBe('conv-123');
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
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

const HISTORY_MESSAGE_CREATED_AT = isoAt(TEST_DAY_START);

// Helper: build a valid MessageResponse-shaped object with one text content
// item. Override any field for the specific test case.
function buildMessageResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const contentItemOverrides = overrides['contentItemOverrides'] as
    | Record<string, unknown>
    | undefined;
  const base: Record<string, unknown> = {
    id: 'msg-123',
    wrappedContentKey: 'base64wrappedkey',
    senderType: 'user',
    senderId: 'user-789',
    epochNumber: 1,
    sequenceNumber: 0,
    parentMessageId: null,
    batchId: 'batch-test-1',
    deleted: false,
    createdAt: HISTORY_MESSAGE_CREATED_AT,
    contentItems: [
      {
        id: 'ci-1',
        contentType: 'text',
        position: 0,
        encryptedBlob: 'base64blob',
        mimeType: null,
        byteLength: null,
        width: null,
        height: null,
        durationMs: null,
        modelName: null,
        cost: null,
        isSmartModel: false,
        reasoningTokens: null,
        reasoningEffort: null,
        reasoningDurationMs: null,
        inputTokens: null,
        outputTokens: null,
        ...contentItemOverrides,
      },
    ],
  };
  const rest = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== 'contentItemOverrides')
  );
  return { ...base, ...rest };
}

function buildContentItemResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'ci-1',
    position: 0,
    contentType: 'text',
    mimeType: null,
    byteLength: null,
    width: null,
    height: null,
    durationMs: null,
    encryptedBlob: 'base64blob',
    ...overrides,
  };
}

describe('contentItemResponseSchema', () => {
  it('accepts a text item carrying its ciphertext inline', () => {
    const result = contentItemResponseSchema.parse(buildContentItemResponse());
    expect(result.contentType).toBe('text');
    expect(result.encryptedBlob).toBe('base64blob');
    expect(result.byteLength).toBeNull();
  });

  it('accepts a media item carrying its dimensions and a null blob', () => {
    const result = contentItemResponseSchema.parse(
      buildContentItemResponse({
        contentType: 'image',
        mimeType: 'image/png',
        byteLength: 2048,
        width: 512,
        height: 512,
        encryptedBlob: null,
      })
    );
    expect(result.mimeType).toBe('image/png');
    expect(result.byteLength).toBe(2048);
    expect(result.width).toBe(512);
  });

  it('strips the display metadata its read-specific extensions add', () => {
    const result = contentItemResponseSchema.parse(
      buildContentItemResponse({ modelName: 'anthropic/claude-sonnet-4.6', cost: '1360000' })
    );
    expect('modelName' in result).toBe(false);
    expect('cost' in result).toBe(false);
  });

  it('rejects a content type outside the database enum', () => {
    expect(() =>
      contentItemResponseSchema.parse(buildContentItemResponse({ contentType: 'document' }))
    ).toThrow();
  });
});

function buildSharedContentItemResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...buildContentItemResponse(),
    modelName: 'anthropic/claude-sonnet-4.6',
    isSmartModel: false,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
    ...overrides,
  };
}

describe('sharedContentItemResponseSchema', () => {
  it('carries the recorded reasoning time in whole milliseconds', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ reasoningDurationMs: 14_000 })
    );
    expect(result.reasoningDurationMs).toBe(14_000);
  });

  it('carries an unrecorded reasoning time as null', () => {
    const result = sharedContentItemResponseSchema.parse(buildSharedContentItemResponse());
    expect(result.reasoningDurationMs).toBeNull();
  });

  it('rejects a payload missing the reasoning time', () => {
    const payload = buildSharedContentItemResponse();
    delete payload['reasoningDurationMs'];
    expect(() => sharedContentItemResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a fractional reasoning time', () => {
    expect(() =>
      sharedContentItemResponseSchema.parse(
        buildSharedContentItemResponse({ reasoningDurationMs: 1.5 })
      )
    ).toThrow();
  });

  it('declares the reasoning time as a number or null on both reads', () => {
    expectTypeOf<SharedContentItemResponse['reasoningDurationMs']>().toEqualTypeOf<number | null>();
    expectTypeOf<HistoryContentItemResponse['reasoningDurationMs']>().toEqualTypeOf<
      number | null
    >();
  });

  it('carries the recorded reasoning level and token count', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ reasoningTokens: 1204, reasoningEffort: 'high' })
    );
    expect(result.reasoningTokens).toBe(1204);
    expect(result.reasoningEffort).toBe('high');
  });

  it('carries a resolved-to-none level as `off`', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ reasoningEffort: 'off' })
    );
    expect(result.reasoningEffort).toBe('off');
  });

  it('carries null for an item whose turn recorded no completion row', () => {
    const result = sharedContentItemResponseSchema.parse(buildSharedContentItemResponse());
    expect(result.reasoningTokens).toBeNull();
    expect(result.reasoningEffort).toBeNull();
  });

  it('rejects a payload missing the reasoning fields', () => {
    const payload = buildSharedContentItemResponse();
    delete payload['reasoningEffort'];
    expect(() => sharedContentItemResponseSchema.parse(payload)).toThrow();
  });

  it('carries the generating model id', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ modelName: 'anthropic/claude-sonnet-4.6' })
    );
    expect(result.modelName).toBe('anthropic/claude-sonnet-4.6');
  });

  it('carries the smart-model flag', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ isSmartModel: true })
    );
    expect(result.isSmartModel).toBe(true);
  });

  it('carries a null model for a user item', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ modelName: null })
    );
    expect(result.modelName).toBeNull();
  });

  it('rejects a payload missing the model name', () => {
    const payload = buildSharedContentItemResponse();
    delete payload['modelName'];
    expect(() => sharedContentItemResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a payload missing the smart-model flag', () => {
    const payload = buildSharedContentItemResponse();
    delete payload['isSmartModel'];
    expect(() => sharedContentItemResponseSchema.parse(payload)).toThrow();
  });

  it('strips the billed cost the share read must not carry', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ cost: '1360000' })
    );
    expect('cost' in result).toBe(false);
  });

  it('strips the input token count the share read must not carry', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ inputTokens: 10 })
    );
    expect('inputTokens' in result).toBe(false);
  });

  it('strips the output token count the share read must not carry', () => {
    const result = sharedContentItemResponseSchema.parse(
      buildSharedContentItemResponse({ outputTokens: 20 })
    );
    expect('outputTokens' in result).toBe(false);
  });
});

const MESSAGE_CREATED_AT = isoAt(TEST_DAY_START - DAY_MS);

function buildSharedMessageResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    shareId: 'share-1',
    messageId: 'msg-123',
    wrappedContentKey: 'base64sharewrap',
    createdAt: isoAt(TEST_DAY_START),
    messageCreatedAt: MESSAGE_CREATED_AT,
    conversationId: 'conv-456',
    epochNumber: 1,
    senderId: 'user-789',
    epochWrappedContentKey: 'base64epochwrap',
    deleted: false,
    contentItems: [buildSharedContentItemResponse()],
    ...overrides,
  };
}

describe('sharedMessageResponseSchema', () => {
  it('accepts the public standalone share payload', () => {
    const result = sharedMessageResponseSchema.parse(buildSharedMessageResponse());
    expect(result.shareId).toBe('share-1');
    expect(result.epochWrappedContentKey).toBe('base64epochwrap');
    expect(result.contentItems).toHaveLength(1);
  });

  it('carries the shared message own creation date beside the share date', () => {
    const result = sharedMessageResponseSchema.parse(buildSharedMessageResponse());
    expect(result.messageCreatedAt).toBe(MESSAGE_CREATED_AT);
    expect(result.messageCreatedAt).not.toBe(result.createdAt);
  });

  it('rejects a payload without the message creation date', () => {
    const payload = buildSharedMessageResponse();
    delete payload['messageCreatedAt'];
    expect(() => sharedMessageResponseSchema.parse(payload)).toThrow();
  });

  it('carries no sender type, unlike the history message', () => {
    const result = sharedMessageResponseSchema.parse(
      buildSharedMessageResponse({ senderType: 'assistant' })
    );
    expect('senderType' in result).toBe(false);
  });

  it('rejects a payload without its share id', () => {
    const payload = buildSharedMessageResponse();
    delete payload['shareId'];
    expect(() => sharedMessageResponseSchema.parse(payload)).toThrow();
  });

  it('carries whether the shared message was deleted', () => {
    const result = sharedMessageResponseSchema.parse(
      buildSharedMessageResponse({ deleted: true, contentItems: [] })
    );
    expect(result.deleted).toBe(true);
  });

  it('rejects a shared message without its deleted flag', () => {
    const payload = buildSharedMessageResponse();
    delete payload['deleted'];
    expect(() => sharedMessageResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a non-boolean deleted flag on a shared message', () => {
    expect(() =>
      sharedMessageResponseSchema.parse(buildSharedMessageResponse({ deleted: 'yes' }))
    ).toThrow();
  });

  it('accepts a null senderId for an AI-authored message', () => {
    const result = sharedMessageResponseSchema.parse(
      buildSharedMessageResponse({ senderId: null })
    );
    expect(result.senderId).toBeNull();
  });

  it('carries the reasoning level and token count on its content items', () => {
    const result = sharedMessageResponseSchema.parse(
      buildSharedMessageResponse({
        contentItems: [
          buildSharedContentItemResponse({ reasoningTokens: 1204, reasoningEffort: 'high' }),
        ],
      })
    );
    expect(result.contentItems[0]?.reasoningTokens).toBe(1204);
    expect(result.contentItems[0]?.reasoningEffort).toBe('high');
  });
});

describe('messageResponseSchema', () => {
  it('accepts a valid wrap-once message with one text content item', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        contentItemOverrides: { modelName: 'Alice' },
      })
    );
    expect(result.id).toBe('msg-123');
    expect(result.wrappedContentKey).toBe('base64wrappedkey');
    expect(result.senderType).toBe('user');
    expect(result.senderId).toBe('user-789');
    expect(result.contentItems).toHaveLength(1);
    expect(result.contentItems[0]!.contentType).toBe('text');
    expect(result.contentItems[0]!.encryptedBlob).toBe('base64blob');
    expect(result.contentItems[0]!.modelName).toBe('Alice');
    expect(result.contentItems[0]!.cost).toBeNull();
    expect(result.epochNumber).toBe(1);
    expect(result.sequenceNumber).toBe(0);
    expect(result.parentMessageId).toBeNull();
  });

  it('accepts message with non-null parentMessageId', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        id: 'msg-124',
        senderType: 'assistant',
        senderId: null,
        sequenceNumber: 1,
        parentMessageId: 'msg-123',
        contentItemOverrides: { cost: '0.00136000' },
      })
    );
    expect(result.parentMessageId).toBe('msg-123');
    expect(result.contentItems[0]!.cost).toBe('0.00136000');
  });

  it('accepts an assistant message with null senderId and AI-authored content item', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        id: 'msg-124',
        senderType: 'assistant',
        senderId: null,
        sequenceNumber: 1,
        contentItemOverrides: {
          modelName: 'anthropic/claude-sonnet-4.6',
          cost: '0.00136000',
        },
      })
    );
    expect(result.senderType).toBe('assistant');
    expect(result.senderId).toBeNull();
    expect(result.contentItems[0]!.modelName).toBe('anthropic/claude-sonnet-4.6');
    expect(result.contentItems[0]!.cost).toBe('0.00136000');
  });

  it('accepts a content item carrying a reasoning token count', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        senderType: 'assistant',
        senderId: null,
        contentItemOverrides: { reasoningTokens: 1204 },
      })
    );
    expect(result.contentItems[0]!.reasoningTokens).toBe(1204);
  });

  it('carries a null reasoning token count when none was recorded', () => {
    const result = messageResponseSchema.parse(buildMessageResponse());
    expect(result.contentItems[0]!.reasoningTokens).toBeNull();
  });

  it('carries a null reasoning effort when no level was recorded', () => {
    const result = messageResponseSchema.parse(buildMessageResponse());
    expect(result.contentItems[0]!.reasoningEffort).toBeNull();
  });

  it('accepts the off reasoning effort as a recorded level', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({ contentItemOverrides: { reasoningEffort: 'off' } })
    );
    expect(result.contentItems[0]!.reasoningEffort).toBe('off');
  });

  it('rejects a non-integer reasoning token count', () => {
    expect(() =>
      messageResponseSchema.parse(
        buildMessageResponse({ contentItemOverrides: { reasoningTokens: 1.5 } })
      )
    ).toThrow();
  });

  it('carries the input and output token counts of an assistant content item', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        senderType: 'assistant',
        senderId: null,
        contentItemOverrides: { inputTokens: 10, outputTokens: 20 },
      })
    );
    expect(result.contentItems[0]!.inputTokens).toBe(10);
    expect(result.contentItems[0]!.outputTokens).toBe(20);
  });

  it('carries null token counts when no completion was recorded', () => {
    const result = messageResponseSchema.parse(buildMessageResponse());
    expect(result.contentItems[0]!.inputTokens).toBeNull();
    expect(result.contentItems[0]!.outputTokens).toBeNull();
  });

  it('rejects a non-integer input token count', () => {
    expect(() =>
      messageResponseSchema.parse(
        buildMessageResponse({ contentItemOverrides: { inputTokens: 1.5 } })
      )
    ).toThrow();
  });

  it('rejects a non-integer output token count', () => {
    expect(() =>
      messageResponseSchema.parse(
        buildMessageResponse({ contentItemOverrides: { outputTokens: 1.5 } })
      )
    ).toThrow();
  });

  it('rejects a content item missing the input token count', () => {
    expect(() =>
      messageResponseSchema.parse(
        buildMessageResponse({ contentItemOverrides: { inputTokens: undefined } })
      )
    ).toThrow();
  });

  it('rejects a content item missing the output token count', () => {
    expect(() =>
      messageResponseSchema.parse(
        buildMessageResponse({ contentItemOverrides: { outputTokens: undefined } })
      )
    ).toThrow();
  });

  it('carries the message creation instant as an ISO string', () => {
    const result = messageResponseSchema.parse(buildMessageResponse());
    expect(result.createdAt).toBe(HISTORY_MESSAGE_CREATED_AT);
  });

  it('rejects a creation instant that is not an ISO string', () => {
    expect(() =>
      messageResponseSchema.parse(buildMessageResponse({ createdAt: 'yesterday' }))
    ).toThrow();
  });

  it('rejects a message missing its creation instant', () => {
    const msg = buildMessageResponse();
    delete msg['createdAt'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('accepts a user message whose content item has null cost', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        id: 'msg-125',
        contentItemOverrides: { cost: null },
      })
    );
    expect(result.contentItems[0]!.cost).toBeNull();
  });

  it('accepts the system sender type the database enum admits', () => {
    const result = messageResponseSchema.parse(buildMessageResponse({ senderType: 'system' }));
    expect(result.senderType).toBe('system');
  });

  it('rejects a sender type outside the database enum', () => {
    expect(() => messageResponseSchema.parse(buildMessageResponse({ senderType: 'ai' }))).toThrow();
  });

  it('rejects missing wrappedContentKey', () => {
    const msg = buildMessageResponse();
    delete msg['wrappedContentKey'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('rejects non-integer epochNumber', () => {
    expect(() => messageResponseSchema.parse(buildMessageResponse({ epochNumber: 1.5 }))).toThrow();
  });

  it('rejects non-integer sequenceNumber', () => {
    expect(() =>
      messageResponseSchema.parse(buildMessageResponse({ sequenceNumber: 0.5 }))
    ).toThrow();
  });

  it('rejects missing epochNumber', () => {
    const msg = buildMessageResponse();
    delete msg['epochNumber'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('bounds epochNumber no further than the live producer does', () => {
    const result = messageResponseSchema.parse(buildMessageResponse({ epochNumber: 0 }));
    expect(result.epochNumber).toBe(0);
  });

  it('bounds sequenceNumber no further than the live producer does', () => {
    const result = messageResponseSchema.parse(buildMessageResponse({ sequenceNumber: -1 }));
    expect(result.sequenceNumber).toBe(-1);
  });

  it('rejects missing sequenceNumber', () => {
    const msg = buildMessageResponse();
    delete msg['sequenceNumber'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('carries whether the message was deleted', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({ deleted: true, contentItems: [] })
    );
    expect(result.deleted).toBe(true);
  });

  it('rejects a message without its deleted flag', () => {
    const msg = buildMessageResponse();
    delete msg['deleted'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('rejects a non-boolean deleted flag', () => {
    expect(() => messageResponseSchema.parse(buildMessageResponse({ deleted: 1 }))).toThrow();
  });

  it('strips the conversationId the history read does not serve', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({ conversationId: 'conv-456' })
    );
    expect('conversationId' in result).toBe(false);
  });

  it('strips unknown old DEK fields like role/content/iv', () => {
    // Zod object strips unknown keys by default
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        role: 'user',
        content: 'plaintext',
        iv: 'oldiv',
        pendingReEncryption: false,
      })
    );
    expect('role' in result).toBe(false);
    expect('content' in result).toBe(false);
    expect('iv' in result).toBe(false);
    expect('pendingReEncryption' in result).toBe(false);
  });
});

describe('conversationListItemSchema', () => {
  it('accepts conversation with accepted true and null inviter', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
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
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: false,
      invitedByUsername: 'sarah',
      memberCount: 1,
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        invitedByUsername: null,
        memberCount: 1,
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
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
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        memberCount: 1,
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
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        memberCount: 1,
        privilege: 'superadmin',
      })
    ).toThrow();
  });

  it('accepts muted field as boolean', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
      privilege: 'owner',
      muted: true,
    });
    expect(result.muted).toBe(true);
  });

  it('defaults muted to false when not provided', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
      privilege: 'owner',
    });
    expect(result.muted).toBe(false);
  });

  it('accepts pinned field as boolean', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
      privilege: 'owner',
      pinned: true,
    });
    expect(result.pinned).toBe(true);
  });

  it('defaults pinned to false when not provided', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
      privilege: 'owner',
    });
    expect(result.pinned).toBe(false);
  });

  it('carries the caller read cursor', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
      privilege: 'owner',
      lastReadSeq: 4,
    });
    expect(result.lastReadSeq).toBe(4);
  });

  it('defaults the read cursor to nothing read', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      memberCount: 1,
      privilege: 'owner',
    });
    expect(result.lastReadSeq).toBe(0);
  });

  it('rejects a negative read cursor', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        memberCount: 1,
        privilege: 'owner',
        lastReadSeq: -1,
      })
    ).toThrow();
  });

  describe('member count', () => {
    const listed = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
    };

    it('carries the active member count', () => {
      const result = conversationListItemSchema.parse({ ...listed, memberCount: 3 });
      expect(result.memberCount).toBe(3);
    });

    it('rejects a list item without a member count', () => {
      expect(conversationListItemSchema.safeParse(listed).success).toBe(false);
    });

    it('rejects a member count of zero, since the caller is always an active member', () => {
      expect(conversationListItemSchema.safeParse({ ...listed, memberCount: 0 }).success).toBe(
        false
      );
    });

    it('rejects a fractional member count', () => {
      expect(conversationListItemSchema.safeParse({ ...listed, memberCount: 1.5 }).success).toBe(
        false
      );
    });
  });
});

describe('listConversationsResponseSchema', () => {
  it('accepts empty conversations array', () => {
    const result = listConversationsResponseSchema.parse({ conversations: [], nextCursor: null });
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
          createdAt: isoAt(TEST_DAY_START),
          updatedAt: isoAt(TEST_DAY_START),
          accepted: true,
          invitedByUsername: null,
          memberCount: 1,
          privilege: 'owner',
        },
        {
          id: 'conv-2',
          userId: 'user-1',
          title: 'base64title2',
          currentEpoch: 2,
          titleEpochNumber: 2,
          nextSequence: 10,
          createdAt: isoAt(TEST_DAY_START + DAY_MS),
          updatedAt: isoAt(TEST_DAY_START + DAY_MS),
          accepted: false,
          invitedByUsername: 'mike',
          memberCount: 1,
          privilege: 'write',
        },
      ],
      nextCursor: null,
    });
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]?.accepted).toBe(true);
    expect(result.conversations[0]?.privilege).toBe('owner');
    expect(result.conversations[1]?.invitedByUsername).toBe('mike');
    expect(result.conversations[1]?.privilege).toBe('write');
  });
});

describe('getConversationResponseSchema', () => {
  const validConversation = {
    id: 'conv-123',
    title: 'base64encryptedtitle',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 2,
    createdAt: isoAt(TEST_DAY_START),
    updatedAt: isoAt(TEST_DAY_START),
  };

  const validMembership = {
    privilege: 'owner',
    muted: false,
    pinned: false,
    accepted: true,
    visibleFromEpoch: 1,
    linkId: null,
  };

  it('accepts a conversation with membership and forks', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
      forks: [
        { id: 'fork-1', name: 'branch', tipMessageId: null, createdAt: isoAt(TEST_DAY_START) },
      ],
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.membership.privilege).toBe('owner');
    expect(result.membership.visibleFromEpoch).toBe(1);
    expect(result.forks).toHaveLength(1);
  });

  it('defaults forks to an empty array when omitted', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
    });
    expect(result.forks).toEqual([]);
  });

  it('carries the caller read cursor on the membership', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: { ...validMembership, lastReadSeq: 12 },
      forks: [],
    });
    expect(result.membership.lastReadSeq).toBe(12);
  });

  it('defaults the membership read cursor to nothing read', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
      forks: [],
    });
    expect(result.membership.lastReadSeq).toBe(0);
  });

  it('carries the caller link id on the membership', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: { ...validMembership, privilege: 'read', linkId: 'link-1' },
      forks: [],
    });
    expect(result.membership.linkId).toBe('link-1');
  });

  it('rejects a membership missing the link id', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        membership: {
          privilege: 'owner',
          muted: false,
          pinned: false,
          accepted: true,
          visibleFromEpoch: 1,
        },
        forks: [],
      })
    ).toThrow();
  });

  it('carries the unaccepted membership state', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: { ...validMembership, accepted: false, privilege: 'write' },
      forks: [],
    });
    expect(result.membership.accepted).toBe(false);
    expect(result.membership.privilege).toBe('write');
  });

  it('strips the retired flat fields', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
      forks: [],
      messages: [],
      callerId: 'user-456',
      invitedByUsername: null,
      accepted: true,
      privilege: 'owner',
    });
    expect('messages' in result).toBe(false);
    expect('callerId' in result).toBe(false);
    expect('invitedByUsername' in result).toBe(false);
  });

  it('rejects a missing membership', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        forks: [],
      })
    ).toThrow();
  });

  it('rejects an invalid membership privilege', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        membership: { ...validMembership, privilege: 'invalid_privilege' },
        forks: [],
      })
    ).toThrow();
  });

  it('rejects a membership missing visibleFromEpoch', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        membership: { privilege: 'owner', muted: false, pinned: false, accepted: true },
        forks: [],
      })
    ).toThrow();
  });

  it('rejects a missing conversation', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        membership: validMembership,
        forks: [],
      })
    ).toThrow();
  });

  it('rejects a conversation missing epoch fields', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: {
          id: 'conv-123',
          title: 'base64encryptedtitle',
          createdAt: isoAt(TEST_DAY_START),
          updatedAt: isoAt(TEST_DAY_START),
        },
        membership: {
          privilege: 'owner',
          muted: false,
          pinned: false,
          accepted: true,
          visibleFromEpoch: 1,
        },
        forks: [],
      })
    ).toThrow();
  });
});

describe('createConversationResponseSchema', () => {
  const validConversation = {
    id: 'conv-123',
    title: 'base64encryptedtitle',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 0,
    createdAt: isoAt(TEST_DAY_START),
    updatedAt: isoAt(TEST_DAY_START),
  };

  it('accepts a created conversation', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      created: true,
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.created).toBe(true);
  });

  it('accepts an idempotent (already-existing) return', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      created: false,
    });
    expect(result.created).toBe(false);
  });

  it('strips unknown keys', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      message: buildMessageResponse({
        id: 'msg-1',
        conversationId: 'conv-123',
        senderId: 'user-456',
      }),
      created: true,
    });
    expect('message' in result).toBe(false);
  });

  it('requires created field', () => {
    expect(() =>
      createConversationResponseSchema.parse({
        conversation: validConversation,
      })
    ).toThrow();
  });
});

describe('updateConversationResponseSchema', () => {
  it('accepts updated conversation with epoch fields', () => {
    const result = updateConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        title: 'base64updatedtitle',
        currentEpoch: 2,
        titleEpochNumber: 2,
        nextSequence: 15,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
      },
    });
    expect(result.conversation.title).toBe('base64updatedtitle');
    expect(result.conversation.currentEpoch).toBe(2);
  });

  it('rejects a missing conversation field', () => {
    expect(() => updateConversationResponseSchema.parse({})).toThrow();
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

describe('keyChainResponseSchema', () => {
  function without(
    record: Readonly<Record<string, unknown>>,
    key: string
  ): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  }

  const firstEpoch = {
    epochNumber: 1,
    epochPublicKey: 'base64pub1',
    confirmationHash: 'base64hash1',
    previousEpochNumber: null,
    chainLink: null,
  };
  const secondEpoch = {
    epochNumber: 2,
    epochPublicKey: 'base64pub2',
    confirmationHash: 'base64hash2',
    previousEpochNumber: 1,
    chainLink: 'base64link2',
  };
  const validKeyChain = {
    epochs: [firstEpoch, secondEpoch],
    wraps: [{ epochNumber: 2, wrap: 'base64wrap' }],
    currentEpoch: 2,
    rotationPending: false,
  };

  it('accepts one record per epoch with its public key, confirmation and chain link', () => {
    const result = keyChainResponseSchema.parse(validKeyChain);
    expect(result.epochs).toEqual([firstEpoch, secondEpoch]);
  });

  it('accepts an epoch record with no predecessor and no chain link', () => {
    const result = keyChainResponseSchema.parse({ ...validKeyChain, epochs: [firstEpoch] });
    expect(result.epochs[0]).toMatchObject({ previousEpochNumber: null, chainLink: null });
  });

  it('accepts a predecessor with its chain link withheld below the floor', () => {
    const result = keyChainResponseSchema.parse({
      ...validKeyChain,
      epochs: [{ ...secondEpoch, chainLink: null }],
    });
    expect(result.epochs[0]).toMatchObject({ previousEpochNumber: 1, chainLink: null });
  });

  it('accepts a skip link whose predecessor is not the epoch directly below', () => {
    const result = keyChainResponseSchema.parse({
      ...validKeyChain,
      epochs: [firstEpoch, { ...secondEpoch, epochNumber: 4, previousEpochNumber: 1 }],
      currentEpoch: 4,
    });
    expect(result.epochs[1]).toMatchObject({ epochNumber: 4, previousEpochNumber: 1 });
  });

  it('carries each wrap as its epoch number and wrap ciphertext only', () => {
    const result = keyChainResponseSchema.parse(validKeyChain);
    expect(result.wraps).toEqual([{ epochNumber: 2, wrap: 'base64wrap' }]);
  });

  it('carries the current epoch', () => {
    expect(keyChainResponseSchema.parse(validKeyChain).currentEpoch).toBe(2);
  });

  it('carries the rotation-pending flag', () => {
    const result = keyChainResponseSchema.parse({ ...validKeyChain, rotationPending: true });
    expect(result.rotationPending).toBe(true);
  });

  it('rejects a response omitting the rotation-pending flag', () => {
    const rest = without(validKeyChain, 'rotationPending');
    expect(keyChainResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a response omitting the epoch records', () => {
    const rest = without(validKeyChain, 'epochs');
    expect(keyChainResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an epoch record missing its public key', () => {
    const rest = without(secondEpoch, 'epochPublicKey');
    expect(keyChainResponseSchema.safeParse({ ...validKeyChain, epochs: [rest] }).success).toBe(
      false
    );
  });

  it('rejects an epoch record missing its confirmation hash', () => {
    const rest = without(secondEpoch, 'confirmationHash');
    expect(keyChainResponseSchema.safeParse({ ...validKeyChain, epochs: [rest] }).success).toBe(
      false
    );
  });

  it('rejects an epoch record omitting its predecessor rather than nulling it', () => {
    const rest = without(secondEpoch, 'previousEpochNumber');
    expect(keyChainResponseSchema.safeParse({ ...validKeyChain, epochs: [rest] }).success).toBe(
      false
    );
  });

  it('rejects an epoch record omitting its chain link rather than nulling it', () => {
    const rest = without(secondEpoch, 'chainLink');
    expect(keyChainResponseSchema.safeParse({ ...validKeyChain, epochs: [rest] }).success).toBe(
      false
    );
  });

  it('rejects an epoch number below one', () => {
    expect(
      keyChainResponseSchema.safeParse({
        ...validKeyChain,
        epochs: [{ ...firstEpoch, epochNumber: 0 }],
      }).success
    ).toBe(false);
  });

  it('rejects a predecessor epoch number below one', () => {
    expect(
      keyChainResponseSchema.safeParse({
        ...validKeyChain,
        epochs: [{ ...secondEpoch, previousEpochNumber: 0 }],
      }).success
    ).toBe(false);
  });

  it('rejects a wrap missing the wrap ciphertext', () => {
    expect(
      keyChainResponseSchema.safeParse({ ...validKeyChain, wraps: [{ epochNumber: 2 }] }).success
    ).toBe(false);
  });

  it('accepts empty epochs and wraps', () => {
    const result = keyChainResponseSchema.parse({ ...validKeyChain, epochs: [], wraps: [] });
    expect(result.epochs).toEqual([]);
    expect(result.wraps).toEqual([]);
  });

  it('strips an unknown top-level key, as the sibling response schemas do', () => {
    const result = keyChainResponseSchema.parse({
      ...validKeyChain,
      floorConfirmation: { epochNumber: 1, confirmationHash: 'base64hash1' },
    });
    expect('floorConfirmation' in result).toBe(false);
  });

  it('strips a confirmation hash from a wrap: confirmations travel on the epoch record', () => {
    const result = keyChainResponseSchema.parse({
      ...validKeyChain,
      wraps: [{ epochNumber: 2, wrap: 'base64wrap', confirmationHash: 'base64hash2' }],
    });
    expect('confirmationHash' in result.wraps[0]!).toBe(false);
  });
});

describe('forkResponseSchema', () => {
  it('accepts valid fork response', () => {
    const result = forkResponseSchema.parse({
      id: 'fork-1',
      conversationId: 'conv-1',
      name: 'Main',
      tipMessageId: 'msg-5',
      createdAt: isoAt(TEST_DAY_START),
    });
    expect(result.id).toBe('fork-1');
    expect(result.name).toBe('Main');
    expect(result.tipMessageId).toBe('msg-5');
  });

  it('accepts fork with null tipMessageId', () => {
    const result = forkResponseSchema.parse({
      id: 'fork-1',
      conversationId: 'conv-1',
      name: 'Fork 1',
      tipMessageId: null,
      createdAt: isoAt(TEST_DAY_START),
    });
    expect(result.tipMessageId).toBeNull();
  });

  it('rejects missing name', () => {
    expect(() =>
      forkResponseSchema.parse({
        id: 'fork-1',
        conversationId: 'conv-1',
        tipMessageId: null,
        createdAt: isoAt(TEST_DAY_START),
      })
    ).toThrow();
  });
});

describe('getConversationResponseSchema with forks', () => {
  const validMembership = {
    privilege: 'owner',
    muted: false,
    pinned: false,
    accepted: true,
    visibleFromEpoch: 1,
    linkId: null,
  };

  it('accepts response with forks array and strips the fork conversationId', () => {
    const result = getConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        title: 'base64title',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 2,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
      },
      membership: validMembership,
      forks: [
        {
          id: 'fork-1',
          conversationId: 'conv-123',
          name: 'Main',
          tipMessageId: 'msg-5',
          createdAt: isoAt(TEST_DAY_START),
        },
      ],
    });
    expect(result.forks).toHaveLength(1);
    expect(result.forks[0]?.name).toBe('Main');
    expect('conversationId' in (result.forks[0] ?? {})).toBe(false);
  });
});
