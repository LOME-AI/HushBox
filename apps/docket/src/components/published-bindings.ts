import { useEffect, useSyncExternalStore } from 'react';
import type { HotkeyBinding } from '@hushbox/ui';

/**
 * A surface that binds keys the shortcut legend has to list. The legend is
 * mounted on the shell, beside these rather than above them, so props cannot
 * carry a list from any of them to it.
 */
type BindingSource = 'card';

/** The order the legend reads them in. */
const SOURCES: readonly BindingSource[] = ['card'];

const NONE: readonly HotkeyBinding[] = [];

const bySource = new Map<BindingSource, readonly HotkeyBinding[]>();
const listeners = new Set<() => void>();
let published: readonly HotkeyBinding[] = NONE;

function readPublished(): readonly HotkeyBinding[] {
  return published;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function signature(bindings: readonly HotkeyBinding[]): string {
  return bindings.map((binding) => `${binding.combo}\u0000${binding.description}`).join('\u0001');
}

/**
 * Held to the same reference while the content is unchanged: a publisher
 * rebuilds its list on every render, and `useSyncExternalStore` needs a
 * snapshot that only changes when the bindings do.
 */
function republish(): void {
  const next = SOURCES.flatMap((source) => bySource.get(source) ?? NONE);
  if (signature(published) === signature(next)) return;
  published = next;
  for (const listener of listeners) listener();
}

/**
 * Offers this surface's shortcuts to the legend for as long as it is mounted.
 * A surface that stops binding a key publishes the shorter list; one that
 * unmounts publishes nothing, so the legend never offers a key that is not
 * live.
 *
 * A `null` source is a surface that is mounted but binds nothing, and it is the
 * whole of what makes the entry safe under a stack: the console mounts several
 * finding cards at once, and every one of them past the reader's would
 * otherwise overwrite the entry the reader's card put there and delete it again
 * on its own unmount, leaving the legend blank while a card is still on screen.
 */
export function usePublishBindings(
  source: BindingSource | null,
  bindings: readonly HotkeyBinding[]
): void {
  useEffect(() => {
    if (source === null) return;
    bySource.set(source, bindings);
    republish();
  });

  useEffect(() => {
    if (source === null) return;
    return () => {
      bySource.delete(source);
      republish();
    };
  }, [source]);
}

/** Every shortcut bound outside the legend's own tree, for the legend to list. */
export function usePublishedBindings(): readonly HotkeyBinding[] {
  return useSyncExternalStore(subscribe, readPublished);
}
