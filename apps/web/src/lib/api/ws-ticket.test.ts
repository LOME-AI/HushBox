import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from './api.js';
import { mintUpgradeTicket } from './ws-ticket.js';

type FetchCall = [Request | string | URL, RequestInit | undefined];

vi.mock(import('./api.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock(import('@/capacitor/platform.js'), () => ({
  getPlatform: () => 'web',
}));

function requestOf(call: FetchCall): { url: string; method: string } {
  const [input, init] = call;
  if (input instanceof Request) return { url: input.url, method: input.method };
  return { url: String(input), method: init?.method ?? 'GET' };
}

describe('mintUpgradeTicket', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the conversation's websocket-ticket route", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ ticket: 'ticket-1' }, { status: 200 }));

    await mintUpgradeTicket('conv-42');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestOf(fetchSpy.mock.calls[0] as FetchCall)).toEqual({
      url: 'http://localhost:8787/conversations/conv-42/websocket-ticket',
      method: 'POST',
    });
  });

  it('resolves to the ticket the server minted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ ticket: 'ticket-from-server' }, { status: 200 })
    );

    await expect(mintUpgradeTicket('conv-42')).resolves.toBe('ticket-from-server');
  });

  it('rejects with the API error when the server refuses the mint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 })
    );

    await expect(mintUpgradeTicket('conv-42')).rejects.toBeInstanceOf(ApiError);
  });
});
