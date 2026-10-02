import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';

import { PageBody } from './page-body';

class ResizeObserverFake implements ResizeObserver {
  static readonly instances: ResizeObserverFake[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverFake.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    /* The band's watch never drops a single target; it disconnects. */
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(): void {
    act(() => {
      this.callback([], this);
    });
  }
}

function bandObserver(): ResizeObserverFake {
  const [observer] = ResizeObserverFake.instances;
  if (!observer) throw new Error('no ResizeObserver was created');
  return observer;
}

function pinnedBand(): HTMLElement {
  const band = screen.getByTestId('page-body').querySelector<HTMLElement>('[data-page-pinned]');
  if (!band) throw new Error('the pinned band is missing');
  return band;
}

/** Lays the band out `band` px tall in a scroller `scroller` px tall, and reports the resize. */
function layOut({ band, scroller }: { band: number; scroller: number }): void {
  Object.defineProperty(pinnedBand(), 'offsetHeight', { configurable: true, value: band });
  Object.defineProperty(screen.getByTestId('page-body'), 'clientHeight', {
    configurable: true,
    value: scroller,
  });
  bandObserver().fire();
}

function isPinned(): boolean {
  const classes = new Set(pinnedBand().className.split(' '));
  return classes.has('md:sticky') && classes.has('md:top-0');
}

describe('PageBody pinned band fit', () => {
  beforeEach(() => {
    ResizeObserverFake.instances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverFake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('watches the band and the scroller for size changes', () => {
    render(<PageBody pinned="links">content</PageBody>);
    expect(bandObserver().observed).toEqual([pinnedBand(), screen.getByTestId('page-body')]);
  });

  it('keeps the band pinned while it is exactly 70% of the scroller tall', () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 700, scroller: 1000 });
    expect(isPinned()).toBe(true);
  });

  it('lets the band scroll with the page once it is taller than 70% of the scroller', () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 701, scroller: 1000 });
    expect(isPinned()).toBe(false);
  });

  // The measured /accessibility cases the threshold is set to sort.
  it.each([
    { label: '768x900 at 100% text', band: 466, scroller: 844, pinned: true },
    { label: '1440x900 at the largest text', band: 529, scroller: 779, pinned: true },
    { label: '834x1112 at the largest text', band: 933, scroller: 1033, pinned: false },
    { label: '768x900 at the largest text', band: 1103, scroller: 821, pinned: false },
  ])('sorts the /accessibility band at $label', ({ band, scroller, pinned }) => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band, scroller });
    expect(isPinned()).toBe(pinned);
  });

  it('pins the band again once it fits', () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 701, scroller: 1000 });
    layOut({ band: 700, scroller: 1000 });
    expect(isPinned()).toBe(true);
  });

  it('unpins the band when the scroller shrinks under it', () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 600, scroller: 1000 });
    layOut({ band: 600, scroller: 857 });
    expect(isPinned()).toBe(false);
  });

  it("pads the scroller's top by the band's height while the band is pinned", () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 300, scroller: 1000 });
    expect(screen.getByTestId('page-body').style.scrollPaddingTop).toBe('300px');
  });

  it('follows the band height in the padding as the pinned band grows', () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 300, scroller: 1000 });
    layOut({ band: 450, scroller: 1000 });
    expect(screen.getByTestId('page-body').style.scrollPaddingTop).toBe('450px');
  });

  it("drops the scroller's top padding once the band scrolls with the page", () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 300, scroller: 1000 });
    layOut({ band: 701, scroller: 1000 });
    expect(screen.getByTestId('page-body').style.scrollPaddingTop).toBe('');
  });

  it('keeps the band boxless below 768 whether or not it fits', () => {
    render(<PageBody pinned="links">content</PageBody>);
    layOut({ band: 701, scroller: 1000 });
    expect(pinnedBand().className.split(' ')).toContain('max-md:contents');
  });

  it('stops watching on unmount', () => {
    const { unmount } = render(<PageBody pinned="links">content</PageBody>);
    unmount();
    expect(bandObserver().disconnected).toBe(true);
  });

  it('watches nothing without a pinned band', () => {
    render(<PageBody>content</PageBody>);
    expect(ResizeObserverFake.instances).toEqual([]);
  });
});

