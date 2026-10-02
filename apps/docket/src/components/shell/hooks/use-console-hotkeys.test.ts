import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHotkeyHold } from '@/components/hotkey-hold';
import { useConsoleHotkeys } from './use-console-hotkeys';
import type { ConsoleHotkeysOptions } from './use-console-hotkeys';
import type { HotkeyBinding } from '@hushbox/ui';

function setup(
  overrides: Partial<ConsoleHotkeysOptions> = {},
  dialogOpen = false
): {
  handlers: {
    onSearch: ReturnType<typeof vi.fn>;
    onPalette: ReturnType<typeof vi.fn>;
    onShortcuts: ReturnType<typeof vi.fn>;
    onMove: ReturnType<typeof vi.fn>;
  };
  bindings: readonly HotkeyBinding[];
} {
  const handlers = {
    onSearch: vi.fn<() => void>(),
    onPalette: vi.fn<() => void>(),
    onShortcuts: vi.fn<() => void>(),
    onMove: vi.fn<(direction: 1 | -1) => void>(),
  };
  const { result } = renderHook(() => {
    useHotkeyHold(dialogOpen);
    return useConsoleHotkeys({
      onSearch: handlers.onSearch,
      onPalette: handlers.onPalette,
      onShortcuts: handlers.onShortcuts,
      onMove: handlers.onMove,
      ...overrides,
    });
  });
  return { handlers, bindings: result.current };
}

function press(key: string, init: KeyboardEventInit = {}): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

describe('useConsoleHotkeys', () => {
  it('opens the palette', () => {
    const { handlers } = setup();

    press('k', { ctrlKey: true });

    expect(handlers.onPalette).toHaveBeenCalledTimes(1);
  });

  it('opens the palette on the apple accelerator too, without stepping the queue', () => {
    const { handlers } = setup();

    press('k', { metaKey: true });

    expect(handlers.onPalette).toHaveBeenCalledTimes(1);
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('opens the shortcut legend', () => {
    const { handlers } = setup();

    press('?', { shiftKey: true });

    expect(handlers.onShortcuts).toHaveBeenCalledTimes(1);
  });

  it('lists the legend key it registers, so the legend names its own way in', () => {
    const { bindings } = setup();

    expect(bindings.map((binding) => binding.combo)).toContain('shift+?');
  });

  it('reaches the search field', () => {
    const { handlers } = setup();

    press('/');

    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
  });

  it('steps down the queue', () => {
    const { handlers } = setup();

    press('j');

    expect(handlers.onMove).toHaveBeenCalledWith(1);
  });

  it('steps back up the queue', () => {
    const { handlers } = setup();

    press('k');

    expect(handlers.onMove).toHaveBeenCalledWith(-1);
  });

  it('registers no queue steps for a section that shows no queue', () => {
    const { bindings } = setup({ onMove: null });

    expect(bindings.map((binding) => binding.combo)).toEqual(['/', 'mod+k', 'shift+?']);
  });

  it('still reaches the palette and the search from a section with no queue', () => {
    const { handlers } = setup({ onMove: null });

    press('k', { ctrlKey: true });
    press('/');

    expect(handlers.onPalette).toHaveBeenCalledTimes(1);
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
  });

  it('never fires while the reader is typing', () => {
    const { handlers } = setup();
    const input = document.createElement('input');
    document.body.append(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));

    expect(handlers.onSearch).not.toHaveBeenCalled();
    input.remove();
  });

  it('describes every shortcut it registers', () => {
    const { bindings } = setup();

    expect(bindings.every((binding) => binding.description !== '')).toBe(true);
  });

  it('fires nothing while a dialog holds the keyboard', () => {
    const { handlers } = setup({}, true);

    press('j');
    press('/');

    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onSearch).not.toHaveBeenCalled();
  });

  it('goes on describing its shortcuts while a dialog holds the keyboard', () => {
    const { bindings } = setup({}, true);

    expect(bindings.map((binding) => binding.combo)).toContain('j');
  });
});
