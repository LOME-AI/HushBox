import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  TEST_DAY_START,
  isoAt,
  testUuidV7,
} from '@hushbox/shared/test-time';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { IssuesTable } from './issues-table.js';
import type { NewsletterIssueWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = opCatalog('newsletter.cancel');

const SCHEDULED: NewsletterIssueWire = {
  id: testUuidV7(0xa),
  subject: 'July product notes',
  status: 'scheduled',
  scheduledAt: isoAt(TEST_DAY_START + 33 * DAY_MS + 9 * HOUR_MS),
  canceledAt: null,
  sentAt: null,
  recipientCount: null,
  sentCount: null,
  failedCount: null,
  createdBy: 'admin@hushbox.ai',
  createdAt: isoAt(TEST_DAY_START + 30 * DAY_MS + 9 * HOUR_MS),
};

const SENT: NewsletterIssueWire = {
  id: testUuidV7(0xb),
  subject: 'June recap',
  status: 'sent',
  scheduledAt: isoAt(TEST_DAY_START + 3 * DAY_MS + 9 * HOUR_MS),
  canceledAt: null,
  sentAt: isoAt(TEST_DAY_START + 3 * DAY_MS + 9 * HOUR_MS + MINUTE_MS),
  recipientCount: 41,
  sentCount: 40,
  failedCount: 1,
  createdBy: 'admin@hushbox.ai',
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
};

function renderTable(rows: readonly NewsletterIssueWire[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <IssuesTable rows={rows} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('IssuesTable', () => {
  it('names its scroll region for the issues it holds', () => {
    renderTable([SCHEDULED, SENT]);
    expect(screen.getByRole('group', { name: 'Issues' })).toBe(
      screen.getByTestId(TEST_IDS.adminNewsletterTable).parentElement
    );
  });

  it('renders one dense row per issue with subject and status', () => {
    renderTable([SCHEDULED, SENT]);
    const table = screen.getByTestId(TEST_IDS.adminNewsletterTable);
    expect(within(table).getByText('July product notes')).toBeInTheDocument();
    expect(within(table).getByText('June recap')).toBeInTheDocument();
    expect(within(table).getByText('scheduled')).toBeInTheDocument();
    expect(within(table).getByText('sent')).toBeInTheDocument();
  });

  it('shows sent/recipient/failed counts and em-dashes the not-yet-sent row', () => {
    renderTable([SCHEDULED, SENT]);
    const table = screen.getByTestId(TEST_IDS.adminNewsletterTable);
    expect(within(table).getByText('40 / 41')).toBeInTheDocument();
    expect(within(table).getByText('1')).toBeInTheDocument();
  });

  it('offers Cancel only on scheduled rows', () => {
    renderTable([SCHEDULED, SENT]);
    expect(screen.getAllByTestId(TEST_IDS.adminNewsletterCancel)).toHaveLength(1);
  });

  it('launches the cancel op through the OpModal with the row issueId prefilled', async () => {
    renderTable([SCHEDULED]);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterCancel));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Cancel scheduled newsletter issue')).toBeInTheDocument();
    expect(within(modal).getByLabelText('issueId')).toHaveValue(SCHEDULED.id);
  });
});
