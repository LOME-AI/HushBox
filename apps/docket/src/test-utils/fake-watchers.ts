import type { DocketEvent, EventListener, OpenWatcher } from '../server/events';

export interface FakeWatchers {
  readonly open: OpenWatcher;
  /** The audit directories a watcher was opened on, in the order they were opened. */
  readonly opened: string[];
  readonly closed: string[];
  send(auditDir: string, event: DocketEvent): void;
}

/** Stands in for the filesystem so a test can say when an audit changed. */
export function fakeWatchers(): FakeWatchers {
  const opened: string[] = [];
  const closed: string[] = [];
  const sinks = new Map<string, EventListener>();

  return {
    opened,
    closed,
    open(auditDir, onEvent) {
      opened.push(auditDir);
      sinks.set(auditDir, onEvent);
      return () => {
        closed.push(auditDir);
        sinks.delete(auditDir);
      };
    },
    send(auditDir, event) {
      sinks.get(auditDir)?.(event);
    },
  };
}
