import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  GROWTH_SECTIONS,
  GrowthSectionRail,
  atScrollEnd,
  pageReading,
  sectionAtLine,
} from './section-rail.js';

/** Where each section's top edge sits, as the rail reads them off the page. */
const TOPS = [
  { id: 'conversion', top: -400 },
  { id: 'traffic', top: 120 },
  { id: 'behaviour', top: 900 },
] as const;

/**
 * A `ResizeObserver` this file notifies by hand. The runtime lays nothing out,
 * so nothing would otherwise deliver the notification a browser sends once a
 * layout has run.
 */
class RecordingObserver implements ResizeObserver {
  static readonly built: RecordingObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    RecordingObserver.built.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    this.targets.splice(this.targets.indexOf(target), 1);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** What a browser does once a layout has run with an observed box in it. */
  notify(): void {
    if (!this.disconnected) this.callback([], this);
  }
}

/** Hands the rail observers this case can notify, for this case only. */
function recordObservers(): void {
  RecordingObserver.built.length = 0;
  vi.stubGlobal('ResizeObserver', RecordingObserver);
}

/** Notifies every observer watching `target`, as a layout of it would. */
function layOutObserved(target: Element): void {
  act(() => {
    for (const observer of RecordingObserver.built) {
      if (observer.targets.includes(target)) observer.notify();
    }
  });
}

/**
 * The rail beside the sections it reaches, which is the only arrangement it
 * derives anything in: with no section on the page it has no scroll position to
 * read.
 */
function renderRail(): void {
  render(
    <>
      <GrowthSectionRail />
      {GROWTH_SECTIONS.map((section) => (
        <div key={section.id} id={section.id} />
      ))}
    </>
  );
}

/** The rail's own links, in the order it draws them. */
function railLinks(): readonly HTMLElement[] {
  return within(screen.getByRole('navigation', { name: 'Growth sections' })).getAllByRole('link');
}

/** The link the rail marks as where the reader is, or null while it marks none. */
function markedLink(): HTMLElement | null {
  return railLinks().find((link) => link.getAttribute('aria-current') !== null) ?? null;
}

/**
 * A scroll container holding the rail, with the range it has and the part of it
 * the reader has scrolled through. The two lengths are defined rather than laid
 * out because the test runtime lays nothing out.
 */
function scroller(range: {
  readonly content: number;
  readonly box: number;
  readonly at: number;
}): HTMLElement {
  const element = document.createElement('div');
  element.style.overflowY = 'auto';
  Object.defineProperty(element, 'scrollHeight', { value: range.content, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: range.box, configurable: true });
  document.body.append(element);
  element.scrollTop = range.at;
  return element;
}

/**
 * Where the page has laid a section out, which the test runtime reads as zero
 * for everything until it is told otherwise.
 */
function layOutAt(element: Element, top: number): void {
  element.getBoundingClientRect = (): DOMRect => new DOMRect(0, top, 0, 0);
}

/**
 * Where the page has laid an element out for one case only, undone once the
 * case ends so the next one reads the runtime's own answer again.
 */
function layOutForThisTest(element: Element, top: number): void {
  const laidOut = element.getBoundingClientRect.bind(element);
  layOutAt(element, top);
  onTestFinished(() => {
    element.getBoundingClientRect = laidOut;
  });
}

/**
 * One reading of a rail inside a scroll container, with the container's own top
 * edge and the rail's bottom edge laid out where the case wants them.
 */
function readingInScroller(at: {
  readonly scrollerTop: number;
  readonly scrollerBorderTop?: number;
  readonly railBottom: number;
}): ReturnType<typeof pageReading> {
  const container = scroller({ content: 2000, box: 800, at: 0 });
  layOutAt(container, at.scrollerTop);
  Object.defineProperty(container, 'clientTop', {
    value: at.scrollerBorderTop ?? 0,
    configurable: true,
  });
  render(<GrowthSectionRail />, { container });
  const rail = screen.getByRole('navigation', { name: 'Growth sections' });
  layOutAt(rail, at.railBottom);
  return pageReading(rail);
}

