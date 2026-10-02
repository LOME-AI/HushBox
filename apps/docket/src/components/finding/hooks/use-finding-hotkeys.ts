import { useHotkeys } from '@hushbox/ui';
import { useHotkeyHold, useHotkeysHeld } from '@/components/hotkey-hold';
import { usePublishBindings } from '@/components/published-bindings';
import type { Hotkey, HotkeyBinding } from '@hushbox/ui';

export interface FindingHotkeysOptions {
  /** Option ids in the order they are numbered on screen. */
  readonly optionIds: readonly string[];
  readonly recommendedId: string | null;
  /**
   * A box the reader is writing in is open. Asked of the card rather than of
   * focus, because a click on a citation moves focus to `<body>` without
   * ending the edit, and a focus test cannot tell that apart from a reader who
   * has finished.
   */
  readonly editing: boolean;
  /**
   * This is the card the reader is on. The queue is stacked, so several cards
   * are mounted at once and every one of them registers these keys on the
   * window: without the gate a single digit rules every finding on screen, and
   * a card scrolled past goes on holding the console's keyboard over words
   * typed into it.
   */
  readonly active: boolean;
  readonly onChooseOption: (optionId: string) => void;
  readonly onNote: (optionId: string) => void;
  /**
   * Ruling in the reader's own words. Unconditional, unlike the keys below it:
   * the card always offers it, and it is the only ruling route on a finding
   * whose options have not been minted, which on a real audit is most of them.
   */
  readonly onRule: () => void;
  /**
   * `null` wherever the card withholds the matching control, so the key is
   * absent rather than offered and inert — the legend lists whatever is bound,
   * and a key whose handler opens a box the card does not render takes the
   * keyboard hold with nothing on screen to give it back.
   */
  readonly onDeny: (() => void) | null;
  readonly onAsk: (() => void) | null;
  readonly onUndo: (() => void) | null;
  readonly onEscape: () => void;
}

/** Nine is what a single keystroke can address; no audit option set comes close. */
const MAX_DIGIT_OPTIONS = 9;

/**
 * The decisions the ruling loop is worked from. Getting around the console —
 * the palette, the search, the queue steps — is the shell's keyboard, because
 * a card exists only in focus mode and those have to work before one does.
 * Two separate things keep a digit out of a note the reader is halfway through
 * typing: `useHotkeys` fires no digit (no Ctrl or Meta) at a text box, and the hold
 * below covers the rest of the edit, which outlives the caret.
 */
export function useFindingHotkeys({
  optionIds,
  recommendedId,
  editing,
  active,
  onChooseOption,
  onNote,
  onRule,
  onDeny,
  onAsk,
  onUndo,
  onEscape,
}: FindingHotkeysOptions): readonly HotkeyBinding[] {
  const digits: Hotkey[] = optionIds.slice(0, MAX_DIGIT_OPTIONS).map((optionId, index) => ({
    combo: String(index + 1),
    description: `Rule with option ${optionId}`,
    onTrigger: () => {
      onChooseOption(optionId);
    },
  }));

  const note: Hotkey[] =
    recommendedId === null
      ? []
      : [
          {
            combo: 'n',
            description: 'Note the recommended option',
            onTrigger: () => {
              onNote(recommendedId);
            },
          },
        ];

  const rule: Hotkey[] = [{ combo: 'r', description: 'Rule in your own words', onTrigger: onRule }];

  const deny: Hotkey[] =
    onDeny === null ? [] : [{ combo: 'd', description: 'Deny', onTrigger: onDeny }];

  const ask: Hotkey[] =
    onAsk === null ? [] : [{ combo: 'q', description: 'Ask a question', onTrigger: onAsk }];

  const undo: Hotkey[] =
    onUndo === null ? [] : [{ combo: 'u', description: 'Undo the last write', onTrigger: onUndo }];

  // An open box takes the console's keys the way a dialog does, and for the
  // same reason the hold exists: these shortcuts are registered on the window,
  // so a click that moves focus out of the box without ending the edit — a
  // citation, anywhere in the prose — leaves a digit, `u` and the shell's queue
  // steps live over words still being written.
  //
  // The hold is global — it reaches the shell's `j` and `k` too — so only the
  // card the reader is on may take it. A card further up the stack still holds
  // whatever was typed into it, and a hold from there would kill the keyboard
  // on the card the reader is actually looking at.
  useHotkeyHold(active && editing);
  const held = useHotkeysHeld();

  const decisions = useHotkeys([...rule, ...digits, ...note, ...deny, ...ask, ...undo], {
    enabled: active && !held,
  });

  // Escape survives the card's own editing hold, because it is the keystroke
  // that ends the edit: a dialog dismisses itself on Escape, but a box that has
  // lost the caret to a click never sees the key at all.
  //
  // This description never reaches a reader: the legend answers Escape itself
  // and lists its own row first, so the wording the reader sees lives there.
  // The row is published anyway, because what a surface publishes is what it
  // binds — a filtered list is one the legend can no longer be trusted with.
  const closing = useHotkeys(
    [{ combo: 'escape', description: 'Close what is open', onTrigger: onEscape }],
    { enabled: active && (!held || editing) }
  );

  const bindings = [...decisions, ...closing];

  // The digits are the half of the console's keyboard a reader is least likely
  // to guess, and no card on screen means none of these keys are bound at all,
  // so the legend must stop offering them the moment the card goes.
  usePublishBindings(active ? 'card' : null, bindings);

  // The list survives the hold, though the keys themselves do not. A dialog
  // takes Escape as well, because it dismisses itself and closing the card's
  // prompts behind it would take two things away for one keystroke.
  return bindings;
}
