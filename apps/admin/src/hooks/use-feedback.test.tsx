import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HOUR_MS, TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { requestUrl } from '@/test-utils/request-url';
import { feedbackKeys, useFeedbackInbox, useFeedbackDetail } from './use-feedback.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const INBOX_ROW = {
  id: testUuidV7(0xa),
  kind: 'bug',
  status: 'new',
  bodyPreview: 'The composer freezes when…',
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
  userId: testUuidV7(1),
};

const DETAIL = {
  id: INBOX_ROW.id,
  kind: 'bug',
  status: 'new',
  body: 'The composer freezes when I paste a very long message and then hit send.',
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
  userId: INBOX_ROW.userId,
};

type FetchInput = string | URL | Request;

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('feedbackKeys', () => {
  it('namespaces the inbox and detail keys under admin', () => {
    expect(feedbackKeys.all).toEqual(['admin', 'feedback']);
    expect(feedbackKeys.inbox({ status: 'new' })).toEqual(['admin', 'feedback', 'inbox', 'new']);
    expect(feedbackKeys.inbox({})).toEqual(['admin', 'feedback', 'inbox', 'all']);
    expect(feedbackKeys.detail(INBOX_ROW.id)).toEqual([
      'admin',
      'feedback',
      'detail',
      INBOX_ROW.id,
    ]);
  });
});

describe('useFeedbackInbox', () => {
  it('fetches one page through the typed client with the status in the query', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({ rows: [INBOX_ROW], nextCursor: null }, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFeedbackInbox({ status: 'new' }), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.pages[0]?.rows[0]?.id).toBe(INBOX_ROW.id);
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/feedback');
    expect(url).toContain('status=new');
  });

  it('pages with the cursor and reports hasNextPage from nextCursor', async () => {
    const cursor = testUuidV7(0xb);
    const fetchMock = vi.fn((input: FetchInput, _init?: RequestInit) => {
      const first = !requestUrl(input).includes('cursor=');
      return Promise.resolve(
        Response.json(
          first
            ? { rows: [INBOX_ROW], nextCursor: cursor }
            : { rows: [{ ...INBOX_ROW, id: cursor }], nextCursor: null },
          { status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFeedbackInbox({}), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(2);
    });
    expect(result.current.hasNextPage).toBe(false);
    expect(requestUrl(fetchMock.mock.calls[1]![0])).toContain(`cursor=${cursor}`);
  });

  it('rejects a drifting inbox shape loudly instead of rendering garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ rows: [{ id: 1 }] }, { status: 200 })))
    );

    const { result } = renderHook(() => useFeedbackInbox({}), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useFeedbackDetail', () => {
  it('fetches the full body through the typed client for a given id', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json(DETAIL, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFeedbackDetail(INBOX_ROW.id), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.body).toBe(DETAIL.body);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      `/api/admin/feedback/${INBOX_ROW.id}`
    );
  });

  it('stays idle while no id is selected', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFeedbackDetail(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a drifting detail shape loudly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ id: 1 }, { status: 200 })))
    );

    const { result } = renderHook(() => useFeedbackDetail(INBOX_ROW.id), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
