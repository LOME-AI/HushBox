import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollRestore } from './use-scroll-restore';

interface Pane extends HTMLElement {
  scrollTop: number;
}

/**
 * happy-dom reports zero for every layout metric, so the pane's height is
 * declared here. The hook only ever compares the offset it saved against the
 * room the content leaves for it.
 */
function makePane(scrollHeight: number, clientHeight = 800): Pane {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
  document.body.append(element);
  return element as Pane;
}

function shrink(pane: Pane, scrollHeight: number): void {
  Object.defineProperty(pane, 'scrollHeight', { value: scrollHeight, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(pane: Pane, key = 'open|list'): { rerender: (props: { k: string }) => void } {
  const ref = { current: pane };
  return renderHook(
    ({ k }: { k: string }) => {
      useScrollRestore(ref, k);
    },
    { initialProps: { k: key } }
  );
}

describe('useScrollRestore', () => {
  it('puts the reader back where they were when a filter round trip empties and refills the pane', () => {
    const pane = makePane(27_706);
    const view = mount(pane);
    pane.scrollTop = 6000;
    pane.dispatchEvent(new Event('scroll'));

    // The filter narrows the queue: the browser clamps the offset to zero and
    // reports the clamp as a scroll of its own.
    shrink(pane, 800);
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event('scroll'));
    view.rerender({ k: 'open|list' });
    shrink(pane, 27_706);
    view.rerender({ k: 'open|list' });

    expect(pane.scrollTop).toBe(6000);
  });

  it('records a deliberate return to the top, so clearing a filter does not undo it', () => {
    const pane = makePane(27_706);
    const view = mount(pane);
    pane.scrollTop = 6000;
    pane.dispatchEvent(new Event('scroll'));
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event('scroll'));

    view.rerender({ k: 'open|list' });

    expect(pane.scrollTop).toBe(0);
  });

  it('leaves an offset the reader is already at alone', () => {
    const pane = makePane(27_706);
    const view = mount(pane);
    pane.scrollTop = 6000;
    pane.dispatchEvent(new Event('scroll'));
    pane.scrollTop = 4000;

    view.rerender({ k: 'open|list' });

    expect(pane.scrollTop).toBe(4000);
  });

  it('does not restore an offset the shorter content cannot hold', () => {
    const pane = makePane(27_706);
    const view = mount(pane);
    pane.scrollTop = 6000;
    pane.dispatchEvent(new Event('scroll'));
    shrink(pane, 2000);
    pane.scrollTop = 0;

    view.rerender({ k: 'open|list' });

    expect(pane.scrollTop).toBe(0);
  });

  it('remembers each section and mode separately', () => {
    const pane = makePane(27_706);
    const view = mount(pane, 'open|list');
    pane.scrollTop = 6000;
    pane.dispatchEvent(new Event('scroll'));

    view.rerender({ k: 'ruled|list' });

    expect(pane.scrollTop).toBe(0);

    pane.scrollTop = 0;
    view.rerender({ k: 'open|list' });

    expect(pane.scrollTop).toBe(6000);
  });

  it('survives a pane that is not on the page', () => {
    const ref = { current: null };
    expect(() => {
      renderHook(() => {
        useScrollRestore(ref, 'open|list');
      });
    }).not.toThrow();
  });
});
