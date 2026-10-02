import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/platform/env', () => ({ env: { isLocalDev: false, isE2E: false } }));
vi.mock('@/lib/api/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/api-client', () => ({ client: {}, fetchJson: vi.fn() }));
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: () => ({ sendRefusal: undefined }),
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: { models: [], premiumIds: new Set<string>() }, isLoading: false }),
}));

// The decryption-failure marker as `useDecryptedMessages` would define it after
// any rewording. `MessageList` must exclude these rows from `decryptedCount`
// through the module's own predicate; a re-typed literal in the component would
// count this content as decrypted and fail the assertion below.
const { REWORDED_MARKER } = vi.hoisted(() => ({
  REWORDED_MARKER: '<<message could not be opened>>',
}));
vi.mock('@/hooks/crypto/use-decrypted-messages', () => ({
  DECRYPTION_FAILED_MISSING_EPOCH_KEY: REWORDED_MARKER,
  DECRYPTION_FAILED: REWORDED_MARKER,
  isDecryptionFailure: (content: string): boolean => content.startsWith(REWORDED_MARKER),
}));

import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { MessageList } from '@/components/chat/message/message-list';
import type { Message } from '@/lib/api/api';

function messageWith(id: string, content: string): Message {
  return {
    id,
    conversationId: 'c1',
    senderId: 'u1',
    senderType: 'user',
    role: 'user',
    content,
    sequence: 1,
    epochNumber: 1,
    createdAt: new Date(TEST_DAY_START).toISOString(),
  } as unknown as Message;
}

describe('MessageList decryption-marker sharing', () => {
  it('excludes rows carrying the hook-defined marker from data-decrypted-count', () => {
    render(
      <MessageList
        messages={[messageWith('m1', 'Plain text'), messageWith('m2', REWORDED_MARKER)]}
      />
    );

    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-message-count', '2');
    expect(container).toHaveAttribute('data-decrypted-count', '1');
  });
});
