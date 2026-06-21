import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

// This file deliberately uses the REAL react-virtuoso (the sibling
// message-list.test.tsx mocks it). The initial-paint seed path only runs in the
// real library, and a 0px-measured scroller — which jsdom always produces, and
// which WebKit transiently produces on first paint — is exactly the condition
// that triggers it. Mocking Virtuoso cannot exercise `computeItemKey`, so this
// is the only level at which the seed-row regression is observable.
vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/api-client', () => ({ client: {}, fetchJson: vi.fn() }));
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: { models: [], premiumIds: new Set() }, isLoading: false }),
}));
vi.mock('@/components/chat/message/message-item', () => ({
  MessageItem: ({ message }: { message: { id: string } }): React.JSX.Element => (
    <div data-testid="seeded-item">{message.id}</div>
  ),
}));

import { MessageList } from '@/components/chat/message/message-list';
import type { Message } from '@/lib/api';

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollTo = Element.prototype.scrollTo;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = (): void => undefined;
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollTo = originalScrollTo;
});

function buildMessages(count: number): Message[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: String(index + 1),
    conversationId: 'c',
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `m${String(index)}`,
    createdAt: `2024-01-01T00:00:0${String(index)}Z`,
  }));
}

describe('MessageList initial-paint seed (real Virtuoso, 0px scroller)', () => {
  // Virtuoso's initial seed renders `initialItemCount` rows forward from the
  // `LAST` anchor; with the prior `Math.min(rows.length, 10)` this read past the
  // end of `data` and crashed `computeItemKey` on an undefined row. Each row
  // count below reproduced that crash before the cap was lowered to 1.
  it.each([1, 2, 5, 12])('mounts a %i-message conversation without crashing', (count) => {
    expect(() => render(<MessageList messages={buildMessages(count)} />)).not.toThrow();
  });

  it('renders the message log so first paint is never empty during the scroller stall', () => {
    const { getByRole, getAllByTestId } = render(<MessageList messages={buildMessages(2)} />);
    expect(getByRole('log', { name: 'Chat messages' })).toBeInTheDocument();
    expect(getAllByTestId('seeded-item').length).toBeGreaterThan(0);
  });
});
