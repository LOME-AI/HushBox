import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuditFixture, type AuditFixture } from '../test-utils/audit-fixture';
import { fakeWatchers } from '../test-utils/fake-watchers';
import { createEventHub } from './events';
import { watchAudit } from './watch-audit';
import type { DocketEvent, OpenWatcher } from './events';
import type { WatchDeps } from './watch-audit';

const FIRST = '/audits/2026-07-30';
const SECOND = '/audits/2026-09-01';

/**
 * The real watcher over a fake filesystem, so the close the hub performs is
 * observed on the platform handles themselves rather than on a stand-in.
 */
function realWatchersOverFakeFs(): {
  open: OpenWatcher;
  handles: () => { open: number; closed: number };
} {
  let opened = 0;
  let closed = 0;
  const deps: WatchDeps = {
    exists: (): boolean => true,
    watch: ((): { close: () => void } => {
      opened += 1;
      return {
        close: (): void => {
          closed += 1;
        },
      };
    }) as unknown as WatchDeps['watch'],
  };
  return {
    open: (auditDir, onEvent) => watchAudit(auditDir, onEvent, deps),
    handles: () => ({ open: opened, closed }),
  };
}

describe('createEventHub', () => {
  it('delivers an event to every subscriber of that audit', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(FIRST, first);
    hub.subscribe(FIRST, second);

    watchers.send(FIRST, { type: 'finding', id: 'AC-1' });

    expect(first).toHaveBeenCalledWith({ type: 'finding', id: 'AC-1' });
    expect(second).toHaveBeenCalledWith({ type: 'finding', id: 'AC-1' });
  });

  it('keeps the events of one audit out of the subscribers of another', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);
    const here = vi.fn();
    const elsewhere = vi.fn();
    hub.subscribe(FIRST, here);
    hub.subscribe(SECOND, elsewhere);

    watchers.send(FIRST, { type: 'finding', id: 'AC-1' });

    expect(here).toHaveBeenCalledTimes(1);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it('opens one watcher per audit however many subscribers it has', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);

    hub.subscribe(FIRST, vi.fn());
    hub.subscribe(FIRST, vi.fn());
    hub.subscribe(SECOND, vi.fn());

    expect(watchers.opened).toEqual([FIRST, SECOND]);
  });

  it('stops delivering once a subscriber unsubscribes', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);
    const listener = vi.fn();
    const staying = vi.fn();
    const unsubscribe = hub.subscribe(FIRST, listener);
    hub.subscribe(FIRST, staying);

    unsubscribe();
    watchers.send(FIRST, { type: 'audit', id: '2026-07-30' });

    expect(listener).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it('keeps the watcher open while another subscriber of that audit remains', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);
    const unsubscribe = hub.subscribe(FIRST, vi.fn());
    hub.subscribe(FIRST, vi.fn());

    unsubscribe();

    expect(watchers.closed).toEqual([]);
  });

  it('closes every handle the watcher opened when the last subscriber goes', () => {
    const watchers = realWatchersOverFakeFs();
    const hub = createEventHub(watchers.open);

    const unsubscribe = hub.subscribe(FIRST, vi.fn());
    const armed = watchers.handles();
    unsubscribe();

    expect(armed.open).toBeGreaterThan(0);
    expect(watchers.handles().closed).toBe(armed.open);
  });

  it('leaves the watcher of another audit alone when one audit empties', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);
    const unsubscribe = hub.subscribe(FIRST, vi.fn());
    hub.subscribe(SECOND, vi.fn());

    unsubscribe();

    expect(watchers.closed).toEqual([FIRST]);
  });

  it('opens a fresh watcher when an audit is subscribed to again', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);

    hub.subscribe(FIRST, vi.fn())();
    const listener = vi.fn();
    hub.subscribe(FIRST, listener);
    watchers.send(FIRST, { type: 'finding', id: 'AC-1' });

    expect(watchers.opened).toEqual([FIRST, FIRST]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts one departure however often its unsubscribe is called', () => {
    const watchers = fakeWatchers();
    const hub = createEventHub(watchers.open);
    const unsubscribe = hub.subscribe(FIRST, vi.fn());

    unsubscribe();
    unsubscribe();
    hub.subscribe(FIRST, vi.fn());
    unsubscribe();

    expect(watchers.closed).toEqual([FIRST]);
  });
});

describe('the hub with no watcher opener injected', () => {
  let fixture: AuditFixture;

  beforeEach(async () => {
    fixture = await createAuditFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('watches the audit directory it is handed', async () => {
    const hub = createEventHub();
    const seen: DocketEvent[] = [];
    const unsubscribe = hub.subscribe(fixture.auditDir, (event) => seen.push(event));

    await fixture.writeFinding('AC-1', { title: 'Edited by the agent' });

    await vi.waitFor(() => {
      expect(seen.some((event) => event.id === 'AC-1')).toBe(true);
    }, 4000);
    unsubscribe();
  });
});
