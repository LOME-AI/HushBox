import { describe, it, expect } from 'vitest';
import { computeRenderState, DECRYPTING_TITLE } from './use-authenticated-chat';

function baseParams(): Parameters<typeof computeRenderState>[0] {
  return {
    isCreateMode: false,
    pendingMessage: null,
    localMessagesLength: 0,
    conversation: { title: 'Test' },
    isConversationLoading: false,
    isMessagesLoading: false,
    isDecryptionPending: false,
  };
}

describe('computeRenderState', () => {
  it('returns redirecting when create mode with no pending message and no local messages', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: null,
      localMessagesLength: 0,
    });
    expect(result).toEqual({ type: 'redirecting' });
  });

  it('returns ready in create mode with pending message', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: 'hello',
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns not-found when no conversation and not loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      conversation: undefined,
      isConversationLoading: false,
    });
    expect(result).toEqual({ type: 'not-found' });
  });

  it('returns loading when conversation is loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      isConversationLoading: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns loading when messages are loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      isMessagesLoading: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns ready when loading but local messages exist', () => {
    const result = computeRenderState({
      ...baseParams(),
      isMessagesLoading: true,
      localMessagesLength: 3,
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns ready when everything loaded and no decryption pending', () => {
    const result = computeRenderState(baseParams());
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns loading with decrypting title when decryption is pending', () => {
    const result = computeRenderState({
      ...baseParams(),
      isDecryptionPending: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns ready when decryption pending but in create mode', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: 'hello',
      isDecryptionPending: true,
    });
    expect(result).toEqual({ type: 'ready' });
  });
});
