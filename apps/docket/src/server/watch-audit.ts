import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { DocketEvent, EventListener } from './events.ts';

/**
 * Coalesces the burst a single logical write produces: an atomic write is a
 * create plus a rename, and an editor save can be several more.
 */
const DEBOUNCE_MS = 40;

const AUDIT_FILE = 'audit.md';
const FINDINGS_DIRECTORY = 'findings';

/**
 * Watches one audit directory so the console sees writes made by another
 * process, which is the whole point: the agent CLI writes progress while a human
 * has the console open. Only `.md` names are reported, which is what keeps the
 * store's own lock and temp files (`<id>.md.lock`, `<id>.md.<uuid>.tmp`) out of
 * the stream.
 */
export interface WatchDeps {
  watch: typeof watch;
  exists: (target: string) => boolean;
}

const REAL_FS: WatchDeps = { watch, exists: existsSync };

export function watchAudit(
  auditDir: string,
  onEvent: EventListener,
  deps: WatchDeps = REAL_FS
): () => void {
  const findingsDir = path.join(auditDir, FINDINGS_DIRECTORY);
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (key: string, build: () => DocketEvent): void => {
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        onEvent(build());
      }, DEBOUNCE_MS)
    );
  };

  const watchDirectory = (dir: string, handle: (name: string) => void): void => {
    if (!deps.exists(dir)) return;
    watchers.push(
      // Some platforms report a change with no filename at all; stringifying it
      // yields a name that matches neither filter below, which is the same
      // outcome as a name the console does not care about.
      deps.watch(dir, (_type, name) => {
        handle(String(name));
      })
    );
  };

  watchDirectory(findingsDir, (name) => {
    if (!name.endsWith('.md')) return;
    const id = name.slice(0, -'.md'.length);
    schedule(id, () => ({
      type: deps.exists(path.join(findingsDir, name)) ? 'finding' : 'removed',
      id,
    }));
  });

  watchDirectory(auditDir, (name) => {
    if (name !== AUDIT_FILE) return;
    schedule(AUDIT_FILE, () => ({ type: 'audit', id: path.basename(auditDir) }));
  });

  return () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}
