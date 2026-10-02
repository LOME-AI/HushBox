import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { requestUrl } from '@/test-utils/request-url';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { FeedbackTable } from './feedback-table.js';
import type { FeedbackInboxRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = opCatalog('feedback.setStatus');

const ROW_A: FeedbackInboxRowWire = {
  id: testUuidV7(0xa),
  kind: 'bug',
  status: 'new',
  bodyPreview: 'The composer freezes when…',
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
  userId: testUuidV7(1),
};

const ROW_B: FeedbackInboxRowWire = {
  id: testUuidV7(0xb),
  kind: 'idea',
  status: 'triaged',
  bodyPreview: 'Add a keyboard shortcut for…',
  createdAt: isoAt(TEST_DAY_START + 8 * HOUR_MS),
  userId: testUuidV7(2),
};

const FULL_BODY = 'The composer freezes when I paste a very long message and then hit send twice.';

function detailOf(id: string): Record<string, unknown> {
  return {
    id,
    kind: 'bug',
    status: 'new',
    body: FULL_BODY,
    createdAt: ROW_A.createdAt,
    userId: ROW_A.userId,
  };
}

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/admin/feedback/')) {
        const id = url.split('/admin/feedback/')[1]!.split('?')[0]!;
        return Promise.resolve(Response.json(detailOf(id)));
      }
      return Promise.resolve(Response.json(CATALOG));
    })
  );
}

function renderTable(props: {
  expandedId?: string | undefined;
  onToggle?: (id: string) => void;
}): void {
  stubApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <FeedbackTable
          rows={[ROW_A, ROW_B]}
          expandedId={props.expandedId}
          onToggle={props.onToggle ?? vi.fn()}
        />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('FeedbackTable', () => {
  it('names the reports scroll region, so a keyboard reader can reach and scroll it', () => {
    renderTable({});
    expect(screen.getByRole('group', { name: 'Feedback reports' })).toContainElement(
      screen.getByTestId(TEST_IDS.adminFeedbackTable)
    );
  });

  it('keeps the reports scroll region square, so rounding does not clip or repaint the rows it scrolls', () => {
    renderTable({});
    expect(screen.getByRole('group', { name: 'Feedback reports' }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });

  it('renders a preview row per feedback', () => {
    renderTable({});
    const table = screen.getByTestId(TEST_IDS.adminFeedbackTable);
    expect(within(table).getByText('The composer freezes when…')).toBeInTheDocument();
    expect(within(table).getByText('Add a keyboard shortcut for…')).toBeInTheDocument();
    expect(within(table).getByText('idea')).toBeInTheDocument();
  });

  it("draws a report's kind as a neutral badge", () => {
    renderTable({});
    const table = screen.getByTestId(TEST_IDS.adminFeedbackTable);
    expect(within(table).getByText('idea').closest('[data-slot="badge"]')).toHaveClass(
      'bg-muted',
      'text-muted-foreground'
    );
  });

  it("keeps a report's kind in monospace", () => {
    renderTable({});
    const table = screen.getByTestId(TEST_IDS.adminFeedbackTable);
    expect(within(table).getByText('idea')).toHaveClass('font-mono');
  });

  it('marks the chevron collapsed when no row is expanded', () => {
    renderTable({});
    for (const toggle of screen.getAllByTestId(TEST_IDS.adminFeedbackExpand)) {
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByTestId(TEST_IDS.adminFeedbackDetail)).not.toBeInTheDocument();
  });

  it('renders the detail row and an expanded chevron for the expanded row only', () => {
    renderTable({ expandedId: ROW_A.id });
    const toggles = screen.getAllByTestId(TEST_IDS.adminFeedbackExpand);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTestId(TEST_IDS.adminFeedbackDetail)).toHaveLength(1);
  });

  it('calls onToggle with the row id when the chevron is clicked', async () => {
    const onToggle = vi.fn();
    renderTable({ onToggle });
    await userEvent.click(screen.getAllByTestId(TEST_IDS.adminFeedbackExpand)[0]!);
    expect(onToggle).toHaveBeenCalledWith(ROW_A.id);
  });
});
