import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFocusedRow } from './use-focused-row';

const PANE_HEIGHT = 100;
const ROW_TOP = 400;

interface Scene {
  readonly pane: HTMLElement;
  readonly rerender: (next: { focus: string | null }) => void;
}

/**
 * A pane with the offsets a browser would have produced: happy-dom reports
 * every box at the origin, so there would otherwise be nothing to scroll to.
 */
function setup(focus: string | null): Scene {
  const pane = document.createElement('div');
  pane.style.overflowY = 'auto';
  document.body.append(pane);
  pane.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  Object.defineProperty(pane, 'clientHeight', { value: PANE_HEIGHT, configurable: true });

  const row = document.createElement('article');
  row.getBoundingClientRect = () => ({ top: ROW_TOP }) as DOMRect;
  pane.append(row);

  const view = renderHook(
    ({ focus: current }: { focus: string | null }) => {
      const ref = useFocusedRow('ruled', current);
      ref.current = row;
      return ref;
    },
    { initialProps: { focus } }
  );
  return { pane, rerender: view.rerender };
}

describe('useFocusedRow', () => {
  it('brings the focused row into view', () => {
    const { pane } = setup('AD-14');

    expect(pane.scrollTop).toBe(ROW_TOP - PANE_HEIGHT);
  });

  it('scrolls again when the reader moves to another finding', () => {
    const { pane, rerender } = setup('AD-14');
    pane.scrollTop = 0;

    rerender({ focus: 'AD-8' });

    expect(pane.scrollTop).toBe(ROW_TOP - PANE_HEIGHT);
  });

  it('does not scroll while the reader stays on the same finding', () => {
    const { pane, rerender } = setup('AD-14');
    pane.scrollTop = 0;

    rerender({ focus: 'AD-14' });

    expect(pane.scrollTop).toBe(0);
  });

  it('does nothing when no finding is named', () => {
    const { pane } = setup(null);

    expect(pane.scrollTop).toBe(0);
  });
});
