import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { observeTextMetrics } from '@hushbox/ui/text-metrics';
import { initSiteMenu } from './site-menu';

vi.mock('@hushbox/ui/text-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui/text-metrics')>();
  return { observeTextMetrics: vi.fn(actual.observeTextMetrics) };
});

const DESKTOP_WIDTH = 1024;
const PHONE_WIDTH = 390;

// The header's row is laid out by a real engine only. The fixture's row is `available`
// wide with a 24px end padding, and the full nav, while shown, ends where a row `needed`
// wide would put it; while the header is compact the nav has no box, so a reading taken in
// the compact layout would pass. As in Chromium, the row's scroll width never counts the
// end padding the nav runs into.
const ROW_END_PADDING = 24;
const layout = { available: 1000, needed: 900, headerHeight: 65 };

/** Whether the header shows the menu button in place of the full nav. */
function isCompact(header: HTMLElement): boolean {
  return header.dataset['navCompact'] !== undefined;
}

function setViewportWidth(width: number): void {
  Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: width });
}

function mountPage(): HTMLElement {
  document.body.innerHTML = `
    <div id="banner"><button type="button">Dismiss</button></div>
    <header data-site-header>
      <div data-site-header-row style="padding-right: ${String(ROW_END_PADDING)}px">
        <a href="/welcome">HushBox</a>
        <nav data-site-nav><a href="/chat">Open HushBox</a></nav>
        <button type="button" data-site-menu-toggle aria-controls="landing-mobile-menu" aria-expanded="false" aria-label="Open menu">menu</button>
      </div>
      <div id="landing-mobile-menu" data-site-menu-panel hidden>
        <a href="/blog">Blog</a>
        <a href="/chat">Open HushBox</a>
      </div>
    </header>
    <main><a href="/roadmap">Roadmap</a></main>
    <footer><a href="/terms">Terms</a></footer>
    <div id="widget"><button type="button">Accessibility settings</button></div>
  `;
  const header = document.querySelector<HTMLElement>('[data-site-header]');
  const row = document.querySelector<HTMLElement>('[data-site-header-row]');
  const nav = document.querySelector<HTMLElement>('[data-site-nav]');
  if (header === null || row === null || nav === null) throw new Error('fixture incomplete');
  Object.defineProperty(row, 'clientWidth', { get: () => layout.available });
  Object.defineProperty(row, 'scrollWidth', { get: () => layout.available });
  Object.defineProperty(row, 'getBoundingClientRect', {
    value: (): DOMRect => new DOMRect(0, 0, layout.available, layout.headerHeight),
  });
  Object.defineProperty(nav, 'getBoundingClientRect', {
    value: (): DOMRect =>
      isCompact(header)
        ? new DOMRect(0, 0, 0, 0)
        : new DOMRect(0, 0, layout.needed - ROW_END_PADDING, layout.headerHeight),
  });
  Object.defineProperty(header, 'offsetHeight', { get: () => layout.headerHeight });
  return header;
}

function part(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element;
}

const toggle = (): HTMLElement => part('[data-site-menu-toggle]');
const panel = (): HTMLElement => part('[data-site-menu-panel]');

