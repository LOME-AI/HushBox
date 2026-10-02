import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { useAuditEvents } from './use-audit-events';
import type { AuditEventStream } from './use-audit-events';
import type { Snapshot } from '@/server/audit-service';
import type { FindingJson } from '@hushbox/docket';

function madeSnapshot(findings: readonly FindingJson[]): Snapshot {
  return {
    audit: {
      layout_version: 1,
      date: '2026-07-30',
      title: 'Codebase audit',
      scope: 'The whole repository',
      body: '',
    },
    name: '2026-07-30',
    findings,
    validation: [],
    audits: ['2026-07-30'],
  };
}

const AUDIT = '2026-07-30';

interface FakeStream extends AuditEventStream {
  send(payload: unknown): void;
  raw(data: string): void;
  connect(): void;
  drop(): void;
  readonly closed: () => boolean;
}

function makeStream(): FakeStream {
  const messages: ((event: { data: string }) => void)[] = [];
  const opens: (() => void)[] = [];
  const errors: (() => void)[] = [];
  let closed = false;
  const stream: FakeStream = {
    addEventListener(type: string, listener: unknown) {
      if (type === 'message') messages.push(listener as (event: { data: string }) => void);
      if (type === 'open') opens.push(listener as () => void);
      if (type === 'error') errors.push(listener as () => void);
    },
    close() {
      closed = true;
    },
    send(payload) {
      for (const listener of messages) listener({ data: JSON.stringify(payload) });
    },
    raw(data) {
      for (const listener of messages) listener({ data });
    },
    connect() {
      for (const listener of opens) listener();
    },
    drop() {
      for (const listener of errors) listener();
    },
    closed: () => closed,
  };
  return stream;
}

function fakeStream(): { open: (url: string) => FakeStream; opened: string[]; stream: FakeStream } {
  const stream = makeStream();
  const opened: string[] = [];
  return {
    stream,
    opened,
    open: (url) => {
      opened.push(url);
      return stream;
    },
  };
}

const EVENTS_ROUTE = /^\/api\/audits\/([^/]+)\/events$/;

/** One stream per audit, so a switch is observable as two distinct streams. */
function auditStreams(): {
  open: (url: string) => FakeStream;
  opened: string[];
  of: (audit: string) => FakeStream;
} {
  const byAudit = new Map<string, FakeStream>();
  const opened: string[] = [];
  const of = (audit: string): FakeStream => {
    const held = byAudit.get(audit);
    if (held !== undefined) return held;
    const made = makeStream();
    byAudit.set(audit, made);
    return made;
  };
  return {
    opened,
    of,
    open: (url) => {
      opened.push(url);
      const match = EVENTS_ROUTE.exec(url);
      if (match === null) throw new Error(`not an audit event stream: ${url}`);
      return of(match[1] ?? '');
    },
  };
}