describe('PageBody', () => {
  it('wraps children in an outer scroll container and an inner width-constrained wrapper', () => {
    render(
      <PageBody>
        <span>content</span>
      </PageBody>
    );

    const outer = screen.getByTestId('page-body');
    // Outer div: full-width scroll container. Wheel/touch scroll lands here
    // anywhere in the body area, including outside the centered content.
    expect(outer.className).toContain('overflow-y-auto');
    expect(outer.className).toContain('flex-1');
    expect(outer.className).toContain('min-h-0');

    // Inner div: width-constrained content wrapper.
    const inner = outer.firstElementChild;
    expect(inner?.className).toContain('mx-auto');
    expect(inner?.className).toContain('max-w-4xl');
    expect(inner?.className).toContain('p-4');
    expect(inner?.textContent).toBe('content');
  });

  it('does NOT put overflow-y-auto on the width-constrained inner div', () => {
    // Regression: combining max-w-4xl and overflow-y-auto on a single div is
    // exactly the bug this component exists to prevent.
    render(<PageBody>content</PageBody>);
    const inner = screen.getByTestId('page-body').firstElementChild;
    expect(inner?.className).not.toContain('overflow-y-auto');
  });

  it('appends extra classes to the inner content wrapper (e.g. space-y-6)', () => {
    render(<PageBody className="custom-x space-y-6">content</PageBody>);
    const inner = screen.getByTestId('page-body').firstElementChild;
    expect(inner?.className).toContain('space-y-6');
    expect(inner?.className).toContain('custom-x');
  });

  it('leaves outer container untouched when className is passed (extra classes go on inner)', () => {
    render(<PageBody className="space-y-6">content</PageBody>);
    const outer = screen.getByTestId('page-body');
    expect(outer.className).not.toContain('space-y-6');
  });

  it('uses a caller-provided testId on the outer container when passed', () => {
    render(<PageBody testId={TEST_IDS.usageContent}>content</PageBody>);
    const outer = screen.getByTestId(TEST_IDS.usageContent);
    expect(outer.className).toContain('overflow-y-auto');
    // Default 'page-body' testid is replaced, not coexistent.
    expect(screen.queryByTestId('page-body')).toBeNull();
  });

  it('renders no pinned band without a pinned node', () => {
    render(<PageBody>content</PageBody>);
    const outer = screen.getByTestId('page-body');
    expect(outer.querySelector('[data-page-pinned]')).toBeNull();
    expect(outer.children).toHaveLength(1);
  });

  it('renders the pinned node above the content column, inside the scroll container', () => {
    render(
      <PageBody pinned={<nav aria-label="Pinned">links</nav>}>
        <span>content</span>
      </PageBody>
    );
    const outer = screen.getByTestId('page-body');
    const [band, column] = outer.children;
    expect(band).toContainElement(screen.getByRole('navigation', { name: 'Pinned' }));
    expect(column?.textContent).toBe('content');
  });

  it('pins the band to the top of the scroll container from 768 with a hairline under it', () => {
    render(<PageBody pinned="links">content</PageBody>);
    const band = screen.getByTestId('page-body').querySelector('[data-page-pinned]');
    expect(band?.className).toContain('md:sticky');
    expect(band?.className).toContain('md:top-0');
    expect(band?.className).toContain('border-b');
    expect(band?.className).not.toMatch(/(^|\s)sticky/);
  });

  it('gives the band no box of its own below 768, so a pinned child can stick alone', () => {
    render(<PageBody pinned="links">content</PageBody>);
    const band = screen.getByTestId('page-body').querySelector('[data-page-pinned]');
    expect(band?.className.split(' ')).toContain('max-md:contents');
    expect(band?.firstElementChild?.className.split(' ')).toContain('max-md:contents');
  });

  it('spans the band full width and aligns its content with the content column', () => {
    render(<PageBody pinned="links">content</PageBody>);
    const band = screen.getByTestId('page-body').querySelector('[data-page-pinned]');
    const bandInner = band?.firstElementChild;
    expect(band?.className).not.toContain('max-w-4xl');
    expect(bandInner?.className).toContain('mx-auto');
    expect(bandInner?.className).toContain('max-w-4xl');
    expect(bandInner?.textContent).toBe('links');
  });

  it('marks the outer container as the page scroller', () => {
    render(<PageBody>content</PageBody>);
    expect(screen.getByTestId('page-body')).toHaveAttribute('data-page-scroller');
  });
});
