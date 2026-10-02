import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { friendlyErrorMessage, ERROR_CODES } from '@hushbox/shared';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageItem } from '@/components/chat/message/message-item';
import { renderWithProviders } from '@/test-utils/render';
import type { Message } from '@/lib/api/api';
import type { MessageAction } from '@/lib/chat/message-actions';

// Drives the REAL chat-bubble chain end to end:
//   MessageItem → MessageBody → MessageMediaList → MediaContentItem → MediaItemShell.
// Only the two leaves that need jsdom-unfriendly infrastructure are stubbed:
//   - `useDecryptedMedia` (TanStack Query network round-trip) is pinned to a
//     stuck-loading state, the realistic per-item state for undecryptable media:
//     the only thing that flips the UI from spinner to error is the message-level
//     content-key error threaded down from `MessageItem` (the primary path).
//   - the epoch-key cache returns nothing, so `useMessageContentKey` resolves to
//     a real `{ contentKey: null, error }` — an undecryptable message.

vi.mock('@/hooks/crypto/use-decrypted-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/crypto/use-decrypted-media')>()),
  useDecryptedMedia: () => ({ blobUrl: null, isLoading: true, error: null }),
}));

vi.mock('@/lib/crypto/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => {}),
  setEpochKey: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: { models: [] } }),
}));

// Rendering the real message-item reaches markdown-renderer through React.lazy.
// Leaving it real scrambles that module's own coverage report: v8 records a
// lazily-imported module under a different startOffset than a static import of it,
// and vitest merges both raw range sets by URL under one offset. This suite asserts
// media state only; markdown rendering is covered in markdown-renderer.test.tsx.
vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const ALL_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']);

const messageWithUndecryptableMedia: Message = {
  id: 'msg-undecryptable',
  conversationId: 'conv-1',
  role: 'assistant',
  content: '',
  createdAt: isoAt(TEST_DAY_START + SECOND_MS),
  wrappedContentKey: 'base64-wrapped-key',
  epochNumber: 1,
  mediaItems: [
    {
      id: 'ci-image-1',
      contentType: 'image',
      position: 0,
      mimeType: 'image/png',
      sizeBytes: 1_000_000,
      width: 1024,
      height: 1024,
    },
  ],
};

describe('MessageItem undecryptable media (chat bubble path)', () => {
  it('shows the error UI, not a perpetual spinner, when the content key cannot be resolved', () => {
    renderWithProviders(
      <MessageItem message={messageWithUndecryptableMedia} allowedActions={ALL_AI_ACTIONS} />
    );

    expect(
      screen.getByRole('status', {
        name: friendlyErrorMessage(ERROR_CODES.STORAGE_READ_FAILED),
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /loading media/i })).not.toBeInTheDocument();
  });
});