/**
 * The rail inside a scroll container, with the four sections laid out one
 * screenful apart below the rail's own line, so only the first has reached it.
 *
 * The rail sits in a header of its own that does not scroll, as it does on the
 * screen, so the header, the scroll container and the rail are three elements
 * and a case can tell which of them is being watched.
 */
function renderRailIn(container: HTMLElement): void {
  render(
    <>
      <header>
        <GrowthSectionRail />
      </header>
      {GROWTH_SECTIONS.map((section) => (
        <div key={section.id} id={section.id} />
      ))}
    </>,
    { container }
  );
  for (const [index, section] of GROWTH_SECTIONS.entries()) {
    const element = document.querySelector(`#${section.id}`);
    if (element !== null) layOutAt(element, index * 900);
  }
}

/** The header {@link renderRailIn} puts the rail in, between the rail and its scroll container. */
function headerIn(container: HTMLElement): HTMLElement {
  const header = container.querySelector('header');
  if (header === null) throw new Error('the rail was rendered in no header');
  return header;
}

describe('sectionAtLine', () => {
  it('names the last section that has reached the line', () => {
    expect(sectionAtLine(TOPS, 130, false)).toBe('traffic');
  });

  it('leaves a section still below the line unreached', () => {
    expect(sectionAtLine(TOPS, 100, false)).toBe('conversion');
  });

  it('names the first section while none has reached the line', () => {
    expect(sectionAtLine(TOPS, -500, false)).toBe('conversion');
  });

  it('counts a section sitting exactly on the line as reached', () => {
    expect(sectionAtLine([{ id: 'traffic', top: 64 }], 64, false)).toBe('traffic');
  });

  it('names no section when the page drew none', () => {
    expect(sectionAtLine([], 0, false)).toBeUndefined();
  });

  it('counts the end of the scroll range as reaching the last section', () => {
    expect(sectionAtLine(TOPS, 130, true)).toBe('behaviour');
  });

  it('names no section at the end of a page that drew none', () => {
    expect(sectionAtLine([], 0, true)).toBeUndefined();
  });
});

describe('atScrollEnd', () => {
  it('reads no end with nothing scrolling', () => {
    expect(atScrollEnd(null)).toBe(false);
  });

  it('has no end to reach while the content fits its box', () => {
    expect(atScrollEnd({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 })).toBe(false);
  });

  it('is short of the end partway down the range', () => {
    expect(atScrollEnd({ scrollTop: 600, clientHeight: 800, scrollHeight: 2000 })).toBe(false);
  });

  it('reaches the end with the whole range scrolled through', () => {
    expect(atScrollEnd({ scrollTop: 1200, clientHeight: 800, scrollHeight: 2000 })).toBe(true);
  });

  it('reaches the end a fraction of a pixel short of it', () => {
    expect(atScrollEnd({ scrollTop: 1199.5, clientHeight: 800, scrollHeight: 2000 })).toBe(true);
  });
});

describe('pageReading', () => {
  it('reads nothing while the rail is not on the page', () => {
    expect(pageReading(null)).toEqual({ line: 0, anchorLine: 0, tops: [], atEnd: false });
  });

  it('reads the end of the range off the container the rail scrolls inside', () => {
    const container = scroller({ content: 2000, box: 800, at: 1200 });
    render(<GrowthSectionRail />, { container });
    expect(pageReading(screen.getByRole('navigation', { name: 'Growth sections' })).atEnd).toBe(
      true
    );
  });

  it('reads no end where the rail scrolls inside nothing', () => {
    render(<GrowthSectionRail />);
    expect(pageReading(screen.getByRole('navigation', { name: 'Growth sections' })).atEnd).toBe(
      false
    );
  });

  it('resolves the anchor line into the coordinates of the container it scrolls inside', () => {
    expect(readingInScroller({ scrollerTop: 56, railBottom: 209 }).anchorLine).toBe(153);
  });

  it('resolves the anchor line against the scrollport, which starts inside the container’s border', () => {
    expect(
      readingInScroller({ scrollerTop: 56, scrollerBorderTop: 4, railBottom: 209 }).anchorLine
    ).toBe(149);
  });

  it('keeps the line it marks sections by in the viewport coordinates they are read in', () => {
    expect(readingInScroller({ scrollerTop: 56, railBottom: 209 }).line).toBe(209);
  });

  it('never publishes an anchor line behind the start of the scroll container', () => {
    expect(readingInScroller({ scrollerTop: 300, railBottom: 209 }).anchorLine).toBe(0);
  });

  it('holds the line at the start of the scrollport once the rail has scrolled out of it', () => {
    expect(readingInScroller({ scrollerTop: 53, railBottom: -3211 }).line).toBe(53);
  });

  it('takes the anchor line as it stands where the document itself scrolls', () => {
    // The document's own scroller reports a box that has moved up by however far
    // the page is scrolled, while the scrollport a jump resolves against stays
    // the viewport, so a reading there subtracts nothing.
    layOutForThisTest(document.documentElement, -300);
    render(<GrowthSectionRail />);
    const rail = screen.getByRole('navigation', { name: 'Growth sections' });
    layOutAt(rail, 209);
    expect(pageReading(rail).anchorLine).toBe(209);
  });
});

