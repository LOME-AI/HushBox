import { create } from 'zustand';

/**
 * Which blocks of which messages the reader has opened: the one piece of an
 * assistant message's UI that is not derived from its text. Keyed by message
 * id and node key rather than held in the block's component, so a block stays
 * open when its row scrolls out of the virtualised list and back, and when a
 * live tile is replaced by the stored message carrying the same id. Only the
 * reader opens or closes anything; nothing here opens or closes on its own.
 */
interface SegmentViewState {
  readonly open: ReadonlySet<string>;
  readonly toggle: (messageId: string, key: string) => void;
}

function openKey(messageId: string, key: string): string {
  return `${messageId} ${key}`;
}

export const useSegmentViewState = create<SegmentViewState>()((set) => ({
  open: new Set(),
  toggle: (messageId, key) => {
    set((state) => {
      const next = new Set(state.open);
      const id = openKey(messageId, key);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { open: next };
    });
  },
}));

/** Whether the reader has this block open, and the toggle that flips it. */
export function useSegmentOpen(messageId: string, key: string): readonly [boolean, () => void] {
  const open = useSegmentViewState((state) => state.open.has(openKey(messageId, key)));
  const toggle = useSegmentViewState((state) => state.toggle);
  return [
    open,
    () => {
      toggle(messageId, key);
    },
  ];
}
