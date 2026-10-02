import { watchAudit } from './watch-audit.ts';

/**
 * What the console is told changed on disk. `id` is the finding id, or the audit
 * directory name for an `audit` event.
 */
export interface DocketEvent {
  readonly type: 'finding' | 'removed' | 'audit';
  readonly id: string;
}

export type EventListener = (event: DocketEvent) => void;

/** Opens a watcher on one audit directory and returns its close. */
export type OpenWatcher = (auditDir: string, onEvent: EventListener) => () => void;

export interface EventHub {
  /**
   * Joins the stream of one audit directory. The returned release is the only
   * thing that ends the subscription, and calling it more than once counts once.
   */
  subscribe(auditDir: string, listener: EventListener): () => void;
}

/** One audit's open streams and the watcher feeding them. */
interface Room {
  readonly listeners: Set<EventListener>;
  readonly stop: () => void;
}

/**
 * Fan-out for the SSE route, one room per audit directory. The room is the
 * subscriber count and the watcher's owner at once: a directory is watched from
 * the moment its first stream opens until its last one closes, so a watcher
 * cannot outlive its readers and no sweep has to look for one that did.
 */
export function createEventHub(open: OpenWatcher = watchAudit): EventHub {
  const rooms = new Map<string, Room>();

  function enter(auditDir: string): Room {
    const existing = rooms.get(auditDir);
    if (existing !== undefined) return existing;

    const listeners = new Set<EventListener>();
    const room: Room = {
      listeners,
      stop: open(auditDir, (event) => {
        for (const listener of listeners) listener(event);
      }),
    };
    rooms.set(auditDir, room);
    return room;
  }

  return {
    subscribe(auditDir, listener) {
      const room = enter(auditDir);
      room.listeners.add(listener);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        room.listeners.delete(listener);
        if (room.listeners.size > 0) return;
        rooms.delete(auditDir);
        room.stop();
      };
    },
  };
}
