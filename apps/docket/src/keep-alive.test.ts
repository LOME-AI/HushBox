import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEEP_ALIVE_INTERVAL_MS, startKeepAlive } from './keep-alive';

let visible = true;

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
});

afterEach(() => {
  vi.useRealTimers();
});

function start(ping: () => Promise<unknown>): () => void {
  return startKeepAlive({ ping, isVisible: () => visible });
}

describe('startKeepAlive', () => {
  it('pings while the tab is visible', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const stop = start(ping);

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS);

    expect(ping).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stays quiet while the tab is hidden, so a forgotten tab lets the server die', async () => {
    const ping = vi.fn(() => Promise.resolve());
    visible = false;
    const stop = start(ping);

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS * 5);

    expect(ping).not.toHaveBeenCalled();
    stop();
  });

  it('pings again as soon as a hidden tab is looked at', () => {
    const ping = vi.fn(() => Promise.resolve());
    visible = false;
    const stop = start(ping);

    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(ping).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops pinging once stopped', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const stop = start(ping);

    stop();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS * 3);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(ping).not.toHaveBeenCalled();
  });

  it('pings the ping route through fetch and reads the real tab visibility by default', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    const stop = startKeepAlive();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledWith('/api/ping');
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stays quiet by default while the real tab is hidden', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    const stop = startKeepAlive();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('swallows a failed ping, because a server that already exited is the normal end', async () => {
    const ping = vi.fn(() => Promise.reject(new Error('connection refused')));
    const stop = start(ping);

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS);

    expect(ping).toHaveBeenCalledTimes(1);
    stop();
  });
});
