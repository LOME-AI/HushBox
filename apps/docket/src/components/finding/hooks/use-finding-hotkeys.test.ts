import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHotkeyHold, useHotkeysHeld } from '@/components/hotkey-hold';
import { usePublishedBindings } from '@/components/published-bindings';
import { useConsoleHotkeys } from '@/components/shell/hooks/use-console-hotkeys';
import { useFindingHotkeys } from './use-finding-hotkeys';
import type { FindingHotkeysOptions } from './use-finding-hotkeys';
import type { HotkeyBinding } from '@hushbox/ui';
import type { Mock } from 'vitest';

interface StubbedHandlers {
  onChooseOption: Mock<(optionId: string) => void>;
  onNote: Mock<(optionId: string) => void>;
  onRule: Mock<() => void>;
  onDeny: Mock<() => void>;
  onAsk: Mock<() => void>;
  onUndo: Mock<() => void>;
  onEscape: Mock<() => void>;
}

function setup(
  overrides: Partial<FindingHotkeysOptions> = {},
  dialogOpen = false
): { handlers: StubbedHandlers; bindings: readonly HotkeyBinding[] } {
  const handlers = {
    onChooseOption: vi.fn<(optionId: string) => void>(),
    onNote: vi.fn<(optionId: string) => void>(),
    onRule: vi.fn<() => void>(),
    onDeny: vi.fn<() => void>(),
    onAsk: vi.fn<() => void>(),
    onUndo: vi.fn<() => void>(),
    onEscape: vi.fn<() => void>(),
  };
  const { result } = renderHook(() => {
    useHotkeyHold(dialogOpen);
    return useFindingHotkeys({
      optionIds: ['A', 'B'],
      recommendedId: 'B',
      editing: false,
      active: true,
      ...handlers,
      ...overrides,
    });
  });
  return { handlers, bindings: result.current };
}

function press(key: string, init: KeyboardEventInit = {}): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

