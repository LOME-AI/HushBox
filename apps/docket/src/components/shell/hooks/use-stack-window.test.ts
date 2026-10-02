import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { STACK_SPAN } from '../logic/finding-window';
import { useStackWindow } from './use-stack-window';
import type { FindingJson } from '@hushbox/docket';
import type { StackWindow } from './use-stack-window';

const queue = (length: number): readonly FindingJson[] =>
  Array.from({ length }, (_unused, index) => makeFinding({ id: `A-${String(index)}` }));

function setup(
  length: number,
  index = 0,
  key = 'open'
): {
  result: { current: StackWindow };
  ids: () => readonly string[];
  extend: () => void;
  move: (to: number, next?: string) => void;
} {
  const findings = queue(length);
  const { result, rerender } = renderHook(
    (props: { index: number; key: string }) => useStackWindow(findings, props.index, props.key),
    { initialProps: { index, key } }
  );
  return {
    result,
    ids: (): readonly string[] => result.current.shown.map((finding) => finding.id),
    extend: (): void => {
      act(() => {
        result.current.extend();
      });
    },
    move: (to: number, next = key): void => {
      rerender({ index: to, key: next });
    },
  };
}

describe('useStackWindow', () => {
  it('starts on the arrival window, so opening a section costs a fixed amount', () => {
    const stack = setup(342, 0);

    expect(stack.ids()).toEqual(['A-0', 'A-1', 'A-2', 'A-3']);
  });

  /**
   * The reader reaching the bottom of what is mounted is the whole mechanism:
   * without it the queue ends at four findings whatever its length, which is a
   * list that stops rather than a list that scrolls.
   */
  it('mounts more of the queue each time the reader reaches the end of it', () => {
    const stack = setup(342, 0);

    stack.extend();

    expect(stack.result.current.shown).toHaveLength(STACK_SPAN * 2);
    expect(stack.ids().at(-1)).toBe('A-7');
  });

  it('reaches the last finding in a long queue by being extended', () => {
    const stack = setup(342, 0);

    for (let taken = 0; taken < 342; taken += 1) {
      if (!stack.result.current.more) break;
      stack.extend();
    }

    expect(stack.result.current.more).toBe(false);
    expect(stack.ids().at(-1)).toBe('A-341');
    expect(stack.result.current.shown).toHaveLength(342);
  });

  it('says there is nothing more below once the queue runs out', () => {
    const stack = setup(3, 0);

    expect(stack.result.current.more).toBe(false);
  });

  it('says there is more below while the queue is longer than the stack', () => {
    const stack = setup(342, 0);

    expect(stack.result.current.more).toBe(true);
  });

  /**
   * Scrolling moves the reader through what they already grew. Re-anchoring on
   * every move would throw that away underneath them and take the cards they
   * scrolled past off the screen.
   */
  it('keeps what the reader grew while they move about inside it', () => {
    const stack = setup(342, 0);
    stack.extend();

    stack.move(6);

    expect(stack.result.current.shown).toHaveLength(STACK_SPAN * 2);
    expect(stack.ids()[0]).toBe('A-0');
  });

  /**
   * A jump is a different act from a scroll: the reader asked to be somewhere
   * else, so the stack starts again there rather than mounting everything
   * between the two.
   */
  it('starts again when the reader moves outside what is mounted', () => {
    const stack = setup(342, 0);
    stack.extend();

    stack.move(200);

    expect(stack.ids()).toEqual(['A-199', 'A-200', 'A-201', 'A-202']);
  });

  it('starts again when the queue underneath it changes', () => {
    const stack = setup(342, 0);
    stack.extend();

    stack.move(0, 'denied');

    expect(stack.result.current.shown).toHaveLength(STACK_SPAN);
  });

  it('holds the reader’s finding whatever it has grown to', () => {
    const stack = setup(342, 5);
    stack.extend();
    stack.extend();

    expect(stack.ids()).toContain('A-5');
  });
});
