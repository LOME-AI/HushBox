import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearEpochKeyCache, getCacheSize, getCurrentEpoch } from '../crypto/epoch-key-cache.js';
import { leaveConversation } from './leave-conversation';
import type { performEpochRotation } from '@hushbox/crypto';
import type {
  buildRotation,
  executeRecoveryRotation,
  executeWithRotation,
} from '../crypto/rotation.js';

const mockExecuteWithRotation = vi.fn<typeof executeWithRotation>();
const mockExecuteRecoveryRotation = vi.fn<typeof executeRecoveryRotation>();
const mockBuildRotation = vi.fn<typeof buildRotation>();
const mockPerformEpochRotation = vi.fn<typeof performEpochRotation>();

vi.mock('../crypto/rotation.js', () => ({
  executeWithRotation: (...args: Parameters<typeof executeWithRotation>) =>
    mockExecuteWithRotation(...args),
  executeRecoveryRotation: (...args: Parameters<typeof executeRecoveryRotation>) =>
    mockExecuteRecoveryRotation(...args),
  buildRotation: (...args: Parameters<typeof buildRotation>) => mockBuildRotation(...args),
}));

vi.mock('@hushbox/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/crypto')>();
  return {
    ...actual,
    performEpochRotation: (...args: Parameters<typeof performEpochRotation>) =>
      mockPerformEpochRotation(...args),
  };
});

describe('leaveConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
  });

  it('sends a bare leave carrying only the conversation id', async () => {
    const leave = vi.fn(() => Promise.resolve());

    await leaveConversation({ conversationId: 'conv-1', leave });

    expect(leave).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('builds no rotation', async () => {
    await leaveConversation({ conversationId: 'conv-1', leave: () => Promise.resolve() });

    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockExecuteRecoveryRotation).not.toHaveBeenCalled();
    expect(mockBuildRotation).not.toHaveBeenCalled();
    expect(mockPerformEpochRotation).not.toHaveBeenCalled();
  });

  it('caches no epoch key and no epoch', async () => {
    await leaveConversation({ conversationId: 'conv-1', leave: () => Promise.resolve() });

    expect(getCacheSize()).toBe(0);
    expect(getCurrentEpoch('conv-1')).toBeUndefined();
  });

  it('rejects with the refusal when the leave is refused', async () => {
    const refusal = new Error('refused');

    await expect(
      leaveConversation({ conversationId: 'conv-1', leave: () => Promise.reject(refusal) })
    ).rejects.toBe(refusal);
  });
});