describe('GrowthSectionRail', () => {
  // Every case starts from a fragment none of these links names, so what the
  // URL holds is this case's own doing rather than the one before it.
  beforeEach(() => {
    globalThis.location.hash = '#somewhere-else';
  });

  it('links every section the screen draws, as an anchor to its own fragment', () => {
    render(<GrowthSectionRail />);
    expect(railLinks().map((link) => link.getAttribute('href'))).toEqual(
      GROWTH_SECTIONS.map((section) => `#${section.id}`)
    );
  });

  it("hides each link's browser outline only while it has keyboard focus", () => {
    render(<GrowthSectionRail />);
    expect(
      railLinks().map((link) =>
        [...link.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
      )
    ).toEqual(GROWTH_SECTIONS.map(() => ['focus-visible:outline-hidden']));
  });

  it('names each link by the section it reaches', () => {
    render(<GrowthSectionRail />);
    for (const [index, section] of GROWTH_SECTIONS.entries()) {
      expect(railLinks()[index]).toHaveAccessibleName(new RegExp(section.heading));
    }
  });

  // The toolbar pinned above the rail paints over the band just above each
  // link, so the ring is drawn inside the link's box, at a strength that clears 3:1.
  it('draws each link’s focus ring inside its own box at full ring strength', () => {
    render(<GrowthSectionRail />);
    for (const link of railLinks()) {
      expect(link).toHaveClass(
        'focus-visible:ring-2',
        'focus-visible:ring-inset',
        'focus-visible:ring-ring'
      );
    }
  });

  it('draws no half-strength ring outside a link’s box', () => {
    render(<GrowthSectionRail />);
    for (const link of railLinks()) {
      expect(link).not.toHaveClass('focus-visible:ring-ring/50');
      expect(link).not.toHaveClass('focus-visible:ring-[3px]');
    }
  });

  it('states the number that reaches each section, so the shortcut is announced', () => {
    render(<GrowthSectionRail />);
    expect(railLinks().map((link) => link.getAttribute('aria-keyshortcuts'))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('presses the link a number names rather than moving the page itself', async () => {
    render(<GrowthSectionRail />);
    const pressed: string[] = [];
    screen
      .getByRole('navigation', { name: 'Growth sections' })
      .addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement) {
          pressed.push(event.target.closest('a')?.getAttribute('href') ?? 'nothing');
        }
      });
    await userEvent.keyboard('2');
    expect(pressed).toEqual([`#${GROWTH_SECTIONS[1].id}`]);
  });

  it('leaves the URL naming the section a number reached', async () => {
    renderRail();
    await userEvent.keyboard('3');
    expect(globalThis.location.hash).toBe(`#${GROWTH_SECTIONS[2].id}`);
  });

  it('leaves a number alone while it is being typed into a field', async () => {
    render(
      <>
        <input aria-label="Somewhere to type" />
        <GrowthSectionRail />
      </>
    );
    const pressed: string[] = [];
    screen.getByRole('navigation', { name: 'Growth sections' }).addEventListener('click', () => {
      pressed.push('pressed');
    });
    await userEvent.click(screen.getByRole('textbox', { name: 'Somewhere to type' }));
    await userEvent.keyboard('2');
    expect(pressed).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Somewhere to type' })).toHaveValue('2');
  });

  it('marks one section at a time as where the reader is', () => {
    renderRail();
    fireEvent.scroll(document);
    expect(markedLink()).not.toBeNull();
    expect(railLinks().filter((link) => link.getAttribute('aria-current') !== null)).toHaveLength(
      1
    );
  });

  it('marks the last section once the page has run out of scroll', () => {
    renderRailIn(scroller({ content: 2000, box: 800, at: 1200 }));
    fireEvent.scroll(document);
    expect(markedLink()).toHaveAccessibleName(
      // A name no link carries, so an absent last section cannot pass this.
      new RegExp(GROWTH_SECTIONS.at(-1)?.heading ?? 'no section the rail draws')
    );
  });

  it('marks the section the line has reached while scroll is left', () => {
    renderRailIn(scroller({ content: 2000, box: 800, at: 600 }));
    fireEvent.scroll(document);
    expect(markedLink()).toHaveAccessibleName(new RegExp(GROWTH_SECTIONS[0].heading));
  });

  it("publishes the jump's landing line in the scroll container's own coordinates", () => {
    const container = scroller({ content: 2000, box: 800, at: 0 });
    layOutAt(container, 56);
    renderRailIn(container);
    layOutAt(screen.getByRole('navigation', { name: 'Growth sections' }), 209);
    fireEvent.scroll(document);
    expect(document.documentElement.style.getPropertyValue('--growth-anchor-line')).toBe('153px');
  });

  it('publishes the landing line again when the header around the rail changes size', () => {
    recordObservers();
    const container = scroller({ content: 2000, box: 800, at: 0 });
    layOutAt(container, 56);
    renderRailIn(container);
    const rail = screen.getByRole('navigation', { name: 'Growth sections' });
    // The header grows as its reads answer, which moves the rail down without
    // resizing the rail itself.
    layOutAt(rail, 209);
    layOutObserved(headerIn(container));
    expect(document.documentElement.style.getPropertyValue('--growth-anchor-line')).toBe('153px');
  });

  it('keeps publishing on every later change of the header’s size', () => {
    recordObservers();
    const container = scroller({ content: 2000, box: 800, at: 0 });
    layOutAt(container, 56);
    renderRailIn(container);
    const rail = screen.getByRole('navigation', { name: 'Growth sections' });
    layOutAt(rail, 209);
    layOutObserved(headerIn(container));
    layOutAt(rail, 240);
    layOutObserved(headerIn(container));
    expect(document.documentElement.style.getPropertyValue('--growth-anchor-line')).toBe('184px');
  });

  it('stops watching the header once the rail is gone', () => {
    recordObservers();
    const { unmount } = render(<GrowthSectionRail />);
    unmount();
    expect(RecordingObserver.built).not.toHaveLength(0);
    expect(RecordingObserver.built.every((observer) => observer.disconnected)).toBe(true);
  });

  it('marks the section resting at the top of the scrollport with the rail scrolled away', () => {
    const container = scroller({ content: 8000, box: 800, at: 3211 });
    layOutAt(container, 53);
    renderRailIn(container);
    layOutAt(screen.getByRole('navigation', { name: 'Growth sections' }), -3211);
    // The arrangement a jump leaves below the breakpoint that pins the header:
    // the rail has scrolled far out of the scrollport and the jumped-to
    // section's top is resting at the scrollport's own start, which is 53 below
    // the top of the viewport.
    for (const [id, top] of [
      ['conversion', -3300],
      ['traffic', -1200],
      ['behaviour', 53],
      ['attribution', 900],
    ] as const) {
      const element = document.querySelector(`#${id}`);
      if (element !== null) layOutAt(element, top);
    }
    fireEvent.scroll(document);
    expect(markedLink()).toHaveAccessibleName(/Behaviour/);
  });

  it('records where the reader is nowhere but the link it marks', () => {
    renderRail();
    const before = globalThis.location.hash;
    fireEvent.scroll(document);
    expect(globalThis.location.hash).toBe(before);
  });
});
