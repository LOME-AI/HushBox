import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStepFocus } from './use-step-focus';
import type { RefObject } from 'react';

function pane(): { ref: RefObject<HTMLElement | null>; current: HTMLElement } {
  const element = document.createElement('main');
  element.tabIndex = -1;
  const row = document.createElement('button');
  row.setAttribute('aria-current', 'true');
  const other = document.createElement('button');
  element.append(other, row);
  document.body.append(element);
  return { ref: { current: element }, current: row };
}

// These panes are appended outside a render tree, so the library's own cleanup
// does not take them, and a focused node left behind is the next test's answer.
afterEach(() => {
  document.body.replaceChildren();
});

describe('useStepFocus', () => {
  it('leaves the keyboard alone until a step is taken', () => {
    const { ref } = pane();

    renderHook(() => {
      useStepFocus(ref, 0);
    });

    expect(document.activeElement).toBe(document.body);
  });

  it('takes the keyboard to what the pane marks as current', () => {
    const { ref, current } = pane();

    const { rerender } = renderHook(
      ({ steps }) => {
        useStepFocus(ref, steps);
      },
      { initialProps: { steps: 0 } }
    );
    rerender({ steps: 1 });

    expect(document.activeElement).toBe(current);
  });

  it('takes the keyboard to the pane where nothing in it is current', () => {
    const { ref, current } = pane();
    current.removeAttribute('aria-current');

    const { rerender } = renderHook(
      ({ steps }) => {
        useStepFocus(ref, steps);
      },
      { initialProps: { steps: 0 } }
    );
    rerender({ steps: 1 });

    expect(document.activeElement).toBe(ref.current);
  });

  it('moves the keyboard again on the next step, not only the first', () => {
    const { ref, current } = pane();

    const { rerender } = renderHook(
      ({ steps }) => {
        useStepFocus(ref, steps);
      },
      { initialProps: { steps: 0 } }
    );
    rerender({ steps: 1 });
    document.body.focus();
    rerender({ steps: 2 });

    expect(document.activeElement).toBe(current);
  });

  it('has nothing to take the keyboard to before the pane is mounted', () => {
    const ref: RefObject<HTMLElement | null> = { current: null };

    const { rerender } = renderHook(
      ({ steps }) => {
        useStepFocus(ref, steps);
      },
      { initialProps: { steps: 0 } }
    );
    rerender({ steps: 1 });

    expect(document.activeElement).toBe(document.body);
  });
});