describe('useAuditEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listens on the named audit's stream", () => {
    const { open, opened } = fakeStream();

    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot: vi.fn() });
    });

    expect(opened).toEqual(['/api/audits/2026-07-30/events']);
  });

  it('closes the stream when the console is gone', () => {
    const { open, stream } = fakeStream();

    const { unmount } = renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot: vi.fn() });
    });
    unmount();

    expect(stream.closed()).toBe(true);
  });

  it('patches the finding a change on disk names', async () => {
    const { open, stream } = fakeStream();
    const changed = makeFinding({ id: 'AI-1', state: 'ruled' });
    const onFinding = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-2' }), changed])),
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });

    await waitFor(() => {
      expect(onFinding).toHaveBeenCalledWith(changed);
    });
    expect(onFinding).toHaveBeenCalledTimes(1);
  });

  it('reads the audit twice for a burst, not once per change', async () => {
    const { open, stream } = fakeStream();
    const held: { release: (() => void) | null } = { release: null };
    const loadSnapshot = vi.fn(() => {
      if (held.release === null) {
        return new Promise<Snapshot>((resolve) => {
          held.release = () => {
            resolve(madeSnapshot([makeFinding({ id: 'AI-1' })]));
          };
        });
      }
      return Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })]));
    });
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    await waitFor(() => {
      expect(held.release).not.toBeNull();
    });
    stream.send({ type: 'finding', id: 'AI-2' });
    stream.send({ type: 'finding', id: 'AI-3' });
    held.release?.();

    await waitFor(() => {
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it('patches every finding a burst named', async () => {
    const { open, stream } = fakeStream();
    const onFinding = vi.fn();
    const findings = [makeFinding({ id: 'AI-1' }), makeFinding({ id: 'AI-2' })];
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot(findings)),
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    stream.send({ type: 'finding', id: 'AI-2' });

    await waitFor(() => {
      expect(onFinding.mock.calls.flat()).toEqual(expect.arrayContaining(findings));
    });
  });

  it('patches nothing for a finding the audit no longer holds', async () => {
    const { open, stream } = fakeStream();
    const onFinding = vi.fn();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-2' })])));
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding, openStream: open, loadSnapshot });
    });

    stream.send({ type: 'finding', id: 'AI-1' });

    await waitFor(() => {
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('reads nothing for a removal, which the console has no card to patch for', async () => {
    const { open, stream } = fakeStream();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([])));
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot });
    });

    stream.send({ type: 'removed', id: 'AI-1' });
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('reads nothing for a change to the audit header', async () => {
    const { open, stream } = fakeStream();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([])));
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot });
    });

    stream.send({ type: 'audit', id: '2026-07-30' });
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('ignores a message it cannot read', async () => {
    const { open, stream } = fakeStream();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([])));
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot });
    });

    stream.raw('not json at all');
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('stays quiet when the audit cannot be read', async () => {
    const { open, stream } = fakeStream();
    const onFinding = vi.fn();
    const loadSnapshot = vi.fn(() => Promise.reject(new Error('connection refused')));
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding, openStream: open, loadSnapshot });
    });

    stream.send({ type: 'finding', id: 'AI-1' });

    await waitFor(() => {
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('patches nothing for a read that lands after the console is gone', async () => {
    const { open, stream } = fakeStream();
    const held: { release: ((snapshot: Snapshot) => void) | null } = { release: null };
    const onFinding = vi.fn();
    const { unmount } = renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot: () =>
          new Promise<Snapshot>((resolve) => {
            held.release = resolve;
          }),
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    await waitFor(() => {
      expect(held.release).not.toBeNull();
    });
    unmount();
    held.release?.(madeSnapshot([makeFinding({ id: 'AI-1' })]));
    await Promise.resolve();

    expect(onFinding).not.toHaveBeenCalled();
  });

  it('stays quiet when the console API refuses the audit', async () => {
    const listeners: ((event: { data: string }) => void)[] = [];
    class StubEventSource {
      addEventListener(_type: string, listener: (event: { data: string }) => void): void {
        listeners.push(listener);
      }
      close(): void {
        // The default path under test is the open, not the close.
      }
    }
    vi.stubGlobal('EventSource', StubEventSource);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    vi.stubGlobal('fetch', fetchMock);
    const onFinding = vi.fn();

    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding });
    });
    for (const listener of listeners) {
      listener({ data: JSON.stringify({ type: 'finding', id: 'AI-1' }) });
    }

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('reads nothing while the tab is hidden, so a forgotten tab is never activity', async () => {
    const { open, stream } = fakeStream();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })])));
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot,
        isVisible: () => false,
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('catches up on what arrived while hidden as soon as the reader comes back', async () => {
    const { open, stream } = fakeStream();
    const finding = makeFinding({ id: 'AI-1' });
    const onFinding = vi.fn();
    const visibility = { value: false };
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot([finding])),
        isVisible: () => visibility.value,
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    await Promise.resolve();
    visibility.value = true;
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(onFinding).toHaveBeenCalledWith(finding);
    });
  });

  it('reads nothing when the reader leaves rather than arrives', async () => {
    const { open, stream } = fakeStream();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })])));
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot,
        isVisible: () => false,
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('stops watching visibility once the console is gone', async () => {
    const { open, stream } = fakeStream();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })])));
    const { unmount } = renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot,
        isVisible: () => false,
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    unmount();
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('takes visibility from the document when nothing is injected', async () => {
    const { open, stream } = fakeStream();
    const finding = makeFinding({ id: 'AI-1' });
    const onFinding = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot([finding])),
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });

    // happy-dom reports a document nobody has hidden, which is the reader being
    // present: the patch lands without the seam being injected at all.
    await waitFor(() => {
      expect(onFinding).toHaveBeenCalledWith(finding);
    });
    expect(document.visibilityState).toBe('visible');
  });

  it('reports the audit unreachable once the stream drops', () => {
    const { open, stream } = fakeStream();
    const onLive = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot: vi.fn(),
        onLive,
      });
    });

    stream.drop();

    expect(onLive).toHaveBeenCalledWith(false);
  });

  it('reports the audit reachable when the stream first connects', () => {
    const { open, stream } = fakeStream();
    const onLive = vi.fn();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([])));
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding: vi.fn(), openStream: open, loadSnapshot, onLive });
    });

    stream.connect();

    expect(onLive).toHaveBeenLastCalledWith(true);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('goes on reporting the audit unreachable until a stream that came back has re-read it', () => {
    const { open, stream } = fakeStream();
    const held: { release: ((snapshot: Snapshot) => void) | null } = { release: null };
    const onLive = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot: () =>
          new Promise<Snapshot>((resolve) => {
            held.release = resolve;
          }),
        onLive,
      });
    });

    stream.drop();
    stream.connect();

    expect(onLive).toHaveBeenLastCalledWith(false);
  });

  it('re-reads the whole audit when the stream comes back, because nothing names what moved while it was down', async () => {
    const { open, stream } = fakeStream();
    const findings = [makeFinding({ id: 'AI-1' }), makeFinding({ id: 'AI-2' })];
    const onFinding = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot(findings)),
        onLive: vi.fn(),
      });
    });

    stream.drop();
    stream.connect();

    await waitFor(() => {
      expect(onFinding.mock.calls.flat()).toEqual(expect.arrayContaining(findings));
    });
  });

  it('reports the audit reachable again once the re-read after a reconnect lands', async () => {
    const { open, stream } = fakeStream();
    const onLive = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })])),
        onLive,
      });
    });

    stream.drop();
    stream.connect();

    await waitFor(() => {
      expect(onLive).toHaveBeenLastCalledWith(true);
    });
  });

  it('keeps the re-read a reconnect owes until the reader is back, so a hidden tab is never activity', async () => {
    const { open, stream } = fakeStream();
    const finding = makeFinding({ id: 'AI-1' });
    const onFinding = vi.fn();
    const visibility = { value: false };
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([finding])));
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding,
        openStream: open,
        loadSnapshot,
        isVisible: () => visibility.value,
        onLive: vi.fn(),
      });
    });

    stream.drop();
    stream.connect();
    await Promise.resolve();
    expect(loadSnapshot).not.toHaveBeenCalled();

    visibility.value = true;
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(onFinding).toHaveBeenCalledWith(finding);
    });
  });

  it('still owes the re-read when the one a reconnect asked for could not be made', async () => {
    const { open, stream } = fakeStream();
    const finding = makeFinding({ id: 'AI-1' });
    const onFinding = vi.fn();
    const onLive = vi.fn();
    const loadSnapshot = vi.fn(() =>
      loadSnapshot.mock.calls.length === 1
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(madeSnapshot([finding]))
    );
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding, openStream: open, loadSnapshot, onLive });
    });

    stream.drop();
    stream.connect();
    await waitFor(() => {
      expect(onLive).toHaveBeenLastCalledWith(false);
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(onFinding).toHaveBeenCalledWith(finding);
    });
  });

  it('still owes a named change when the read that would have carried it could not be made', async () => {
    const { open, stream } = fakeStream();
    const first = makeFinding({ id: 'AI-1' });
    const second = makeFinding({ id: 'AI-2' });
    const onFinding = vi.fn();
    const loadSnapshot = vi.fn(() =>
      loadSnapshot.mock.calls.length === 1
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(madeSnapshot([first, second]))
    );
    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding, openStream: open, loadSnapshot, onLive: vi.fn() });
    });

    stream.send({ type: 'finding', id: 'AI-1' });
    await waitFor(() => {
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });
    stream.send({ type: 'finding', id: 'AI-2' });

    await waitFor(() => {
      expect(onFinding.mock.calls.flat()).toEqual(expect.arrayContaining([first, second]));
    });
  });

  it('reports a re-read it could not make rather than swallowing it', async () => {
    const { open, stream } = fakeStream();
    const onLive = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot: () => Promise.reject(new Error('gone')),
        onLive,
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });

    await waitFor(() => {
      expect(onLive).toHaveBeenCalledWith(false);
    });
  });

  it('reports a re-read that landed, so a recovered server clears the warning', async () => {
    const { open, stream } = fakeStream();
    const onLive = vi.fn();
    renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot: () => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })])),
        onLive,
      });
    });

    stream.send({ type: 'finding', id: 'AI-1' });

    await waitFor(() => {
      expect(onLive).toHaveBeenCalledWith(true);
    });
  });

  it('says nothing about the connection once the console is gone', () => {
    const { open, stream } = fakeStream();
    const onLive = vi.fn();
    const { unmount } = renderHook(() => {
      useAuditEvents({
        audit: AUDIT,
        onFinding: vi.fn(),
        openStream: open,
        loadSnapshot: vi.fn(),
        onLive,
      });
    });

    unmount();
    stream.drop();

    expect(onLive).not.toHaveBeenCalled();
  });

  it('reads the audit through the console API when nothing is injected', async () => {
    const listeners: ((event: { data: string }) => void)[] = [];
    class StubEventSource {
      addEventListener(_type: string, listener: (event: { data: string }) => void): void {
        listeners.push(listener);
      }
      close(): void {
        // The default path under test is the open, not the close.
      }
    }
    vi.stubGlobal('EventSource', StubEventSource);
    const finding = makeFinding({ id: 'AI-1' });
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(Response.json(madeSnapshot([finding]), { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const onFinding = vi.fn();

    renderHook(() => {
      useAuditEvents({ audit: AUDIT, onFinding });
    });
    for (const listener of listeners) {
      listener({ data: JSON.stringify({ type: 'finding', id: 'AI-1' }) });
    }

    await waitFor(() => {
      expect(onFinding).toHaveBeenCalledWith(finding);
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/audits/2026-07-30/audit']);
  });

  it('closes the stream of the audit it moved off and opens the new one', () => {
    const streams = auditStreams();
    const onFinding = vi.fn();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([])));

    const { rerender } = renderHook(
      ({ audit }: { audit: string }) => {
        useAuditEvents({ audit, onFinding, openStream: streams.open, loadSnapshot });
      },
      { initialProps: { audit: '2026-07-30' } }
    );
    rerender({ audit: '2026-09-01' });

    expect(streams.opened).toEqual([
      '/api/audits/2026-07-30/events',
      '/api/audits/2026-09-01/events',
    ]);
    expect(streams.of('2026-07-30').closed()).toBe(true);
    expect(streams.of('2026-09-01').closed()).toBe(false);
  });

  it('drops an event the audit it moved off announces after the switch', async () => {
    const streams = auditStreams();
    const onFinding = vi.fn();
    const loadSnapshot = vi.fn(() => Promise.resolve(madeSnapshot([makeFinding({ id: 'AI-1' })])));

    const { rerender } = renderHook(
      ({ audit }: { audit: string }) => {
        useAuditEvents({ audit, onFinding, openStream: streams.open, loadSnapshot });
      },
      { initialProps: { audit: '2026-07-30' } }
    );
    rerender({ audit: '2026-09-01' });
    streams.of('2026-07-30').send({ type: 'finding', id: 'AI-1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(onFinding).not.toHaveBeenCalled();
  });

  it('drops a read the audit it moved off had in flight when the switch lands', async () => {
    const streams = auditStreams();
    const onFinding = vi.fn();
    const held: { release: ((snapshot: Snapshot) => void) | null } = { release: null };
    const loadSnapshot = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          held.release = resolve;
        })
    );

    const { rerender } = renderHook(
      ({ audit }: { audit: string }) => {
        useAuditEvents({ audit, onFinding, openStream: streams.open, loadSnapshot });
      },
      { initialProps: { audit: '2026-07-30' } }
    );
    streams.of('2026-07-30').send({ type: 'finding', id: 'AI-1' });
    await waitFor(() => {
      expect(held.release).not.toBeNull();
    });
    rerender({ audit: '2026-09-01' });
    held.release?.(madeSnapshot([makeFinding({ id: 'AI-1' })]));
    await Promise.resolve();
    await Promise.resolve();

    expect(onFinding).not.toHaveBeenCalled();
  });

  it('watches nothing until an audit is named', () => {
    const streams = auditStreams();

    renderHook(() => {
      useAuditEvents({
        audit: null,
        onFinding: vi.fn(),
        openStream: streams.open,
        loadSnapshot: vi.fn(),
      });
    });

    expect(streams.opened).toEqual([]);
  });
});
