import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MARKETING_ROUTES } from '@hushbox/shared';
import { ClickOverlay } from './click-overlay.js';
import { GROUP_BORDER, RAIL_WIDTH } from './click-overlay-boxes.js';
import type { OverlayRect, OverlaySize } from './click-overlay-boxes.js';
import type { EventTotal } from './events-panel.js';

/**
 * The test runtime's own handle on the DOM implementation, which the standard
 * `Window` type does not carry. Asserted rather than declared because it is the
 * implementation speaking about itself, not a contract this file stands in for.
 */
interface TestRuntimeWindow {
  readonly happyDOM: {
    readonly settings: {
      readonly navigation: {
        disableChildFrameNavigation: boolean;
        disableFallbackToSetURL: boolean;
      };
    };
  };
}

/**
 * The row the group is drawn in and the box the frame is drawn in, which a
 * layout-free document reports neither of. The width is the row's, and is chosen
 * so the widest device's fit scale comes out exact: it leaves the frame 1024
 * once the rail and the group's border have taken theirs, and 1024 against 1280
 * is four fifths. The height is the box's, which is the 38rem row at this
 * runtime's sixteen-pixel root less that same border top and bottom, so the
 * frame's own viewport is 757.5 pixels tall.
 */
const BOX = {
  width: 1024 + RAIL_WIDTH + 2 * GROUP_BORDER,
  height: 38 * 16 - 2 * GROUP_BORDER,
} as const;

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

beforeAll(() => {
  // The DOM implementation fetches an iframe's `src` for real. Nothing serves
  // the framed page here and each test supplies the framed document itself, so
  // the request only aborts noisily at teardown. Navigation off leaves the frame
  // its own blank document, which is what these tests fill.
  const navigation = (globalThis as unknown as TestRuntimeWindow).happyDOM.settings.navigation;
  navigation.disableChildFrameNavigation = true;
  navigation.disableFallbackToSetURL = true;
  // The stylesheet carries the ramp outside this runtime; here the document
  // carries it, because the heat reads its colours off the document it is in.
  themeRamp(LIGHT_RAMP);
  // The panel's room is a measurement, and this runtime lays nothing out. The
  // overlay reads it off the element it renders, so the element's own reading is
  // what is stated here.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: (): number => BOX.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: (): number => BOX.height,
  });
});

afterAll(() => {
  if (originalClientWidth !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
  if (originalClientHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
  }
});

const PAGE = { basePath: '/preview', path: '/welcome' } as const;

const TOTALS: readonly EventTotal[] = [
  { eventName: 'link:/chat', path: '/welcome', visitors: 42, overflow: false },
  { eventName: 'start-chatting-free', path: '/welcome', visitors: 7, overflow: true },
];

/** The page's box, as a layout-free document reports none of its own. */
const ELEMENT_BOX = { left: 20, top: 100, width: 200, height: 40 } as DOMRect;

/** What the framed page reports as its own extent. */
const CONTENT: OverlaySize = { width: 1000, height: 2000 };

/** The frame the overlay rendered. */
function framed(): HTMLIFrameElement {
  const frame = screen.getByTitle(/welcome/i);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('the overlay rendered no frame');
  return frame;
}

/** What the overlay has badged, each badge's own words. */
function badgeWords(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="overlay-badge"]')].map(
    (badge) => badge.textContent
  );
}

/** One live `ResizeObserver`, as this file drives it in place of a layout engine. */
interface RecordedObserver {
  readonly targets: Element[];
  readonly fire: () => void;
}

const observers: RecordedObserver[] = [];
const originalResizeObserver = globalThis.ResizeObserver;

/**
 * Hands out observers this file can fire by hand. The runtime lays nothing out,
 * so nothing would ever notify an observer of a box that changed.
 */
function recordObservers(): void {
  globalThis.ResizeObserver = class {
    private readonly record: RecordedObserver;

    constructor(callback: () => void) {
      this.record = { targets: [], fire: callback };
      observers.push(this.record);
    }

    observe(target: Element): void {
      this.record.targets.push(target);
    }

    unobserve(): void {
      /* nothing to forget: the record is read by the test, not by the observer */
    }

    disconnect(): void {
      /* nothing to forget: the record is read by the test, not by the observer */
    }
  } as unknown as typeof globalThis.ResizeObserver;
}

/** The observer watching `target`, which the overlay set up on mount. */
function observerOf(target: Element): RecordedObserver {
  const found = observers.find((observer) => observer.targets.includes(target));
  if (found === undefined) throw new Error('nothing observes that element');
  return found;
}

/** Every element carrying `slot` inside `root`, as elements with a dataset. */
function marks(root: HTMLElement, name: string): HTMLElement[] {
  return [...root.querySelectorAll(`[data-slot="${name}"]`)].filter(
    (element): element is HTMLElement => element instanceof HTMLElement
  );
}

