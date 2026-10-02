import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeOverflowStop } from './observe-overflow-stop';

/** A resize observer the test fires by hand, standing in for the browser's layout. */
class ManualResizeObserver implements ResizeObserver {
  static readonly instances: ManualResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {
    /* the test fires it */
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.callback([], this);
  }
}

interface Box {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

const FITS: Box = { scrollWidth: 300, clientWidth: 300, scrollHeight: 120, clientHeight: 120 };
const WIDER: Box = { ...FITS, scrollWidth: 420 };
const TALLER: Box = { ...FITS, scrollHeight: 200 };

/** A region with a table inside, whose layout the test sets as the browser would. */
function regionLaidOut(box: Box): { region: HTMLElement; layOut: (next: Box) => void } {
  const region = document.createElement('div');
  region.setAttribute('tabindex', '0');
  region.append(document.createElement('table'));
  let current = box;
  for (const key of Object.keys(box) as (keyof Box)[]) {
    Object.defineProperty(region, key, { configurable: true, get: () => current[key] });
  }
  return {
    region,
    layOut: (next) => {
      current = next;
    },
  };
}

function observer(): ManualResizeObserver {
  const last = ManualResizeObserver.instances.at(-1);
  if (last === undefined) throw new Error('no resize observer was created');
  return last;
}

afterEach(() => {
  vi.unstubAllGlobals();
  ManualResizeObserver.instances.length = 0;
});

describe('observeOverflowStop', () => {
  it('keeps the tab stop while the content is wider than the region', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(WIDER);

    observeOverflowStop(region);

    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('keeps the tab stop while the content is taller than the region', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(TALLER);

    observeOverflowStop(region);

    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('removes the tab stop while the content fits', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(FITS);

    observeOverflowStop(region);

    expect(region).not.toHaveAttribute('tabindex');
  });

  it('sets the tab stop on a region that had none once its content overflows', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(WIDER);
    region.removeAttribute('tabindex');

    observeOverflowStop(region);

    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('becomes a tab stop when a resize makes the content overflow', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region, layOut } = regionLaidOut(FITS);
    observeOverflowStop(region);

    layOut(WIDER);
    observer().fire();

    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('stops being a tab stop when a resize ends the overflow', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region, layOut } = regionLaidOut(WIDER);
    observeOverflowStop(region);

    layOut(FITS);
    observer().fire();

    expect(region).not.toHaveAttribute('tabindex');
  });

  it('watches the region itself, whose width a window resize changes', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(FITS);

    observeOverflowStop(region);

    expect(observer().observed).toContain(region);
  });

  it('watches the content, which a larger text size widens inside a region of the same width', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(FITS);

    observeOverflowStop(region);

    expect(observer().observed).toContain(region.querySelector('table'));
  });

  it('stops watching when the returned function is called', () => {
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const { region } = regionLaidOut(FITS);

    const stop = observeOverflowStop(region);
    stop();

    expect(observer().disconnected).toBe(true);
  });
});