describe('useFindingHotkeys', () => {
  it('chooses the option a digit stands for', () => {
    const { handlers } = setup();

    press('2');

    expect(handlers.onChooseOption).toHaveBeenCalledWith('B');
  });

  it('ignores a digit past the last option', () => {
    const { handlers } = setup();

    press('3');

    expect(handlers.onChooseOption).not.toHaveBeenCalled();
  });

  it('registers no digits for a finding with no options', () => {
    const { bindings } = setup({ optionIds: [] });

    expect(bindings.some((binding) => binding.combo === '1')).toBe(false);
  });

  it("rules in the reader's own words", () => {
    const { handlers } = setup();

    press('r');

    expect(handlers.onRule).toHaveBeenCalledTimes(1);
  });

  it('offers the rule key on a finding carrying no options', () => {
    const { handlers, bindings } = setup({ optionIds: [], recommendedId: null });

    press('r');

    expect(handlers.onRule).toHaveBeenCalledTimes(1);
    expect(bindings.some((binding) => binding.combo === 'r')).toBe(true);
  });

  it('notes the recommended option', () => {
    const { handlers } = setup();

    press('n');

    expect(handlers.onNote).toHaveBeenCalledWith('B');
  });

  it('offers no note shortcut when nothing is recommended', () => {
    const { handlers, bindings } = setup({ recommendedId: null });

    press('n');

    expect(handlers.onNote).not.toHaveBeenCalled();
    expect(bindings.some((binding) => binding.combo === 'n')).toBe(false);
  });

  it('denies', () => {
    const { handlers } = setup();

    press('d');

    expect(handlers.onDeny).toHaveBeenCalledTimes(1);
  });

  it('asks', () => {
    const { handlers } = setup();

    press('q');

    expect(handlers.onAsk).toHaveBeenCalledTimes(1);
  });

  it('offers no question shortcut where the card cannot be asked about', () => {
    const { handlers, bindings } = setup({ onAsk: null });

    expect(bindings.some((binding) => binding.combo === 'q')).toBe(false);
    press('q');
    expect(handlers.onAsk).not.toHaveBeenCalled();
  });

  it('offers no deny shortcut where the card cannot be denied', () => {
    const { handlers, bindings } = setup({ onDeny: null });

    expect(bindings.some((binding) => binding.combo === 'd')).toBe(false);
    press('d');
    expect(handlers.onDeny).not.toHaveBeenCalled();
  });

  it('undoes', () => {
    const { handlers } = setup();

    press('u');

    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
  });

  it('offers no undo while there is nothing to take back', () => {
    const { handlers, bindings } = setup({ onUndo: null });

    expect(bindings.some((binding) => binding.combo === 'u')).toBe(false);
    press('u');
    expect(handlers.onUndo).not.toHaveBeenCalled();
  });

  it('leaves getting around the console to the shell, so no key is registered twice', () => {
    const { bindings } = setup();

    expect(bindings.map((binding) => binding.combo)).not.toContain('/');
    expect(bindings.map((binding) => binding.combo)).not.toContain('mod+k');
    expect(bindings.map((binding) => binding.combo)).not.toContain('j');
  });

  it('closes whatever is open', () => {
    const { handlers } = setup();

    press('Escape');

    expect(handlers.onEscape).toHaveBeenCalledTimes(1);
  });

  it('never steals a keystroke from a text box', () => {
    const { handlers } = setup();
    const textarea = document.createElement('textarea');
    document.body.append(textarea);

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));

    expect(handlers.onDeny).not.toHaveBeenCalled();
    textarea.remove();
  });

  it('describes every shortcut it registers', () => {
    const { bindings } = setup();

    expect(bindings.every((binding) => binding.description !== '')).toBe(true);
  });

  /**
   * The console stacks the queue, so several cards are mounted at once and each
   * of these shortcuts is registered on the window. Only the card the reader is
   * on may answer, or one keystroke rules every finding on screen.
   */
  it('rules on nothing while the reader is on another card', () => {
    const { handlers } = setup({ active: false });

    press('2');
    press('r');
    press('d');
    press('q');
    press('u');
    press('n');
    press('Escape');

    expect(handlers.onChooseOption).not.toHaveBeenCalled();
    expect(handlers.onRule).not.toHaveBeenCalled();
    expect(handlers.onDeny).not.toHaveBeenCalled();
    expect(handlers.onAsk).not.toHaveBeenCalled();
    expect(handlers.onUndo).not.toHaveBeenCalled();
    expect(handlers.onNote).not.toHaveBeenCalled();
    expect(handlers.onEscape).not.toHaveBeenCalled();
  });

  /**
   * The hold is the console's whole keyboard, `j` and `k` included. A card the
   * reader has scrolled past still holds the words they typed into it, so a
   * hold taken from there would strand them on a card they are not looking at.
   */
  it('takes no keyboard hold for words on a card the reader has left', () => {
    const { result } = renderHook(() => {
      useFindingHotkeys({
        optionIds: ['A'],
        recommendedId: null,
        editing: true,
        active: false,
        onChooseOption: vi.fn(),
        onNote: vi.fn(),
        onRule: vi.fn(),
        onDeny: vi.fn(),
        onAsk: vi.fn(),
        onUndo: vi.fn(),
        onEscape: vi.fn(),
      });
      return useHotkeysHeld();
    });

    expect(result.current).toBe(false);
  });

  it('rules on nothing while a dialog holds the keyboard', () => {
    const { handlers } = setup({}, true);

    press('1');
    press('d');

    expect(handlers.onChooseOption).not.toHaveBeenCalled();
    expect(handlers.onDeny).not.toHaveBeenCalled();
  });

  it('leaves Escape to the dialog that holds the keyboard', () => {
    const { handlers } = setup({}, true);

    press('Escape');

    expect(handlers.onEscape).not.toHaveBeenCalled();
  });

  it('goes on describing its shortcuts while a dialog holds the keyboard', () => {
    const { bindings } = setup({}, true);

    expect(bindings.map((binding) => binding.combo)).toContain('d');
  });

  it('decides nothing while the reader has a box open', () => {
    const { handlers } = setup({ editing: true });

    press('1');
    press('d');

    expect(handlers.onChooseOption).not.toHaveBeenCalled();
    expect(handlers.onDeny).not.toHaveBeenCalled();
  });

  it('still closes an open box from a keystroke that landed outside it', () => {
    const { handlers } = setup({ editing: true });

    press('Escape');

    expect(handlers.onEscape).toHaveBeenCalledTimes(1);
  });

  it('takes the shell keys too, so the queue cannot step over an open box', () => {
    const onMove = vi.fn<(direction: 1 | -1) => void>();
    renderHook(() => {
      useFindingHotkeys({
        optionIds: [],
        recommendedId: null,
        editing: true,
        active: true,
        onChooseOption: vi.fn(),
        onNote: vi.fn(),
        onRule: vi.fn(),
        onDeny: vi.fn(),
        onAsk: vi.fn(),
        onUndo: null,
        onEscape: vi.fn(),
      });
      return useConsoleHotkeys({
        onSearch: vi.fn(),
        onPalette: vi.fn(),
        onShortcuts: vi.fn(),
        onMove,
      });
    });

    press('j');

    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('what the card publishes', () => {
  it('reaches a surface mounted outside the card', () => {
    setup();

    const { result } = renderHook(() => usePublishedBindings());

    expect(result.current.map((binding) => binding.combo)).toEqual([
      'r',
      '1',
      '2',
      'n',
      'd',
      'q',
      'u',
      'escape',
    ]);
  });

  it('follows the finding on screen, so a fresh option set replaces the old digits', () => {
    setup({ optionIds: ['A', 'B', 'C'], recommendedId: null });

    const { result } = renderHook(() => usePublishedBindings());

    expect(result.current.map((binding) => binding.combo)).toEqual([
      'r',
      '1',
      '2',
      '3',
      'd',
      'q',
      'u',
      'escape',
    ]);
  });

  it('empties when no card is on screen', () => {
    const { unmount } = renderHook(() =>
      useFindingHotkeys({
        optionIds: ['A'],
        recommendedId: null,
        editing: false,
        active: true,
        onChooseOption: vi.fn(),
        onNote: vi.fn(),
        onRule: vi.fn(),
        onDeny: vi.fn(),
        onAsk: vi.fn(),
        onUndo: vi.fn(),
        onEscape: vi.fn(),
      })
    );
    unmount();

    const { result } = renderHook(() => usePublishedBindings());

    expect(result.current).toEqual([]);
  });

  /**
   * The legend lists one card's keys because only one card answers them. A card
   * further down the stack publishing its own would overwrite the entry the
   * reader's card put there, and its unmount would delete it outright.
   */
  it('offers nothing from a card the reader is not on', () => {
    setup({ active: false });

    const { result } = renderHook(() => usePublishedBindings());

    expect(result.current).toEqual([]);
  });

  it('survives a card the reader is not on leaving the stack', () => {
    setup();
    const { unmount } = renderHook(() =>
      useFindingHotkeys({
        optionIds: ['A'],
        recommendedId: null,
        editing: false,
        active: false,
        onChooseOption: vi.fn(),
        onNote: vi.fn(),
        onRule: vi.fn(),
        onDeny: vi.fn(),
        onAsk: vi.fn(),
        onUndo: vi.fn(),
        onEscape: vi.fn(),
      })
    );
    unmount();

    const { result } = renderHook(() => usePublishedBindings());

    expect(result.current.map((binding) => binding.combo)).toEqual([
      'r',
      '1',
      '2',
      'n',
      'd',
      'q',
      'u',
      'escape',
    ]);
  });
});
