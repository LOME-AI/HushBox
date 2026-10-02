import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import { useHotkeys, type Hotkey } from './use-hotkeys';

function hotkey(overrides: Partial<Hotkey> = {}): Hotkey {
  return {
    combo: 'mod+k',
    description: 'Open the palette',
    onTrigger: vi.fn(),
    ...overrides,
  };
}

/** A focused element of `tag`, appended to the document for the test. */
function focusedElement(tag: 'input' | 'textarea' | 'select'): HTMLElement {
  const element = document.createElement(tag);
  document.body.append(element);
  element.focus();
  return element;
}

/** A `div` carrying `contenteditable` verbatim, appended to the document. */
function editableElement(value: string): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('contenteditable', value);
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useHotkeys', () => {
  it('fires the handler when its combo is pressed', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', onTrigger })]));

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
  ])('treats mod as %s', (_label, modifier) => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', onTrigger })]));

    fireEvent.keyDown(document.body, { key: 'k', ...modifier });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('ignores the key without its modifier', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', onTrigger })]));

    fireEvent.keyDown(document.body, { key: 'k' });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('ignores a different key with the same modifier', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', onTrigger })]));

    fireEvent.keyDown(document.body, { key: 'j', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('ignores an unmodified combo while a modifier is held', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ combo: 'escape', onTrigger })]));

    fireEvent.keyDown(document.body, { key: 'Escape', ctrlKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('matches a multi-modifier combo only when every modifier is held', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ combo: 'shift+alt+n', onTrigger })]));

    fireEvent.keyDown(document.body, { key: 'N', shiftKey: true });
    expect(onTrigger).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'N', shiftKey: true, altKey: true });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('does not fire while focus is in an input', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));

    fireEvent.keyDown(focusedElement('input'), { key: 'k', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('does not fire while focus is in a textarea', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));

    fireEvent.keyDown(focusedElement('textarea'), { key: 'k', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('does not fire while focus is in a select', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));

    fireEvent.keyDown(focusedElement('select'), { key: 'k', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it.each(['true', '', 'plaintext-only', 'TRUE'])(
    'does not fire while focus is in a contenteditable="%s" element',
    (value) => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ onTrigger })]));
      const editable = editableElement(value);

      fireEvent.keyDown(editable, { key: 'k', metaKey: true });

      expect(onTrigger).not.toHaveBeenCalled();
    }
  );

  it('fires while focus is in a contenteditable="false" element', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));
    const notEditable = editableElement('false');

    fireEvent.keyDown(notEditable, { key: 'k', metaKey: true });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a target nested inside an editing host', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));
    const editable = editableElement('true');
    const nested = document.createElement('span');
    editable.append(nested);

    fireEvent.keyDown(nested, { key: 'k', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('fires for a non-text-entry element such as a button', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));
    const button = document.createElement('button');
    document.body.append(button);

    fireEvent.keyDown(button, { key: 'k', metaKey: true });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('fires for an event targeted at the document itself', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })]));

    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('prevents the browser default for a matched combo', () => {
    renderHook(() => useHotkeys([hotkey({ combo: 'mod+k' })]));
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('fires only the first matching binding', () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() =>
      useHotkeys([
        hotkey({ combo: 'mod+k', onTrigger: first }),
        hotkey({ combo: 'mod+k', onTrigger: second }),
      ])
    );

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const onTrigger = vi.fn();
    const { unmount } = renderHook(() => useHotkeys([hotkey({ onTrigger })]));

    unmount();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('does not listen while disabled', () => {
    const onTrigger = vi.fn();
    renderHook(() => useHotkeys([hotkey({ onTrigger })], { enabled: false }));

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('starts listening when it becomes enabled', () => {
    const onTrigger = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useHotkeys([hotkey({ onTrigger })], { enabled }),
      { initialProps: { enabled: false } }
    );

    rerender({ enabled: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('calls the handler from the latest render', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderHook(
      ({ onTrigger }: { onTrigger: () => void }) => useHotkeys([hotkey({ onTrigger })]),
      { initialProps: { onTrigger: stale } }
    );

    rerender({ onTrigger: fresh });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  describe('whileTyping', () => {
    function keyDownIn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    }

    it('fires a mod combo while focus is in a textarea', () => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

      keyDownIn(focusedElement('textarea'), { key: 'k', ctrlKey: true });

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('prevents the browser default for a combo fired from a textarea', () => {
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+shift+o', whileTyping: true })]));

      const event = keyDownIn(focusedElement('textarea'), {
        key: 'O',
        ctrlKey: true,
        shiftKey: true,
      });

      expect(event.defaultPrevented).toBe(true);
    });

    it('fires a mod combo while focus is in an input', () => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+,', whileTyping: true, onTrigger })]));

      keyDownIn(focusedElement('input'), { key: ',', metaKey: true });

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('fires a mod combo while focus is in a contenteditable element', () => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

      keyDownIn(editableElement('true'), { key: 'k', metaKey: true });

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['ctrl+k', { ctrlKey: true }],
      ['meta+k', { metaKey: true }],
    ])('fires %s while focus is in a textarea', (combo, modifier) => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo, whileTyping: true, onTrigger })]));

      keyDownIn(focusedElement('textarea'), { key: 'k', ...modifier });

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it.each(['k', '/', 'escape', 'shift+?', 'alt+n', 'shift+alt+n'])(
      'refuses to register %s with whileTyping, since it carries neither Ctrl nor Meta',
      (combo) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => renderHook(() => useHotkeys([hotkey({ combo, whileTyping: true })]))).toThrow(
          combo
        );
      }
    );

    it.each(['mod+k', 'ctrl+k', 'meta+k', 'mod+shift+o'])(
      'registers %s with whileTyping',
      (combo) => {
        expect(() =>
          renderHook(() => useHotkeys([hotkey({ combo, whileTyping: true })]))
        ).not.toThrow();
      }
    );

    it('registers a plain key that does not declare whileTyping', () => {
      expect(() =>
        renderHook(() => useHotkeys([hotkey({ combo: '/', whileTyping: false })]))
      ).not.toThrow();
    });

    it('does not fire the bare key of a mod combo from a textarea', () => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

      const event = keyDownIn(focusedElement('textarea'), { key: 'k' });

      expect(onTrigger).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('does not fire a mod combo from a textarea when whileTyping is false', () => {
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: false, onTrigger })]));

      const event = keyDownIn(focusedElement('textarea'), { key: 'k', ctrlKey: true });

      expect(onTrigger).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('fires the combo that declares whileTyping when an earlier binding for the same keys does not', () => {
      const idle = vi.fn();
      const typing = vi.fn();
      renderHook(() =>
        useHotkeys([
          hotkey({ combo: 'mod+k', onTrigger: idle }),
          hotkey({ combo: 'mod+k', whileTyping: true, onTrigger: typing }),
        ])
      );

      keyDownIn(focusedElement('textarea'), { key: 'k', ctrlKey: true });

      expect(idle).not.toHaveBeenCalled();
      expect(typing).toHaveBeenCalledTimes(1);
    });

    describe('on Apple platforms', () => {
      beforeEach(() => {
        vi.stubGlobal('navigator', {
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        });
      });

      it('leaves Ctrl with a mod combo to the text field', () => {
        const onTrigger = vi.fn();
        renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

        const event = keyDownIn(focusedElement('textarea'), { key: 'k', ctrlKey: true });

        expect(onTrigger).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      });

      it('fires a mod combo from a text field on Meta', () => {
        const onTrigger = vi.fn();
        renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

        const event = keyDownIn(focusedElement('textarea'), { key: 'k', metaKey: true });

        expect(onTrigger).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
      });

      it('leaves Meta with Ctrl to the text field', () => {
        const onTrigger = vi.fn();
        renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

        const event = keyDownIn(focusedElement('textarea'), {
          key: 'k',
          metaKey: true,
          ctrlKey: true,
        });

        expect(onTrigger).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      });

      it('still takes Ctrl for a mod combo outside a text field', () => {
        const onTrigger = vi.fn();
        renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

        fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });

        expect(onTrigger).toHaveBeenCalledTimes(1);
      });
    });

    it('takes Ctrl for a mod combo in a text field off Apple platforms', () => {
      vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
      const onTrigger = vi.fn();
      renderHook(() => useHotkeys([hotkey({ combo: 'mod+k', whileTyping: true, onTrigger })]));

      keyDownIn(focusedElement('textarea'), { key: 'k', ctrlKey: true });

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('leaves whileTyping out of the bindings it returns', () => {
      const { result } = renderHook(() =>
        useHotkeys([hotkey({ combo: 'mod+k', description: 'Open the palette', whileTyping: true })])
      );

      expect(result.current).toEqual([{ combo: 'mod+k', description: 'Open the palette' }]);
    });
  });

  it('returns its bindings so a help overlay can render them', () => {
    const { result } = renderHook(() =>
      useHotkeys([
        hotkey({ combo: 'mod+k', description: 'Open the palette' }),
        hotkey({ combo: 'shift+?', description: 'Show shortcuts' }),
      ])
    );

    expect(result.current).toEqual([
      { combo: 'mod+k', description: 'Open the palette' },
      { combo: 'shift+?', description: 'Show shortcuts' },
    ]);
  });
});