/** The one element carrying `slot`, which the overlay always renders. */
function slot(container: HTMLElement, name: string): HTMLElement {
  const element = container.querySelector(`[data-slot="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`the overlay rendered no ${name}`);
  return element;
}

/** The document inside `frame`, which is same-origin and so always readable here. */
function documentIn(frame: HTMLIFrameElement): Document {
  const frameDocument = frame.contentDocument;
  if (frameDocument === null) throw new Error('the framed document is unreachable');
  return frameDocument;
}

/** The window inside `frame`, which every scroll of the framed page is read from. */
function windowIn(frame: HTMLIFrameElement): Window {
  const view = frame.contentWindow;
  if (view === null) throw new Error('the framed window is unreachable');
  return view;
}

/**
 * Lets the frame finish reporting the blank document it starts with, which it
 * does on its own and after the render call has returned.
 */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** How the framed page laid an element out, where a test says so per element. */
type Layout = (element: Element) => OverlayRect;

/**
 * A layout reading each element's box off its own `data-box` attribute, falling
 * back to the default. Keyed off that attribute rather than `id`, because the
 * name derivation reads an element's `id` and a test keying on it would badge
 * the key instead of the link.
 */
function boxes(map: Readonly<Record<string, OverlayRect>>): Layout {
  return (element) =>
    map[element instanceof HTMLElement ? (element.dataset['box'] ?? '') : ''] ?? ELEMENT_BOX;
}

/**
 * The overlay with `html` as the framed page's body, laid out and measured.
 * A layout-free document gives every box zero size, so the page's own extent
 * and each element's box are stated here instead.
 */
async function renderFramed(
  html: string,
  options: {
    readonly totals?: readonly EventTotal[];
    readonly content?: OverlaySize;
    readonly layout?: Layout;
    /** The ramp the framed page itself resolves, which the heat is painted in. */
    readonly ramp?: readonly string[];
  } = {}
): Promise<HTMLElement> {
  const { container } = render(<ClickOverlay page={PAGE} totals={options.totals ?? TOTALS} />);
  await settleFrame();
  const frame = framed();
  const frameDocument = documentIn(frame);
  frameDocument.body.innerHTML = html;
  const root = frameDocument.documentElement;
  rampOn(root, options.ramp ?? LIGHT_RAMP);
  const content = options.content ?? CONTENT;
  Object.defineProperty(root, 'scrollWidth', { value: content.width, configurable: true });
  Object.defineProperty(root, 'scrollHeight', { value: content.height, configurable: true });
  const layout = options.layout;
  for (const element of frameDocument.body.querySelectorAll('*')) {
    element.getBoundingClientRect = (): DOMRect =>
      layout === undefined ? ELEMENT_BOX : (layout(element) as DOMRect);
  }
  fireEvent.load(frame);
  return container;
}

/** Puts the overlay in one of its three views. */
function chooseOverlay(name: string): void {
  fireEvent.click(screen.getByRole('radio', { name }));
}

/** Puts the frame at one of its three device widths. */
function chooseDevice(name: string): void {
  fireEvent.click(screen.getByRole('radio', { name }));
}

/** The ramp's step tokens, in the order the heat reads them. */
const RAMP_TOKENS = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'] as const;

/** The ramp as one theme resolves it, and as another. */
const LIGHT_RAMP = ['#e8eef8', '#cddbf1', '#a9c2e7', '#82a8db', '#5b8ccb'] as const;
const DARK_RAMP = ['#1e2733', '#26364a', '#2f4661', '#39567a', '#436894'] as const;

/**
 * Puts `ramp` on `root`, which is where the stylesheet would carry it outside
 * this runtime. Both documents get one: the framed page carries the ramp the
 * heat is painted in, and this screen carries the ramp its legend is drawn in.
 */
function rampOn(root: HTMLElement, ramp: readonly string[]): void {
  for (const [index, token] of RAMP_TOKENS.entries()) {
    root.style.setProperty(token, ramp[index] ?? '');
  }
}

/** Puts `ramp` on the admin screen's own document. */
function themeRamp(ramp: readonly string[]): void {
  rampOn(document.documentElement, ramp);
}

/** Every colour one paint of the heat handed the canvas. */
interface PaintRecord {
  readonly colours: string[];
  readonly sizes: [number, number][];
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;

/**
 * Makes every canvas hand out a context that records what it was asked to
 * paint. This runtime lays nothing out and draws nothing, so the drawing itself
 * is what is observed. `alpha` is what a painted pixel reads back as: zero is
 * the canvas the browser would not allocate, which takes every drawing call and
 * holds none of it.
 */
function recordPaint(alpha = 158): PaintRecord {
  const colours: string[] = [];
  const sizes: [number, number][] = [];
  const context = {
    getImageData: (): ImageData =>
      ({ data: Uint8ClampedArray.from([0, 0, 0, alpha]) }) as ImageData,
    clearRect: (_x: number, _y: number, width: number, height: number): void => {
      sizes.push([width, height]);
    },
    createRadialGradient: (): CanvasGradient =>
      ({
        addColorStop: (_offset: number, colour: string): void => {
          colours.push(colour);
        },
      }) as unknown as CanvasGradient,
    save: (): void => undefined,
    restore: (): void => undefined,
    translate: (): void => undefined,
    scale: (): void => undefined,
    beginPath: (): void => undefined,
    arc: (): void => undefined,
    fill: (): void => undefined,
    fillStyle: '',
  };
  HTMLCanvasElement.prototype.getContext = ((): CanvasRenderingContext2D =>
    context as unknown as CanvasRenderingContext2D) as unknown as typeof originalGetContext;
  return { colours, sizes };
}

afterEach(() => {
  // Unmounted before the root's theme is reset: the overlay observes that class,
  // and a change it sees while mounted is a render outside any act.
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  observers.length = 0;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  // The ramp is left on the document rather than cleared. A theme change is
  // delivered to the heat's observer as a microtask, so a repaint can still be
  // in flight here, and clearing the tokens would refuse it a colour the
  // stylesheet always has.
  themeRamp(LIGHT_RAMP);
  document.documentElement.classList.remove('dark');
});

describe('ClickOverlay', () => {
  it('frames the page under the prefix the admin origin serves the copy at', async () => {
    render(<ClickOverlay page={PAGE} totals={TOTALS} />);
    await settleFrame();
    expect(framed()).toHaveAttribute('src', '/preview/welcome/');
  });

  it('frames the page with same-origin access and no permission to run its scripts', async () => {
    render(<ClickOverlay page={PAGE} totals={TOTALS} />);
    await settleFrame();
    expect(framed()).toHaveAttribute('sandbox', 'allow-same-origin');
  });

  it('puts the framed page in the dark theme the admin screen is in', async () => {
    document.documentElement.classList.add('dark');
    await renderFramed('<a href="/chat">Start</a>');
    expect(documentIn(framed()).documentElement).toHaveClass('dark');
  });

  it('moves the framed page into the dark theme when the admin screen switches to it', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    await act(async () => {
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });
    expect(documentIn(framed()).documentElement).toHaveClass('dark');
  });

  it('moves the framed page back to light when the admin screen switches to it', async () => {
    document.documentElement.classList.add('dark');
    await renderFramed('<a href="/chat">Start</a>');
    const frameRoot = documentIn(framed()).documentElement;
    // The page has to have been dark for the switch back to be a change.
    expect(frameRoot).toHaveClass('dark');
    await act(async () => {
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });
    expect(frameRoot).not.toHaveClass('dark');
  });

  it('badges a link with the count recorded against its derived name', async () => {
    expect(badgeWords(await renderFramed('<a href="/chat">Start</a>'))).toEqual(['link:/chat: 42']);
  });

  it('badges a button with the count its own copy derives', async () => {
    expect(badgeWords(await renderFramed('<button>Start Chatting Free</button>'))).toEqual([
      'start-chatting-free: 7+',
    ]);
  });

  it('leaves an element the derivation names nothing for unbadged', async () => {
    expect(badgeWords(await renderFramed('<button>&rarr;</button>'))).toEqual([]);
  });

  it('leaves an element the page does not lay out unbadged', async () => {
    const { container } = render(<ClickOverlay page={PAGE} totals={TOTALS} />);
    await settleFrame();
    const frame = framed();
    documentIn(frame).body.innerHTML = '<a href="/chat">Start</a>';
    fireEvent.load(frame);
    expect(badgeWords(container)).toEqual([]);
  });

  it('hangs the badge above the element it labels', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(container.querySelector('[data-slot="overlay-badge"]')).toHaveStyle({
      left: '20px',
      top: '84px',
    });
  });

  it('clears the badges it drew once a load leaves the framed document unreadable', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(badgeWords(container)).toEqual(['link:/chat: 42']);
    const frame = framed();
    Object.defineProperty(frame, 'contentDocument', { value: null, configurable: true });
    fireEvent.load(frame);
    expect(badgeWords(container)).toEqual([]);
  });

  it('badges nothing while the framed document is unreachable', async () => {
    const { container } = render(<ClickOverlay page={PAGE} totals={TOTALS} />);
    await settleFrame();
    const frame = framed();
    Object.defineProperty(frame, 'contentDocument', { value: null, configurable: true });
    fireEvent.load(frame);
    expect(badgeWords(container)).toEqual([]);
  });

  it('holds the frame at the room the panel gives it, not at the height of the page inside', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    expect(framed()).toHaveStyle({ width: '1280px', height: '757.5px' });
  });

  it('leaves the frame the same height when the page inside it reports a taller one', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const root = documentIn(framed()).documentElement;
    Object.defineProperty(root, 'scrollHeight', { value: 11_804, configurable: true });
    fireEvent.load(framed());
    expect(badgeWords(container)).toEqual(['link:/chat: 42']);
    expect(framed()).toHaveStyle({ height: '757.5px' });
  });

  it('scales the frame down to the room it has and states the scale it settled on', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-stage')).toHaveStyle({ transform: 'scale(0.8)' });
    expect(screen.getByText(/1280px wide, shown at 80%/)).toBeInTheDocument();
  });

  it('frames a narrower device at its own size rather than blowing it up', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    act(() => {
      chooseDevice('Phone');
    });
    expect(framed()).toHaveStyle({ width: '390px' });
    expect(slot(container, 'overlay-stage')).toHaveStyle({ transform: 'scale(1)' });
  });

  it('moves the overlay with the framed page rather than re-measuring it', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const view = windowIn(framed());
    Object.defineProperty(view, 'scrollY', { value: 500, configurable: true });
    act(() => {
      view.dispatchEvent(new Event('scroll'));
    });
    expect(slot(container, 'overlay-document-layer').style.transform).toBe('translateY(-500px)');
    expect(container.querySelector('[data-slot="overlay-badge"]')).toHaveStyle({ top: '84px' });
  });

  it('drops the badges of the elements nobody clicked while the heat is drawn beside them', async () => {
    const container = await renderFramed('<a href="/roadmap">Roadmap</a>');
    expect(badgeWords(container)).toEqual([]);
  });

  it('badges every figure, zero included, in the view that draws no heat', async () => {
    const container = await renderFramed('<a href="/roadmap">Roadmap</a>');
    act(() => {
      chooseOverlay('Counts');
    });
    expect(badgeWords(container)).toEqual(['link:/roadmap: 0']);
  });

  it('draws no badge at all in the view that is only heat', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    act(() => {
      chooseOverlay('Heat');
    });
    expect(badgeWords(container)).toEqual([]);
  });

  it('keeps a badge over an element the page pins to its own viewport off the scrolling layer', async () => {
    const container = await renderFramed(
      '<header style="position:fixed"><a data-box="pinned" href="/chat">Start</a></header>'
    );
    expect(badgeWords(slot(container, 'overlay-viewport-layer'))).toEqual(['link:/chat: 42']);
    expect(badgeWords(slot(container, 'overlay-document-layer'))).toEqual([]);
  });

  it('leaves that badge where it is while the framed page scrolls under it', async () => {
    const container = await renderFramed(
      '<header style="position:fixed"><a data-box="pinned" href="/chat">Start</a></header>'
    );
    const view = windowIn(framed());
    Object.defineProperty(view, 'scrollY', { value: 500, configurable: true });
    act(() => {
      view.dispatchEvent(new Event('scroll'));
    });
    expect(slot(container, 'overlay-document-layer').style.transform).toBe('translateY(-500px)');
    expect(slot(container, 'overlay-viewport-layer').style.transform).toBe('');
    expect(container.querySelector('[data-slot="overlay-badge"]')).toHaveStyle({ top: '84px' });
  });

  it('brings a pinned element badged past the frame viewport back inside the viewport', async () => {
    const container = await renderFramed(
      '<header style="position:fixed"><a data-box="pinned" href="/chat">Start</a></header>',
      { layout: boxes({ pinned: { left: 20, top: 1000, width: 200, height: 40 } }) }
    );
    expect(
      slot(container, 'overlay-viewport-layer').querySelector('[data-slot="overlay-badge"]')
    ).toHaveStyle({ top: '741.5px' });
  });

  it('badges an element the framed page lays out below its first viewport', async () => {
    const container = await renderFramed('<a data-box="deep" href="/chat">Start</a>', {
      content: { width: 1280, height: 11_804 },
      layout: boxes({ deep: { left: 20, top: 7000, width: 200, height: 40 } }),
    });
    expect(
      slot(container, 'overlay-document-layer').querySelector('[data-slot="overlay-badge"]')
    ).toHaveStyle({ top: '6984px' });
  });

  it('sizes the heat to the framed page rather than to the frame that shows it', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>', {
      content: { width: 1280, height: 6400 },
    });
    expect(slot(container, 'overlay-heat')).toHaveAttribute('width', '1280');
    expect(slot(container, 'overlay-heat')).toHaveAttribute('height', '6400');
  });

  it('says the heat could not be drawn when the canvas holds nothing it was painted with', async () => {
    recordPaint(0);
    const container = await renderFramed('<a href="/chat">Start</a>', {
      content: { width: 1280, height: 70_000 },
    });
    expect(slot(container, 'overlay-heat-refused').textContent).toMatch(/could not be drawn/i);
    expect(container.querySelector('[data-slot="overlay-heat"]')).toBeNull();
  });

  it('keeps every figure badged where the heat could not be drawn', async () => {
    recordPaint(0);
    const container = await renderFramed('<a href="/chat">Start</a>', {
      content: { width: 1280, height: 70_000 },
    });
    expect(badgeWords(container)).toEqual(['link:/chat: 42']);
  });

  it('drops the ramp key from the legend where the heat it keys is not on screen', async () => {
    recordPaint(0);
    const container = await renderFramed('<a href="/chat">Start</a>', {
      content: { width: 1280, height: 70_000 },
    });
    const legend = slot(container, 'overlay-legend').textContent;
    expect(legend).not.toMatch(/Visitors/);
    // The badge keys describe marks the canvas had no part in drawing.
    expect(legend).toMatch(/42Most clicked/);
  });

  it('holds no heat canvas over a page where the read counted nothing', async () => {
    const container = await renderFramed('<a href="/roadmap">Roadmap</a>');
    expect(container.querySelector('[data-slot="overlay-heat"]')).toBeNull();
  });

  it('draws no heat at all in the view that is only counts', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    act(() => {
      chooseOverlay('Counts');
    });
    expect(container.querySelector('[data-slot="overlay-heat"]')).toBeNull();
  });

  it('paints the heat in the ramp the theme resolved, holding no colour of its own', async () => {
    const painted = recordPaint();
    await renderFramed('<a href="/chat">Start</a>');
    expect(painted.colours.some((colour) => colour.startsWith(LIGHT_RAMP[4]))).toBe(true);
    expect(painted.colours.every((colour) => colour.startsWith('#'))).toBe(true);
  });

  it('paints in the ramp the framed page resolves, not the one the admin screen is in', async () => {
    const painted = recordPaint();
    themeRamp(DARK_RAMP);
    await renderFramed('<a href="/chat">Start</a>');
    expect(painted.colours.some((colour) => colour.startsWith(LIGHT_RAMP[4]))).toBe(true);
    expect(painted.colours.some((colour) => colour.startsWith(DARK_RAMP[4]))).toBe(false);
  });

  it('re-reads the ramp and paints again when the framed page changes theme under it', async () => {
    const painted = recordPaint();
    await renderFramed('<a href="/chat">Start</a>');
    painted.colours.length = 0;
    const root = documentIn(framed()).documentElement;
    await act(async () => {
      rampOn(root, DARK_RAMP);
      root.classList.add('dark');
      await Promise.resolve();
    });
    expect(painted.colours.some((colour) => colour.startsWith(DARK_RAMP[4]))).toBe(true);
  });

  it('keeps the heat out of the reading order, because every figure is a badge', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-heat')).toHaveAttribute('aria-hidden', 'true');
  });

  it('bands the rail by where the page counted its clicks, and ranks the bands', async () => {
    const container = await renderFramed(
      '<a data-box="top" href="/chat">Start</a><button data-box="foot">Start Chatting Free</button>',
      {
        content: { width: 1280, height: 1400 },
        layout: boxes({
          top: { left: 20, top: 0, width: 200, height: 40 },
          foot: { left: 20, top: 1300, width: 200, height: 40 },
        }),
      }
    );
    const steps = marks(slot(container, 'overlay-rail'), 'overlay-rail-band').map(
      (band) => band.dataset['step']
    );
    expect(steps[0]).toBe('5');
    expect(steps[13]).toBe('1');
    expect(steps[6]).toBe('0');
  });

  it('marks a band with nothing counted in it with a dash rather than the palest shade', async () => {
    const container = await renderFramed('<a data-box="top" href="/chat">Start</a>', {
      content: { width: 1280, height: 1400 },
      layout: boxes({ top: { left: 20, top: 0, width: 200, height: 40 } }),
    });
    const bands = marks(slot(container, 'overlay-rail'), 'overlay-rail-band');
    const empty = bands[6];
    expect(empty?.dataset['step']).toBe('0');
    expect(empty?.className).not.toContain('bg-seq-');
    expect(empty?.querySelector('[data-slot="overlay-rail-nothing"]')).not.toBeNull();
  });

  it('shades a counted band through the shared ramp', async () => {
    const container = await renderFramed('<a data-box="top" href="/chat">Start</a>', {
      content: { width: 1280, height: 1400 },
      layout: boxes({ top: { left: 20, top: 0, width: 200, height: 40 } }),
    });
    const bands = marks(slot(container, 'overlay-rail'), 'overlay-rail-band');
    expect(bands[0]?.className).toContain('bg-seq-5');
  });

  it('moves the rail knob to where in the page the frame is looking', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>', {
      content: { width: 1280, height: 1400 },
    });
    const view = windowIn(framed());
    Object.defineProperty(view, 'scrollY', { value: 500, configurable: true });
    act(() => {
      view.dispatchEvent(new Event('scroll'));
    });
    const knob = slot(container, 'overlay-rail-knob');
    expect(Math.round(Number.parseFloat(knob.style.top))).toBe(36);
    expect(Math.round(Number.parseFloat(knob.style.height))).toBe(54);
  });

  it('keeps the rail out of the reading order, because every figure is a badge', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-rail')).toHaveAttribute('aria-hidden', 'true');
  });

  it('spends the brand red on the most clicked element and on nothing else', async () => {
    const container = await renderFramed(
      '<a href="/chat">Start</a><button>Start Chatting Free</button>'
    );
    const tones = marks(container, 'overlay-badge').map((badge) => ({
      tone: badge.dataset['tone'],
      red: badge.className.includes('bg-primary'),
    }));
    expect(tones).toEqual([
      { tone: 'most', red: true },
      { tone: 'counted', red: false },
    ]);
  });

  it('draws a counted zero as a dashed outline rather than a chip of colour', async () => {
    const container = await renderFramed('<a href="/roadmap">Roadmap</a>');
    act(() => {
      chooseOverlay('Counts');
    });
    const [badge] = marks(container, 'overlay-badge');
    expect(badge?.dataset['tone']).toBe('none');
    expect(badge?.className).toContain('border-dashed');
    expect(badge?.className).not.toContain('bg-primary');
  });

  it('states the counted range the ramp spans', async () => {
    const container = await renderFramed(
      '<a href="/chat">Start</a><button>Start Chatting Free</button>'
    );
    expect(slot(container, 'overlay-legend').textContent).toMatch(/7 to 42/);
  });

  it('says nothing was counted rather than showing a range with nothing in it', async () => {
    const container = await renderFramed('<a href="/roadmap">Roadmap</a>');
    expect(slot(container, 'overlay-legend').textContent).toMatch(/nothing on this page/i);
  });

  it('says the warmth is per element and that nothing records where inside one people clicked', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const caption = slot(container, 'overlay-caption').textContent;
    expect(caption).toMatch(/one soft field per counted link or button/i);
    expect(caption).toMatch(/no coordinate/i);
  });

  it('offers the framed page itself in a tab, so nobody retypes it to see it whole', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const open = screen.getByRole('link', { name: 'Open /welcome in a new tab' });
    expect(open).toHaveAttribute('href', '/preview/welcome/');
    expect(open).toHaveAttribute('target', '_blank');
  });

  it("hides the browser outline on that tab's link only while it has keyboard focus", async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const open = screen.getByRole('link', { name: 'Open /welcome in a new tab' });
    expect(
      [...open.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
    ).toEqual(['focus-visible:outline-hidden']);
  });

  it("draws the scroller's forced-colors outline on the group that draws its ring", async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const group = slot(container, 'overlay-viewport');
    expect(group).toHaveClass('has-[:focus-visible]:ring-2');
    expect(
      [...group.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
    ).toEqual(['has-[:focus-visible]:outline-hidden']);
  });

  it('points that tab at whichever page the frame is showing', async () => {
    const user = userEvent.setup();
    await renderFramed('<a href="/chat">Start</a>');
    await user.click(screen.getByRole('combobox', { name: /page/i }));
    await user.click(screen.getByRole('option', { name: '/roadmap' }));
    expect(screen.getByRole('link', { name: 'Open /roadmap in a new tab' })).toHaveAttribute(
      'href',
      '/preview/roadmap/'
    );
  });

  it('holds the page list behind its own trigger rather than in the control row', async () => {
    const user = userEvent.setup();
    await renderFramed('<a href="/chat">Start</a>');
    expect(screen.queryByRole('option', { name: '/roadmap' })).toBeNull();
    await user.click(screen.getByRole('combobox', { name: /page/i }));
    expect(screen.getByRole('option', { name: '/roadmap' })).toBeInTheDocument();
  });

  it('holds room in the page control for every route in the list it offers', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const trigger = screen.getByRole('combobox', { name: /page/i });
    const sizer = trigger.querySelector('[data-slot="overlay-page-sizer"]');
    const held = [...(sizer?.children ?? [])]
      .filter((child) => child.getAttribute('aria-hidden') === 'true')
      .map((child) => child.textContent);
    expect(held).toEqual([...MARKETING_ROUTES]);
  });

  it('sizes the page control by that room rather than by a width of its own', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const trigger = screen.getByRole('combobox', { name: /page/i });
    expect(trigger.className).not.toMatch(/(?:^|\s)(?:max-|min-)?w-\d/);
  });

  it("sets the page control in the control row's own type size", async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const trigger = screen.getByRole('combobox', { name: /page/i });
    expect(trigger.querySelector('[data-slot="overlay-page-sizer"]')).toHaveClass('text-xs');
  });

  it("draws the page control at the row's small control height", async () => {
    await renderFramed('<a href="/chat">Start</a>');
    expect(screen.getByRole('combobox', { name: /page/i })).toHaveAttribute('data-size', 'sm');
  });

  it('lists each page in monospace', async () => {
    const user = userEvent.setup();
    await renderFramed('<a href="/chat">Start</a>');
    await user.click(screen.getByRole('combobox', { name: /page/i }));
    expect(
      screen.getByRole('option', { name: '/roadmap' }).querySelector('.font-mono')
    ).toHaveTextContent('/roadmap');
  });

  it('draws the page control on the control border', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    expect(screen.getByRole('combobox', { name: /page/i })).toHaveClass('border-border-control');
  });

  it('sets the chosen page in monospace', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const trigger = screen.getByRole('combobox', { name: /page/i });
    expect(trigger.querySelector('[data-slot="overlay-page-sizer"]')).toHaveClass('font-mono');
  });

  it('anchors the page list to the chosen route rather than to the room held for the longest', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const trigger = screen.getByRole('combobox', { name: /page/i });
    const value = trigger.querySelector('[data-slot="select-value"]');
    expect(value?.closest('[data-slot="overlay-page-value"]')).not.toBeNull();
  });

  it('names the chosen page in the page control', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const trigger = screen.getByRole('combobox', { name: /page/i });
    expect(trigger.querySelector('[data-slot="overlay-page-value"]')).toHaveTextContent(PAGE.path);
  });

  it('adds no width correction of its own to a segment, leaving that to the shared control', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const items = [...container.querySelectorAll('[data-slot="toggle-group-item"]')];
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item.className).not.toMatch(/(?:^|\s)flex-none(?:\s|$)/);
    }
  });

  it('lets every control in the row narrow below the width of what it holds', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const controls = [...container.querySelectorAll('[data-slot="overlay-control"]')];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.className).toContain('min-w-0');
    }
  });

  it('wraps a control under its own label rather than squeezing the value it shows', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const controls = [...container.querySelectorAll('[data-slot="overlay-control"]')];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.className).toContain('flex-wrap');
    }
  });

  it('wraps a segmented control onto a second line rather than past the row it sits in', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const groups = [...container.querySelectorAll('[data-slot="toggle-group"]')];
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.className).toContain('flex-wrap');
    }
  });

  it('frames another of the site own pages when one is chosen', async () => {
    const user = userEvent.setup();
    await renderFramed('<a href="/chat">Start</a>');
    await user.click(screen.getByRole('combobox', { name: /page/i }));
    await user.click(screen.getByRole('option', { name: '/roadmap' }));
    // The frame reports the page it was pointed at on its own, after the change
    // has returned, exactly as it does on mount.
    await settleFrame();
    expect(screen.getByTitle(/roadmap/i)).toHaveAttribute('src', '/preview/roadmap/');
  });

  it('badges nothing while the framed window is unreachable', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const frame = framed();
    Object.defineProperty(frame, 'contentWindow', { value: null, configurable: true });
    fireEvent.load(frame);
    expect(badgeWords(container)).toEqual([]);
  });

  it('keeps the device it is on when the chosen width is clicked again', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    act(() => {
      chooseDevice('Desktop');
    });
    expect(framed()).toHaveStyle({ width: '1280px' });
    expect(slot(container, 'overlay-stage')).toHaveStyle({ transform: 'scale(0.8)' });
  });

  it('keeps the view it is on when the chosen view is clicked again', async () => {
    const container = await renderFramed('<a href="/chat">Start</a><a href="/roadmap">Roadmap</a>');
    act(() => {
      chooseOverlay('Heat and counts');
    });
    expect(badgeWords(container)).toEqual(['link:/chat: 42']);
    expect(container.querySelector('[data-slot="overlay-heat"]')).not.toBeNull();
  });

  it('warms a pinned element over the frame rather than over the page under it', async () => {
    const container = await renderFramed(
      '<header style="position:fixed"><a data-box="pinned" href="/chat">Start</a></header>'
    );
    const pinnedHeat = slot(container, 'overlay-viewport-layer').querySelector(
      '[data-slot="overlay-heat"]'
    );
    expect(pinnedHeat).not.toBeNull();
    expect(pinnedHeat).toHaveAttribute('height', '758');
  });

  it('draws no heat over the frame where the page pins nothing it counted', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(
      slot(container, 'overlay-viewport-layer').querySelector('[data-slot="overlay-heat"]')
    ).toBeNull();
  });

  it('reads the page again when the framed page settles into a taller box', async () => {
    recordObservers();
    const container = await renderFramed('<a data-box="deep" href="/chat">Start</a>', {
      content: { width: 1280, height: 1000 },
      layout: boxes({ deep: { left: 20, top: 900, width: 200, height: 40 } }),
    });
    // Clamped into the page as it was first measured: the badge cannot hang
    // below the foot of a page 1000 pixels tall.
    expect(slot(container, 'overlay-document-layer').style.height).toBe('1000px');
    const root = documentIn(framed()).documentElement;
    Object.defineProperty(root, 'scrollHeight', { value: 6000, configurable: true });
    act(() => {
      observerOf(root).fire();
    });
    expect(slot(container, 'overlay-document-layer').style.height).toBe('6000px');
    expect(
      slot(container, 'overlay-document-layer').querySelector('[data-slot="overlay-badge"]')
    ).toHaveStyle({ top: '884px' });
  });

  it('leaves the most-clicked key out where nothing on the page was clicked', async () => {
    const container = await renderFramed('<a href="/roadmap">Roadmap</a>');
    const legend = slot(container, 'overlay-legend').textContent;
    expect(legend).not.toMatch(/most clicked/i);
    expect(legend).toMatch(/counted nobody/i);
  });

  it('scrolls the framed page inside a box a keyboard can reach, named for the page it frames', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const region = screen.getByRole('group', { name: 'Where people clicked on /welcome' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(framed());
  });

  // The framed page fills the box to its corners, so a rounded box would clip them.
  it('keeps the box square, so its corners cut nothing of the framed page', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    expect(screen.getByRole('group', { name: /^Where people clicked on / }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });

  // The region fills a group that clips its overflow, so a ring drawn outside the
  // region is cut away, and a scroller's own outline paints under the framed page;
  // the group's own box is not clipped, so the group draws the ring instead.
  it('has the bordered group draw the focus ring while the region inside it is focused', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    const group = slot(container, 'overlay-viewport');
    expect(group).toHaveClass('has-[:focus-visible]:ring-2');
    expect(group).toHaveClass('has-[:focus-visible]:ring-ring');
  });

  it('draws no ring of its own on the region, so no clipped sliver of one remains', async () => {
    await renderFramed('<a href="/chat">Start</a>');
    const region = screen.getByRole('group', { name: /^Where people clicked on / });
    expect(region).toHaveClass('focus-visible:ring-0');
    expect(region).not.toHaveClass('focus-visible:ring-2');
  });

  it('is the box the frame height is read off, so the frame fits the region it scrolls in', async () => {
    recordObservers();
    await renderFramed('<a href="/chat">Start</a>');
    const region = screen.getByRole('group', { name: /^Where people clicked on / });
    expect(observers.some((observer) => observer.targets.includes(region))).toBe(true);
  });

  it('keys the most-clicked badge with the figure that earned it', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-legend').textContent).toMatch(/42Most clicked/);
  });

  it('collapses the bordered group to the framed device and the rail beside it', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    act(() => {
      chooseDevice('Phone');
    });
    expect(slot(container, 'overlay-viewport')).toHaveStyle({
      width: `${String(390 + RAIL_WIDTH + 2 * GROUP_BORDER)}px`,
    });
  });

  it('draws the chrome the room arithmetic takes off the row at those very widths', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-viewport')).toHaveStyle({
      borderWidth: `${String(GROUP_BORDER)}px`,
    });
    expect(slot(container, 'overlay-rail')).toHaveStyle({ width: `${String(RAIL_WIDTH)}px` });
  });

  // The fixture is the knife edge, framed width equal to its room; the strictly-wider
  // branch is proven in `apps/admin/src/components/growth/click-overlay-boxes.test.ts`.
  it('spans the row with the group once the frame fills the room', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-viewport')).toHaveStyle({ width: `${String(BOX.width)}px` });
  });

  it('centres the group in the row rather than pinning it to one edge', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-viewport').className).toContain('mx-auto');
  });

  it('never lets the group outrun the row it was measured against', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-viewport').className).toContain('max-w-full');
  });

  it('holds the frame row at the height this section is drawn at', async () => {
    const container = await renderFramed('<a href="/chat">Start</a>');
    expect(slot(container, 'overlay-viewport').className).toContain('h-[38rem]');
  });

  it('reads the room off the row rather than off the box the frame itself sizes', async () => {
    recordObservers();
    const container = await renderFramed('<a href="/chat">Start</a>');
    act(() => {
      chooseDevice('Phone');
    });
    const group = slot(container, 'overlay-viewport');
    const collapsed = 390 + RAIL_WIDTH + 2 * GROUP_BORDER;
    expect(group).toHaveStyle({ width: `${String(collapsed)}px` });
    // What a layout engine reports once the group has collapsed. A scale read
    // from the frame's own box would shrink the frame that sized the box, and
    // the next reading would shrink it again.
    const box = group.firstElementChild;
    if (box === null) throw new Error('the overlay rendered no box for the frame');
    Object.defineProperty(group, 'clientWidth', { value: collapsed, configurable: true });
    Object.defineProperty(box, 'clientWidth', { value: 390, configurable: true });
    act(() => {
      observerOf(slot(container, 'overlay-row')).fire();
    });
    expect(group).toHaveStyle({ width: `${String(collapsed)}px` });
    expect(screen.getByText(/390px wide, shown at 100%/)).toBeInTheDocument();
  });
});
