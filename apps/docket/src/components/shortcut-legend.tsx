import { Kbd } from '@hushbox/ui';
import { Overlay, OverlayBody, OverlayContent, OverlayHeader } from '@hushbox/ui/overlay';
import { useHotkeyHold } from './hotkey-hold';
import { usePublishedBindings } from './published-bindings';
import { useDialogFocusRestore } from './use-dialog-focus-restore';
import type { HotkeyBinding } from '@hushbox/ui';
import type { JSX } from 'react';

interface ShortcutLegendProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The shell's own shortcuts, as it registered them. */
  readonly bindings: readonly HotkeyBinding[];
}

/**
 * The legend answers Escape itself, and it is the only surface guaranteed to be
 * open while this row is being read. A row published by a layer under it can be
 * true only where that layer is open, and every route to the legend closes
 * those layers — the dialog takes the focus the source peek was anchored to. A
 * row the legend owns is therefore true in every mode and every view, including
 * the ones that have no citation on screen to preview.
 */
const LEGEND_KEYS: readonly HotkeyBinding[] = [
  { combo: 'escape', description: 'Close what is open' },
];

/**
 * One row per key the reader can press, so a key two surfaces answer at once is
 * offered once. Which layer takes it is not something the reader can act on,
 * and the first claimant names it: the legend's own rows come before the ones
 * published from under it, so a key the legend answers is described by the
 * legend.
 */
function oneRowPerKey(bindings: readonly HotkeyBinding[]): readonly HotkeyBinding[] {
  const claimed = new Set<string>();
  const rows: HotkeyBinding[] = [];
  for (const binding of bindings) {
    if (claimed.has(binding.combo)) continue;
    claimed.add(binding.combo);
    rows.push(binding);
  }
  return rows;
}

/**
 * What the console is listening for, taken from the hooks that do the
 * listening. Nothing here is written down a second time: a shortcut that is
 * added, dropped or renamed at its binding changes this list with it, and a
 * shortcut that is not bound in the reader's current view is not offered.
 */
export function ShortcutLegend({ open, onClose, bindings }: ShortcutLegendProps): JSX.Element {
  useHotkeyHold(open);
  const { captureOpener, restoreFocus } = useDialogFocusRestore();
  const rows = oneRowPerKey([...bindings, ...LEGEND_KEYS, ...usePublishedBindings()]);

  return (
    <Overlay
      open={open}
      onOpenChange={onClose}
      ariaLabel="Keyboard shortcuts"
      onOpenAutoFocus={captureOpener}
      onCloseAutoFocus={restoreFocus}
    >
      <OverlayContent>
        <OverlayHeader
          title="Keyboard shortcuts"
          description="Every shortcut this view has. They work again once this is closed."
        />
        <OverlayBody>
          {/* Nothing here holds a width in rem. A key column sized to the keys
              grows with the type until it is wider than the dialog it is inside,
              and a grid cannot shrink below that: the description then starts
              past the right border and reads as a blank column. The row wraps
              instead, so at a scaled root font the description drops under its
              key rather than out of the dialog. */}
          <dl className="flex flex-col gap-2">
            {rows.map((binding) => (
              <div key={binding.combo} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <dt className="shrink-0">
                  <Kbd combo={binding.combo} alwaysVisible />
                </dt>
                <dd className="text-foreground min-w-0 flex-1 basis-40 text-sm break-words">
                  {binding.description}
                </dd>
              </div>
            ))}
          </dl>
        </OverlayBody>
      </OverlayContent>
    </Overlay>
  );
}
