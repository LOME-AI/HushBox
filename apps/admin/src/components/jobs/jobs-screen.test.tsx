import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { requestUrl } from '@/test-utils/request-url';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { JobsScreen } from './jobs-screen.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const COUNTS = { pending: 2, running: 1, dead: 3, discarded: 1 };

const DUE_MS = TEST_DAY_START + 11 * HOUR_MS;

const DEAD_JOB = {
  id: testUuidV7(0xa),
  type: 'media.reclaimUser.v1',
  shard: 'bulk',
  status: 'dead',
  discarded: false,
  failures: 8,
  claims: 9,
  payload: { userId: testUuidV7(1) },
  errors: [
    {
      at: isoAt(TEST_DAY_START + 9 * HOUR_MS + 30 * MINUTE_MS),
      claim: 1,
      error: 'storage unavailable',
    },
    { at: isoAt(TEST_DAY_START + 10 * HOUR_MS), claim: 2, error: 'storage still unavailable' },
  ],
  nextAttemptAt: isoAt(DUE_MS),
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
  finishedAt: null,
};

const DISCARDED_JOB = {
  ...DEAD_JOB,
  id: testUuidV7(0xb),
  discarded: true,
};

const PENDING_JOB = {
  ...DEAD_JOB,
  id: testUuidV7(0xc),
  status: 'pending',
  errors: [],
};

// `jobs-screen.tsx` runs these ops BY NAME, so the fixture cannot use
// synthetic names — and a hand-written entry for a real op restates its
// class and inverse with nothing comparing them to the contract. Derived
// instead, so the inventory is what the tests below run against.
const CATALOG = opCatalog('job.redrive', 'job.discard', 'job.restore');

type JsonBody = Record<string, unknown>;

function stubApi(handler: (url: string) => JsonBody | Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const result = handler(requestUrl(input));
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function defaultHandler(rows: readonly JsonBody[]): (url: string) => JsonBody {
  return (url) => {
    if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
    if (url.includes('/admin/ops')) return CATALOG;
    return { rows, nextCursor: null };
  };
}

function renderScreen(): { queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <OpModalProvider>
        <JobsScreen />
      </OpModalProvider>
    </QueryClientProvider>
  );
  return { queryClient };
}