function pressEscape(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/** Lets the MutationObserver callbacks queued by the last change run. */
async function flushObservers(): Promise<void> {
  await Promise.resolve();
}

let dispose: (() => void) | undefined;

function start(root: HTMLElement): void {
  dispose = initSiteMenu(root);
}

beforeEach(() => {
  layout.available = 1000;
  layout.needed = 900;
  layout.headerHeight = 65;
  setViewportWidth(PHONE_WIDTH);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('class');
});

describe('initSiteMenu opening and closing', () => {
  it('shows the panel when the menu button is clicked', () => {
    start(mountPage());

    toggle().click();

    expect(panel().hidden).toBe(false);
  });

  it('marks the menu button expanded while the panel shows', () => {
    start(mountPage());

    toggle().click();

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('names the menu button Close menu while the panel shows', () => {
    start(mountPage());

    toggle().click();

    expect(toggle().getAttribute('aria-label')).toBe('Close menu');
  });

  it('hides the panel on a second click', () => {
    start(mountPage());

    toggle().click();
    toggle().click();

    expect(panel().hidden).toBe(true);
  });

  it('names the menu button Open menu and marks it collapsed once closed', () => {
    start(mountPage());

    toggle().click();
    toggle().click();

    expect([toggle().getAttribute('aria-label'), toggle().getAttribute('aria-expanded')]).toEqual([
      'Open menu',
      'false',
    ]);
  });

  it('closes on Escape pressed inside the header', () => {
    start(mountPage());
    toggle().click();

    pressEscape(part('[data-site-menu-panel] a'));

    expect(panel().hidden).toBe(true);
  });

  it('returns focus to the menu button when Escape closes the panel', () => {
    start(mountPage());
    toggle().click();
    part('[data-site-menu-panel] a').focus();

    pressEscape(part('[data-site-menu-panel] a'));

    expect(document.activeElement).toBe(toggle());
  });

  it('closes on Escape when nothing holds focus', () => {
    start(mountPage());
    toggle().click();

    pressEscape(document.body);

    expect(panel().hidden).toBe(true);
  });

  it('stays open on Escape pressed in a surface above the panel', () => {
    start(mountPage());
    toggle().click();

    pressEscape(part('#widget button'));

    expect(panel().hidden).toBe(false);
  });

  it('ignores keys other than Escape', () => {
    start(mountPage());
    toggle().click();

    part('[data-site-menu-panel] a').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );

    expect(panel().hidden).toBe(false);
  });
});

describe('initSiteMenu while the panel shows', () => {
  it('makes the page content behind the panel inert', () => {
    start(mountPage());

    toggle().click();

    expect([part('main').hasAttribute('inert'), part('footer').hasAttribute('inert')]).toEqual([
      true,
      true,
    ]);
  });

  it('leaves the header, the banner and the accessibility button reachable', () => {
    start(mountPage());

    toggle().click();

    expect(
      ['[data-site-header]', '#banner', '#widget'].map((selector) =>
        part(selector).hasAttribute('inert')
      )
    ).toEqual([false, false, false]);
  });

  it('makes the page content reachable again once closed', () => {
    start(mountPage());

    toggle().click();
    toggle().click();

    expect([part('main').hasAttribute('inert'), part('footer').hasAttribute('inert')]).toEqual([
      false,
      false,
    ]);
  });

  it('locks page scroll', () => {
    start(mountPage());

    toggle().click();

    expect(document.documentElement.style.overflow).toBe('hidden');
  });

  // With the scrollbar gone the header would widen, and a nav that did not fit beside a
  // scrollbar could then fit, closing the menu the reader just opened.
  it('keeps the scrollbar gutter while scroll is locked', () => {
    start(mountPage());

    toggle().click();

    expect(document.documentElement.style.scrollbarGutter).toBe('stable');
  });

  it('restores the page scroll styles it found once closed', () => {
    document.documentElement.style.overflow = 'clip';
    start(mountPage());

    toggle().click();
    toggle().click();

    expect([
      document.documentElement.style.overflow,
      document.documentElement.style.scrollbarGutter,
    ]).toEqual(['clip', '']);
  });
});

describe('initSiteMenu fit check', () => {
  it('leaves the phone layout to the stylesheet below 768', () => {
    layout.needed = 2000;
    const header = mountPage();

    start(header);

    expect(isCompact(header)).toBe(false);
  });

  it('shows the full nav from 768 while it fits the header row', () => {
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();

    start(header);

    expect(isCompact(header)).toBe(false);
  });

  it('falls back to the menu from 768 when the full nav does not fit', () => {
    setViewportWidth(DESKTOP_WIDTH);
    layout.needed = 1001;
    const header = mountPage();

    start(header);

    expect(isCompact(header)).toBe(true);
  });

  it('falls back to the menu when the full nav runs into the end padding of the row', () => {
    setViewportWidth(DESKTOP_WIDTH);
    layout.needed = 1010;
    const header = mountPage();

    start(header);

    expect(isCompact(header)).toBe(true);
  });

  it('keeps the full nav when it ends within rounding of the row edge', () => {
    setViewportWidth(DESKTOP_WIDTH);
    layout.needed = 1000.4;
    const header = mountPage();

    start(header);

    expect(isCompact(header)).toBe(false);
  });

  it('measures the full nav even while the header is compact', () => {
    setViewportWidth(DESKTOP_WIDTH);
    layout.needed = 1001;
    const header = mountPage();
    start(header);

    layout.needed = 900;
    globalThis.dispatchEvent(new Event('resize'));

    expect(isCompact(header)).toBe(false);
  });

  it('measures again on resize', () => {
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();
    start(header);

    layout.available = 800;
    globalThis.dispatchEvent(new Event('resize'));

    expect(isCompact(header)).toBe(true);
  });

  it('measures again when the root text size class changes', async () => {
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();
    start(header);

    layout.needed = 1200;
    document.documentElement.classList.add('a11y-text-scale');
    await flushObservers();

    expect(isCompact(header)).toBe(true);
  });

  it('measures again when the root font face style changes', async () => {
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();
    start(header);

    layout.needed = 1200;
    document.documentElement.style.setProperty('--a11y-font-family', '"open-dyslexic"');
    await flushObservers();

    expect(isCompact(header)).toBe(true);
  });

  it('measures again when a font finishes loading', () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();
    start(header);

    layout.needed = 1200;
    fonts.dispatchEvent(new Event('loadingdone'));

    expect(isCompact(header)).toBe(true);
    Reflect.deleteProperty(document, 'fonts');
  });

  it('measures again on each change the shared text-metric observer reports', () => {
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();
    start(header);
    const onChange = vi.mocked(observeTextMetrics).mock.lastCall?.[0];

    layout.needed = 1200;
    onChange?.();

    expect(isCompact(header)).toBe(true);
  });

  it('keeps the panel open on a resize that still leaves the nav without room', () => {
    setViewportWidth(DESKTOP_WIDTH);
    layout.needed = 1200;
    start(mountPage());
    toggle().click();

    layout.available = 1100;
    globalThis.dispatchEvent(new Event('resize'));

    expect(panel().hidden).toBe(false);
  });

  it('keeps the panel open on a resize below 768', () => {
    start(mountPage());
    toggle().click();

    setViewportWidth(PHONE_WIDTH - 10);
    globalThis.dispatchEvent(new Event('resize'));

    expect(panel().hidden).toBe(false);
  });

  it('closes the panel when a resize gives the full nav room', () => {
    start(mountPage());
    toggle().click();

    setViewportWidth(DESKTOP_WIDTH);
    globalThis.dispatchEvent(new Event('resize'));

    expect(panel().hidden).toBe(true);
  });

  it('returns focus to the menu button when a resize closes the panel it held focus in', () => {
    start(mountPage());
    toggle().click();
    part('[data-site-menu-panel] a').focus();

    setViewportWidth(DESKTOP_WIDTH);
    globalThis.dispatchEvent(new Event('resize'));

    expect(document.activeElement).toBe(toggle());
  });

  it('leaves focus where it is when a resize closes the panel it did not hold focus in', () => {
    start(mountPage());
    toggle().click();
    part('#widget button').focus();

    setViewportWidth(DESKTOP_WIDTH);
    globalThis.dispatchEvent(new Event('resize'));

    expect(document.activeElement).toBe(part('#widget button'));
  });
});

describe('initSiteMenu header height', () => {
  it('publishes the header height for the panel and anchor offsets', () => {
    start(mountPage());

    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('65px');
  });

  it('publishes the header height again when it changes', () => {
    start(mountPage());

    layout.headerHeight = 90;
    globalThis.dispatchEvent(new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('90px');
  });
});

describe('initSiteMenu disposer', () => {
  it('stops answering the menu button', () => {
    start(mountPage());
    dispose?.();
    dispose = undefined;

    toggle().click();

    expect(panel().hidden).toBe(true);
  });

  it('stops measuring', () => {
    setViewportWidth(DESKTOP_WIDTH);
    const header = mountPage();
    start(header);
    dispose?.();
    dispose = undefined;

    layout.needed = 1200;
    globalThis.dispatchEvent(new Event('resize'));

    expect(isCompact(header)).toBe(false);
  });

  it('releases the shared text-metric observer', () => {
    const release = vi.fn();
    vi.mocked(observeTextMetrics).mockReturnValueOnce(release);
    start(mountPage());

    dispose?.();
    dispose = undefined;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('closes a panel left open', () => {
    start(mountPage());
    toggle().click();

    dispose?.();
    dispose = undefined;

    expect([panel().hidden, part('main').hasAttribute('inert')]).toEqual([true, false]);
  });
});

describe('initSiteMenu markup contract', () => {
  it('refuses a header without its menu button', () => {
    const header = mountPage();
    toggle().remove();

    expect(() => initSiteMenu(header)).toThrow(/data-site-menu-toggle/);
  });
});
