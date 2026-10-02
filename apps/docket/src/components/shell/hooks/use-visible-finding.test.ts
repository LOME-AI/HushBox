import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { stubIntersectionObserver } from '@/test-utils/intersection-observer';
import { useVisibleFinding } from './use-visible-finding';
import type { IntersectionStub } from '@/test-utils/intersection-observer';

let stub: IntersectionStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  document.body.innerHTML = '';
});

function stack(ids: readonly string[]): {
  container: HTMLElement;
  pane: HTMLElement;
  card: (id: string) => Element;
} {
  // The console's own shape: the document does not scroll, a pane inside it
  // does, and the stack sits inside that pane.
  const pane = document.createElement('div');
  pane.style.overflowY = 'auto';
  document.body.append(pane);
  const container = document.createElement('div');
  // `gone` stands for a finding the stack has been handed but has not painted.
  for (const id of ids.filter((id) => id !== 'gone')) {
    const card = document.createElement('div');
    card.dataset['finding'] = id;
    container.append(card);
  }
  pane.append(container);
  return {
    container,
    pane,
    card: (id) => {
      const found = container.querySelector(`[data-finding="${id}"]`);
      if (found === null) throw new Error(`no card for ${id}`);
      return found;
    },
  };
}

function setup(ids: readonly string[]): {
  onSee: ReturnType<typeof vi.fn>;
  pane: HTMLElement;
  card: (id: string) => Element;
} {
  stub = stubIntersectionObserver();
  const built = stack(ids);
  const onSee = vi.fn<(id: string) => void>();
  renderHook(() => {
    useVisibleFinding({ current: built.container }, ids, onSee);
  });
  return { onSee, pane: built.pane, card: built.card };
}

describe('useVisibleFinding', () => {
  it('watches every card in the stack', () => {
    const { card } = setup(['A-1', 'A-2', 'A-3']);

    expect(stub?.watching()).toEqual([card('A-1'), card('A-2'), card('A-3')]);
  });

  /**
   * The reading band is a band inside the pane, and it only is one if the pane
   * is what it is measured against. Against the window it is a band over
   * whatever the window happens to hold, which is a different box from the one
   * the reader scrolls.
   */
  it('measures against the pane the reader scrolls, not the window', () => {
    const { pane } = setup(['A-1', 'A-2']);

    expect(stub?.built()).toEqual([{ root: pane, rootMargin: '0px 0px -70% 0px' }]);
  });

  /**
   * Two or three cards are on screen at once in a stack, and the reader is
   * reading the one at the top of them. Answering with the last would aim the
   * keyboard at a finding whose title has not come into view yet.
   */
  it('reports the topmost of the cards on screen, which is the one being read', () => {
    const { onSee, card } = setup(['A-1', 'A-2', 'A-3']);

    stub?.show([card('A-2'), card('A-3')]);

    expect(onSee).toHaveBeenLastCalledWith('A-2');
  });

  it('follows the reader down as cards leave the top of the screen', () => {
    const { onSee, card } = setup(['A-1', 'A-2', 'A-3']);
    stub?.show([card('A-1'), card('A-2')]);

    stub?.show([card('A-3')]);

    expect(onSee).toHaveBeenLastCalledWith('A-3');
  });

  it('says nothing while no card is on screen, rather than guessing one', () => {
    const { onSee } = setup(['A-1', 'A-2']);

    stub?.show([]);

    expect(onSee).not.toHaveBeenCalled();
  });

  /**
   * A card crossing the band boundary reports the same finding again. Repeating
   * it would write the reader's place to the url on every scroll tick.
   */
  it('says a finding once, however often the cards around it move', () => {
    const { onSee, card } = setup(['A-1', 'A-2', 'A-3']);

    stub?.show([card('A-2'), card('A-3')]);
    stub?.show([card('A-2')]);

    expect(onSee).toHaveBeenCalledTimes(1);
  });

  it('leaves out a finding the stack has not painted', () => {
    const { card } = setup(['A-1', 'gone', 'A-2']);

    expect(stub?.watching()).toEqual([card('A-1'), card('A-2')]);
  });

  it('watches nothing where none of the queue is on the page yet', () => {
    stub = stubIntersectionObserver();
    const container = document.createElement('div');
    document.body.append(container);
    renderHook(() => {
      useVisibleFinding({ current: container }, ['A-1'], vi.fn());
    });

    expect(stub.watching()).toEqual([]);
  });

  it('watches nothing where the stack has not mounted', () => {
    stub = stubIntersectionObserver();
    renderHook(() => {
      useVisibleFinding({ current: null }, ['A-1'], vi.fn());
    });

    expect(stub.watching()).toEqual([]);
  });
});