describe('JobsScreen', () => {
  it('renders the queue table with live tab counts from the dashboard read', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(within(table).getByText('media.reclaimUser.v1')).toBeInTheDocument();
    expect(within(table).getByText('8/9')).toBeInTheDocument();
    expect(within(table).getByText('storage still unavailable')).toBeInTheDocument();

    const tabs = screen.getByTestId(TEST_IDS.adminJobsTabs);
    await waitFor(() => {
      expect(within(tabs).getByRole('button', { name: /Dead\s*3/ })).toBeInTheDocument();
    });
    expect(within(tabs).getByRole('button', { name: /Pending\s*2/ })).toBeInTheDocument();
  });

  it('filters by status tab and by exact type', async () => {
    const fetchMock = stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: /^Dead/ }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=dead'))).toBe(
        true
      );
    });

    await userEvent.type(
      screen.getByTestId(TEST_IDS.adminJobsTypeFilter),
      'payment.verify.v1{enter}'
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('type=payment.verify.v1'))
      ).toBe(true);
    });
  });

  it('keeps the type filter placeholder short enough for narrow viewports', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    const input = await screen.findByTestId(TEST_IDS.adminJobsTypeFilter);
    expect(input).toHaveAttribute('placeholder', 'Exact type');
  });

  it('draws the type filter as the inline input', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    const input = await screen.findByTestId(TEST_IDS.adminJobsTypeFilter);
    expect(input).toHaveAttribute('data-slot', 'inline-input');
  });

  it('draws the dead-rows prompt in the error tone', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: /^Dead/ }));
    expect(await screen.findByText(/need a decision/)).toHaveClass(
      'bg-error/12',
      'text-error-text'
    );
  });

  it('requests status=discarded when the Discarded tab is selected', async () => {
    const fetchMock = stubApi(defaultHandler([DISCARDED_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: /^Discarded/ }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes('status=discarded'))
      ).toBe(true);
    });
  });

  it('marks the Dead tab count as attention styling while dead rows exist', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();

    const tabs = screen.getByTestId(TEST_IDS.adminJobsTabs);
    const deadTab = await waitFor(() => within(tabs).getByRole('button', { name: /Dead\s*3/ }));
    const count = within(deadTab).getByText('3');
    expect(count).toHaveClass('text-destructive');
    // A tab without the dead-as-inbox contract stays muted.
    const pendingTab = within(tabs).getByRole('button', { name: /Pending\s*2/ });
    expect(within(pendingTab).getByText('2')).toHaveClass('text-muted-foreground');
  });

  it('expands a row to show the payload JSON and the error history timeline', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    const detail = screen.getByTestId(TEST_IDS.adminJobDetail);
    expect(within(detail).getByTestId(TEST_IDS.adminJobPayload).textContent).toContain(
      testUuidV7(1)
    );
    const errors = within(detail).getByTestId(TEST_IDS.adminJobErrors);
    expect(within(errors).getByText('claim 1')).toBeInTheDocument();
    expect(within(errors).getByText('storage unavailable')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    expect(screen.queryByTestId(TEST_IDS.adminJobDetail)).not.toBeInTheDocument();
  });

  it('names the queue scroll region, so a keyboard reader can reach and scroll it', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(screen.getByRole('group', { name: 'Jobs' })).toContainElement(table);
  });

  it('keeps the queue scroll region square, so rounding does not clip or repaint the rows it scrolls', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(screen.getByRole('group', { name: 'Jobs' }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });

  it('makes the expanded payload its own named scroll region', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    expect(screen.getByRole('group', { name: 'Job payload' })).toBe(
      screen.getByTestId(TEST_IDS.adminJobPayload)
    );
  });

  it('shows an empty error history for a row with no errors', async () => {
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    expect(screen.getByText('No errors recorded.')).toBeInTheDocument();
  });

  it('starts the redrive op through the OpModal with the job id prefilled', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobRedrive));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Redrive dead job')).toBeInTheDocument();
    expect(within(modal).getByLabelText('jobId')).toHaveValue(DEAD_JOB.id);
  });

  it('states the redrive op has no undo, and why, before the operator runs it', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobRedrive));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('No undo');
  });

  it('offers Discard on a dead row and Restore on a discarded row', async () => {
    stubApi(defaultHandler([DEAD_JOB, DISCARDED_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    expect(screen.getByTestId(TEST_IDS.adminJobDiscard)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobRestore));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Restore discarded job')).toBeInTheDocument();
  });

  it('offers no inline actions on a pending row', async () => {
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(screen.queryByTestId(TEST_IDS.adminJobRedrive)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.adminJobRestore)).not.toBeInTheDocument();
  });

  it('loads the next cursor page from the Load more button', async () => {
    const cursor = testUuidV7(0xff);
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      if (url.includes('cursor=')) return { rows: [PENDING_JOB], nextCursor: null };
      return { rows: [DEAD_JOB], nextCursor: cursor };
    });
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobsLoadMore));
    await waitFor(() => {
      expect(screen.getAllByText('media.reclaimUser.v1')).toHaveLength(2);
    });
    expect(screen.queryByTestId(TEST_IDS.adminJobsLoadMore)).not.toBeInTheDocument();
  });

  it('teaches in the empty state', async () => {
    stubApi(defaultHandler([]));
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminJobsEmpty)).toHaveTextContent(/redriven/);
  });

  it('shows the rate-limited notice on a 429 queue read', async () => {
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      return Response.json(
        { code: 'RATE_LIMITED', details: { retryAfterSeconds: 12 } },
        { status: 429 }
      );
    });
    renderScreen();
    expect(await screen.findByTestId(TEST_IDS.adminRateLimited)).toBeInTheDocument();
  });

  it('shows a plain error state on a non-429 failure', async () => {
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    });
    renderScreen();
    expect(await screen.findByText('Failed to load the job queue.')).toBeInTheDocument();
  });

  it('invalidates the queue and counts on Refresh', async () => {
    const fetchMock = stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    const before = fetchMock.mock.calls.length;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobsRefresh));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
  });
});

