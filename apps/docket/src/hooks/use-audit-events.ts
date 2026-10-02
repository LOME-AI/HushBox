import { useEffect } from 'react';
import { auditEventsUrl, auditSnapshotUrl } from '@/api/audit-routes';
// Type-only: the client reads exactly what the api plugin serves, so the shape
// has one definition rather than a hand-kept copy on this side.
import type { Snapshot } from '@/server/audit-service';
import type { FindingJson } from '@hushbox/docket';

/** The slice of `EventSource` this hook uses, so a test needs no live stream. */
export interface AuditEventStream {
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  close(): void;
}

interface AuditEventsOptions {
  /** The audit being watched. `null` is a console that has not resolved one. */
  readonly audit: string | null;
  readonly onFinding: (finding: FindingJson) => void;
  readonly openStream?: (url: string) => AuditEventStream;
  readonly loadSnapshot?: () => Promise<Snapshot>;
  readonly isVisible?: () => boolean;
  /** Whether the audit can still be reached, so the console can stop claiming what is on screen is current. */
  readonly onLive?: (live: boolean) => void;
}

async function fetchSnapshot(audit: string): Promise<Snapshot> {
  const response = await fetch(auditSnapshotUrl(audit));
  if (!response.ok) throw new Error(`the audit could not be read (${String(response.status)})`);
  return (await response.json()) as Snapshot;
}

function changedFindingId(data: string): string | null {
  try {
    const event = JSON.parse(data) as { type?: unknown; id?: unknown };
    // A removal has no card to patch and the audit header is fixed at load, so
    // a change to a finding is the only event with a consumer on this side.
    if (event.type !== 'finding' || typeof event.id !== 'string') return null;
    return event.id;
  } catch {
    return null;
  }
}

/**
 * Keeps the console in step with the audit directory while an agent writes to
 * it. The stream carries only which finding moved, so the changed finding is
 * re-read and patched in place — and a stream that dropped and came back
 * patches all of them, because the outage named none. Nothing here re-seeds the
 * audit, though, because that would take the reader's scroll position and
 * half-typed prompts with it.
 *
 * The stream is deliberately not activity: the server's idle window ignores it,
 * and the visibility-gated ping is what holds the console open. A reader who
 * walks away with this stream open still gets the server they left shut down.
 *
 * The read this hook makes *is* activity, though, because every route but the
 * stream itself refreshes that window. So the read carries the same visibility
 * gate the ping does, or a hidden tab watching a busy agent would hold the
 * server open forever with one hand while the other said nobody was there. A
 * hidden tab collects what changed and catches up when it is looked at again.
 */
export function useAuditEvents({
  audit,
  onFinding,
  openStream,
  loadSnapshot,
  isVisible,
  onLive,
}: AuditEventsOptions): void {
  useEffect(() => {
    // Only the discovery read is served unaddressed, so there is no stream to
    // watch until the console knows which audit it is on.
    if (audit === null) return;

    const open = openStream ?? ((url: string): AuditEventStream => new EventSource(url));
    const load = loadSnapshot ?? ((): Promise<Snapshot> => fetchSnapshot(audit));
    const visible = isVisible ?? ((): boolean => document.visibilityState === 'visible');

    const dirty = new Set<string>();
    const session = { reading: false, mounted: true, dropped: false, resync: false };

    const report = (live: boolean): void => {
      if (session.mounted) onLive?.(live);
    };

    /**
     * Resolves false when the console is gone or the audit cannot be read. A
     * null `wanted` is a resync: the whole audit is patched, because nothing
     * named which findings moved.
     */
    const patchOnce = async (wanted: ReadonlySet<string> | null): Promise<boolean> => {
      try {
        const snapshot = await load();
        if (!session.mounted) return false;
        for (const finding of snapshot.findings) {
          if (wanted === null || wanted.has(finding.id)) onFinding(finding);
        }
        report(true);
        return true;
      } catch {
        // The server closes on its own idle window, and the page carries on
        // rendering the snapshot it already has. Saying so is the only thing
        // separating that from an audit nobody has touched.
        report(false);
        return false;
      }
    };

    /**
     * A read that did not land must not consume what it was asked for: the
     * stream names a change once and never names it again, so anything dropped
     * here is dropped until the console is reloaded.
     */
    const keepOwed = (wanted: ReadonlySet<string> | null): void => {
      if (wanted === null) session.resync = true;
      else for (const id of wanted) dirty.add(id);
    };

    const refresh = async (): Promise<void> => {
      if (session.reading) return;
      session.reading = true;
      // Whatever arrives while one read is in flight is served by the next
      // pass, so a burst of writes costs two reads rather than one per write.
      while (session.resync || dirty.size > 0) {
        const wanted = session.resync ? null : new Set(dirty);
        session.resync = false;
        dirty.clear();
        if (await patchOnce(wanted)) continue;
        keepOwed(wanted);
        break;
      }
      session.reading = false;
    };

    const stream = open(auditEventsUrl(audit));
    stream.addEventListener('message', (event) => {
      // A stream closed on a switch can still hand over what it had already
      // read, and that change names a finding in the audit the reader left.
      if (!session.mounted) return;
      const id = changedFindingId(event.data);
      if (id === null) return;
      dirty.add(id);
      if (visible()) void refresh();
    });
    stream.addEventListener('open', () => {
      if (session.dropped) {
        // A stream that went away and came back carries nothing about the
        // outage: what moved while it was down was announced to nobody. So a
        // re-open is a resync, and the console goes on saying it is not live
        // until that read lands, rather than claiming freshness for the
        // snapshot it was already rendering.
        session.dropped = false;
        session.resync = true;
        if (visible()) void refresh();
        return;
      }
      report(true);
    });
    stream.addEventListener('error', () => {
      session.dropped = true;
      report(false);
    });

    const onVisibility = (): void => {
      if (visible()) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      session.mounted = false;
      stream.close();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [audit, onFinding, openStream, loadSnapshot, isVisible, onLive]);
}
