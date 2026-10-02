import { useHotkeys } from '@hushbox/ui';
import { useHotkeysHeld } from '@/components/hotkey-hold';
import type { Hotkey, HotkeyBinding } from '@hushbox/ui';

/**
 * `shift+?` rather than `?`: the matcher compares modifiers, and `?` arrives
 * with Shift down on the layouts this console is read on.
 *
 * Named here rather than at the control that also opens the legend, so the key
 * a reader is shown is the key the console is listening for.
 */
export const SHORTCUTS_COMBO = 'shift+?';

export interface ConsoleHotkeysOptions {
  readonly onSearch: () => void;
  readonly onPalette: () => void;
  readonly onShortcuts: () => void;
  /**
   * Moving along the section's queue. `null` for a section that shows no
   * queue, so the step is absent rather than a keystroke that silently does
   * nothing.
   */
  readonly onMove: ((direction: 1 | -1) => void) | null;
}

/**
 * Getting around the console. These belong to the shell rather than to the
 * finding card because the reader needs them before any card exists: the
 * console opens on the list, and the palette is what `docs/DESIGN.md`
 * §Admin app commits to as the primary way to navigate an audit this size.
 */
export function useConsoleHotkeys({
  onSearch,
  onPalette,
  onShortcuts,
  onMove,
}: ConsoleHotkeysOptions): readonly HotkeyBinding[] {
  const steps: Hotkey[] =
    onMove === null
      ? []
      : [
          {
            combo: 'j',
            description: 'Next finding',
            onTrigger: () => {
              onMove(1);
            },
          },
          {
            combo: 'k',
            description: 'Previous finding',
            onTrigger: () => {
              onMove(-1);
            },
          },
        ];

  const held = useHotkeysHeld();

  // The list survives the hold, though the keys themselves do not. The only
  // reader of it is the shortcut legend, and the legend is a dialog, so it takes
  // the hold the moment it opens: blanking the list here would empty the legend
  // at exactly the moment it is being read.
  return useHotkeys(
    [
      { combo: '/', description: 'Search', onTrigger: onSearch },
      { combo: 'mod+k', description: 'Jump to a finding', onTrigger: onPalette },
      { combo: SHORTCUTS_COMBO, description: 'Keyboard shortcuts', onTrigger: onShortcuts },
      ...steps,
    ],
    { enabled: !held }
  );
}