describe('JobsScreen extras', () => {
  it('starts the discard op through the OpModal', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobDiscard));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Discard dead job')).toBeInTheDocument();
    expect(within(modal).getByLabelText('jobId')).toHaveValue(DEAD_JOB.id);
  });

  it('states no such case for the discard op, whose effect the operator owns', async () => {
    stubApi(defaultHandler([DEAD_JOB]));
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobDiscard));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).not.toHaveTextContent('No undo');
  });

  it('retries a rate-limited queue read from the notice', async () => {
    let limited = true;
    stubApi((url) => {
      if (url.includes('/admin/dashboard')) return { jobs: COUNTS, recentActions: [] };
      if (limited) {
        return Response.json(
          { code: 'RATE_LIMITED', details: { retryAfterSeconds: 30 } },
          { status: 429 }
        );
      }
      return { rows: [DEAD_JOB], nextCursor: null };
    });
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminRateLimited);
    limited = false;

    await userEvent.click(screen.getByTestId(TEST_IDS.adminRateLimitedRetry));
    expect(await screen.findByTestId(TEST_IDS.adminJobsTable)).toBeInTheDocument();
  });

  it('renders the dead tab without the inbox badge while counts are still loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, _init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/admin/dashboard')) {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(Response.json({ rows: [DEAD_JOB], nextCursor: null }));
      })
    );
    renderScreen();
    await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByRole('button', { name: 'Dead' }));
    await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(screen.queryByText(/need a decision/)).not.toBeInTheDocument();
  });
});

/**
 * The queue row's Due cell, located through the header's own position rather
 * than a fixed index, so a column added beside it cannot make an assertion on
 * the cell's content silently name a different column.
 */
function dueCellOf(table: HTMLElement): HTMLElement {
  const dueIndex = within(table)
    .getAllByRole('columnheader')
    .findIndex((header) => header.textContent === 'Due');
  if (dueIndex === -1) throw new Error('the table declares no Due column');
  const bodyRow = within(table).getAllByRole('row').at(1);
  if (bodyRow === undefined) throw new Error('the table rendered no body row');
  const cell = within(bodyRow).getAllByRole('cell').at(dueIndex);
  if (cell === undefined) throw new Error('the body row rendered no Due cell');
  return cell;
}

// Every status the job state machine holds other than `pending` — the only one
// for which `nextAttemptAt` selects the row for a coming attempt. On each of
// these the stored instant is a spent artefact of the last scheduled attempt.
const NOT_WAITING_STATUSES = ['running', 'succeeded', 'cancelled', 'dead'] as const;

describe('JobsScreen — when the row is due', () => {
  it('renders the due instant as absolute UTC, beside the enqueued instant', async () => {
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(within(table).getByRole('columnheader', { name: 'Due' })).toBeInTheDocument();
    expect(
      within(table).getByText(PENDING_JOB.nextAttemptAt.replace('T', ' ').slice(0, 16))
    ).toBeInTheDocument();
  });

  it('says how long a not-yet-due row still has to wait', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DUE_MS - 28 * MINUTE_MS);
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(within(table).getByText('in 28m')).toBeInTheDocument();
    clock.mockRestore();
  });

  it('marks a past-due row overdue in words, so colour is never the only cue', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DUE_MS + 42 * MINUTE_MS);
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    expect(within(table).getByText('42m overdue')).toBeInTheDocument();
    clock.mockRestore();
  });

  it('calls a row due at this very instant due, not yet late', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DUE_MS);
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
    const marker = within(table).getByText('due now');
    expect(marker).toBeInTheDocument();
    expect(marker).not.toHaveClass('text-destructive');
    clock.mockRestore();
  });

  it('spans the expanded detail row across every column the header declares', async () => {
    stubApi(defaultHandler([PENDING_JOB]));
    renderScreen();
    const table = await screen.findByTestId(TEST_IDS.adminJobsTable);

    await userEvent.click(screen.getByTestId(TEST_IDS.adminJobExpand));
    const detail = screen.getByTestId(TEST_IDS.adminJobDetail);
    expect(within(detail).getByRole('cell')).toHaveAttribute(
      'colspan',
      String(within(table).getAllByRole('columnheader').length)
    );
  });

  it.each(NOT_WAITING_STATUSES)(
    'renders no due time on a %s row, which is not waiting to run',
    async (status) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(DUE_MS + 42 * MINUTE_MS);
      stubApi(defaultHandler([{ ...PENDING_JOB, status }]));
      renderScreen();

      const table = await screen.findByTestId(TEST_IDS.adminJobsTable);
      expect(dueCellOf(table)).toBeEmptyDOMElement();
      clock.mockRestore();
    }
  );
});
