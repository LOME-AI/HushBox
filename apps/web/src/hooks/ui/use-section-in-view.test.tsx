import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { PageBody } from '@/components/shared/page-body';
import {
  SETTINGS_SECTION_IDS,
  scrollToSection,
  useSectionInView,
  type SettingsSectionId,
} from '@/hooks/ui/use-section-in-view';

class IntersectionObserverFake implements IntersectionObserver {
  static readonly instances: IntersectionObserverFake[] = [];
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[] = [0];
  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    IntersectionObserverFake.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    /* The hook never unobserves a single target; it disconnects. */
  }

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(changes: Partial<Record<SettingsSectionId, boolean>>): void {
    const entries = Object.entries(changes).map(([id, isIntersecting]) =>
      entryFor(document.querySelector(`#${id}`)!, isIntersecting)
    );
    act(() => {
      this.callback(entries, this);
    });
  }
}

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
    /* The hook never unobserves a single target; it disconnects. */
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

function latestResizeObserver(): ResizeObserverFake {
  const observer = ResizeObserverFake.instances.at(-1);
  if (!observer) throw new Error('no ResizeObserver was created');
  return observer;
}

/** Reports a size change of the pinned band to every live resize observer. */
function resizeBand(): void {
  for (const observer of ResizeObserverFake.instances) {
    if (!observer.disconnected) observer.fire();
  }
}

function entryFor(target: Element, isIntersecting: boolean): IntersectionObserverEntry {
  const rect = target.getBoundingClientRect();
  return {
    target,
    isIntersecting,
    intersectionRatio: isIntersecting ? 1 : 0,
    boundingClientRect: rect,
    intersectionRect: rect,
    rootBounds: null,
    time: 0,
  };
}

function latestObserver(): IntersectionObserverFake {
  const observer = IntersectionObserverFake.instances.at(-1);
  if (!observer) throw new Error('no IntersectionObserver was created');
  return observer;
}

function Probe(): React.JSX.Element {
  const current = useSectionInView(SETTINGS_SECTION_IDS);
  return (
    <PageBody pinned={<output aria-label="Current section">{current}</output>}>
      {SETTINGS_SECTION_IDS.map((id) => (
        <section key={id} id={id}>
          {id}
        </section>
      ))}
    </PageBody>
  );
}

function currentSection(): string | null {
  return screen.getByLabelText('Current section').textContent;
}

function scroller(): HTMLElement {
  return screen.getByTestId('page-body');
}

function pinnedBand(): HTMLElement {
  const band = screen.getByLabelText('Current section').closest<HTMLElement>('[data-page-pinned]');
  if (!band) throw new Error('the pinned band is missing');
  return band;
}

/** Places the scroller at the viewport top and `id`'s section `top` px below it. */
function placeSection(id: SettingsSectionId, top: number): void {
  vi.spyOn(scroller(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
  vi.spyOn(document.querySelector<HTMLElement>(`#${id}`)!, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, top, 800, 200)
  );
}

/** Makes the band read as pinned (sticky), `height` px tall. */
function pinBand(height: number): void {
  const band = pinnedBand();
  band.style.position = 'sticky';
  Object.defineProperty(band, 'offsetHeight', { configurable: true, value: height });
}

beforeEach(() => {
  IntersectionObserverFake.instances.length = 0;
  ResizeObserverFake.instances.length = 0;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverFake);
  vi.stubGlobal('ResizeObserver', ResizeObserverFake);
  useA11yStore.setState({ stopAnimations: false, forcedReducedMotion: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.history.replaceState(null, '', '/');
});

describe('useSectionInView', () => {
  it('starts on the first section when the URL has no hash', () => {
    render(<Probe />);
    expect(currentSection()).toBe('account');
  });

  it('selects the section a hash present on load names', () => {
    globalThis.history.replaceState(null, '', '/settings#legal');
    render(<Probe />);
    expect(currentSection()).toBe('legal');
  });

  it('ignores a hash that names no section', () => {
    globalThis.history.replaceState(null, '', '/settings#nowhere');
    render(<Probe />);
    expect(currentSection()).toBe('account');
  });

  it('observes every section inside the page scroller', () => {
    render(<Probe />);
    const observer = latestObserver();
    expect(observer.root).toBe(scroller());
    expect(observer.observed.map((element) => element.id)).toEqual([...SETTINGS_SECTION_IDS]);
  });

  it('observes against the viewport when the sections sit outside a page scroller', () => {
    function Bare(): React.JSX.Element {
      useSectionInView(SETTINGS_SECTION_IDS);
      return <section id="account">account</section>;
    }
    render(<Bare />);
    expect(latestObserver().root).toBeNull();
  });

  it('observes nothing when no section is on the page', () => {
    function Empty(): React.JSX.Element {
      useSectionInView(SETTINGS_SECTION_IDS);
      return <p>no sections</p>;
    }
    render(<Empty />);
    expect(latestObserver().observed).toEqual([]);
  });

  it('refuses an empty list of sections', () => {
    function NoIds(): React.JSX.Element {
      useSectionInView([]);
      return <p>none</p>;
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<NoIds />)).toThrow('useSectionInView needs at least one section id');
  });

  it('observes from the scroller top while the band scrolls with the page', () => {
    render(<Probe />);
    expect(latestObserver().rootMargin).toBe('-0px 0px 0px 0px');
  });

  it('moves the observed top edge down past the pinned band it measures', () => {
    render(<Probe />);
    pinBand(57);
    resizeBand();
    expect(latestObserver().rootMargin).toBe('-57px 0px 0px 0px');
  });

  it('follows the band as it grows or shrinks', () => {
    render(<Probe />);
    pinBand(57);
    resizeBand();
    pinBand(95);
    resizeBand();
    expect(latestObserver().rootMargin).toBe('-95px 0px 0px 0px');
  });

  it('drops the offset when the band stops sticking', () => {
    render(<Probe />);
    pinBand(57);
    resizeBand();
    pinnedBand().style.position = '';
    resizeBand();
    expect(latestObserver().rootMargin).toBe('-0px 0px 0px 0px');
  });

  it('watches the band of its own page scroller', () => {
    render(<Probe />);
    expect(latestResizeObserver().observed).toEqual([pinnedBand()]);
  });

  it('watches no band on a page body without one', () => {
    function Unpinned(): React.JSX.Element {
      useSectionInView(SETTINGS_SECTION_IDS);
      return (
        <PageBody>
          <section id="account">account</section>
        </PageBody>
      );
    }
    render(<Unpinned />);
    expect(ResizeObserverFake.instances).toEqual([]);
    expect(latestObserver().rootMargin).toBe('-0px 0px 0px 0px');
  });

  it('stops watching the band on unmount', () => {
    const { unmount } = render(<Probe />);
    const resizeObserver = latestResizeObserver();
    unmount();
    expect(resizeObserver.disconnected).toBe(true);
  });

  it('picks the topmost section in view below the band', () => {
    render(<Probe />);
    latestObserver().report({ account: false, security: true, preferences: true });
    expect(currentSection()).toBe('security');
  });

  it('hands over to the next section when the topmost one leaves the view', () => {
    render(<Probe />);
    const observer = latestObserver();
    observer.report({ security: true, preferences: true });
    observer.report({ security: false });
    expect(currentSection()).toBe('preferences');
  });

  it('keeps the last section while none is in view', () => {
    render(<Probe />);
    const observer = latestObserver();
    observer.report({ legal: true });
    observer.report({ legal: false });
    expect(currentSection()).toBe('legal');
  });

  it('disconnects its observer on unmount', () => {
    const { unmount } = render(<Probe />);
    const observer = latestObserver();
    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('holds a requested section while it travels into view', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('legal');
    });
    latestObserver().report({ security: true });
    expect(currentSection()).toBe('legal');
  });

  it('holds a requested section while it stays in view below a higher one', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('danger');
    });
    latestObserver().report({ notifications: true, legal: true, danger: true });
    expect(currentSection()).toBe('danger');
  });

  it('holds a requested section while it is still in view after the scroll settles', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('notifications');
    });
    latestObserver().report({ account: true, notifications: true });
    expect(currentSection()).toBe('notifications');
  });

  it.each([
    ['wheel', (): Event => new WheelEvent('wheel')],
    ['touchstart', (): Event => new Event('touchstart')],
    ['pointerdown', (): Event => new Event('pointerdown')],
    ['keydown', (): Event => new KeyboardEvent('keydown', { key: 'PageUp' })],
  ])('releases a requested section on the reader’s own %s', (_type, makeEvent) => {
    render(<Probe />);
    act(() => {
      scrollToSection('danger');
    });
    latestObserver().report({ legal: true, danger: true });
    act(() => {
      globalThis.dispatchEvent(makeEvent());
    });
    expect(currentSection()).toBe('legal');
  });

  it('keeps the current section when released with nothing in view', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('danger');
    });
    act(() => {
      globalThis.dispatchEvent(new WheelEvent('wheel'));
    });
    expect(currentSection()).toBe('danger');
  });

  it('follows the view again once a requested section is released', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('danger');
    });
    act(() => {
      globalThis.dispatchEvent(new WheelEvent('wheel'));
    });
    latestObserver().report({ security: true });
    expect(currentSection()).toBe('security');
  });

  it('scrolls the hash section to just below the band once the sections have mounted', () => {
    globalThis.history.replaceState(null, '', '/settings#notifications');
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    render(<Probe />);
    expect(scrollTo).toHaveBeenCalledWith({ top: -16, behavior: 'instant' });
  });

  it('leaves no focus on the hash section once the load has scrolled it into place', () => {
    globalThis.history.replaceState(null, '', '/settings#notifications');
    render(<Probe />);
    expect(document.activeElement).not.toBe(document.querySelector('#notifications'));
  });

  it('leaves the hash section focusable by no one once the arrival has released it', () => {
    globalThis.history.replaceState(null, '', '/settings#notifications');
    render(<Probe />);
    expect(document.querySelector('#notifications')).not.toHaveAttribute('tabindex');
  });

  it('moves focus to the hash section and releases it, so the next Tab starts there', () => {
    globalThis.history.replaceState(null, '', '/settings#notifications');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const blur = vi.spyOn(HTMLElement.prototype, 'blur');
    render(<Probe />);
    const section = document.querySelector('#notifications');
    const focusCall = focus.mock.contexts.indexOf(section as HTMLElement);
    const blurCall = blur.mock.contexts.indexOf(section as HTMLElement);
    expect(focus.mock.calls[focusCall]).toEqual([{ preventScroll: true }]);
    expect(blur.mock.invocationCallOrder[blurCall]).toBeGreaterThan(
      focus.mock.invocationCallOrder[focusCall]!
    );
  });

  it('releases nothing when the hash names a section not on the page', () => {
    globalThis.history.replaceState(null, '', '/settings#notifications');
    const blur = vi.spyOn(HTMLElement.prototype, 'blur');
    function Bare(): React.JSX.Element {
      useSectionInView(SETTINGS_SECTION_IDS);
      return <p>no sections</p>;
    }
    render(<Bare />);
    expect(blur).not.toHaveBeenCalled();
  });

  it('holds the hash section until the reader scrolls', () => {
    globalThis.history.replaceState(null, '', '/settings#notifications');
    render(<Probe />);
    const observer = latestObserver();
    observer.report({ preferences: true, notifications: true });
    expect(currentSection()).toBe('notifications');
    act(() => {
      globalThis.dispatchEvent(new WheelEvent('wheel'));
    });
    expect(currentSection()).toBe('preferences');
  });
});

describe('useSectionInView, holding the hash section while the page grows', () => {
  /** Where the Legal section sits below the scroller's top, before any scroll. */
  let legalLayoutTop = 0;

  function holdObserver(): ResizeObserverFake {
    const legal = document.querySelector('#legal');
    const observer = ResizeObserverFake.instances.find(
      (instance) => !instance.disconnected && instance.observed.includes(legal!.parentElement!)
    );
    if (!observer) throw new Error('nothing watches the page content for the held section');
    return observer;
  }

  /** The layout after content above Legal grows by `px`, and the resize it reports. */
  function growAboveLegal(px: number): void {
    legalLayoutTop += px;
    for (const observer of ResizeObserverFake.instances) {
      if (!observer.disconnected) observer.fire();
    }
  }

  beforeEach(() => {
    legalLayoutTop = 900;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ): DOMRect {
      if (this.id !== 'legal') return new DOMRect(0, 0, 800, 0);
      const page = this.closest<HTMLElement>('[data-page-scroller]');
      return new DOMRect(0, legalLayoutTop - (page?.scrollTop ?? 0), 800, 120);
    });
    globalThis.history.replaceState(null, '', '/settings#legal');
  });

  it('watches the page content once the hash section has arrived', () => {
    render(<Probe />);
    expect(holdObserver().observed).toContain(document.querySelector('#legal')!.parentElement);
  });

  it('brings the hash section back to its arrival target when the page grows above it', () => {
    render(<Probe />);
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');

    growAboveLegal(80);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 980 - 16, behavior: 'instant' });
  });

  it('keeps the hash section under the pinned band it measures when it brings it back', () => {
    render(<Probe />);
    pinBand(57);
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');

    growAboveLegal(80);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 980 - 57 - 16, behavior: 'instant' });
  });

  it('sets that scroll margin on arrival, before anything resizes', () => {
    render(<Probe />);

    expect(document.querySelector<HTMLElement>('#legal')!.style.scrollMarginTop).toBe('16px');
  });

  it("leaves the pinned band to the scroller's padding, so the section's scroll margin is the gap alone", () => {
    render(<Probe />);
    pinBand(57);

    growAboveLegal(80);

    expect(document.querySelector<HTMLElement>('#legal')!.style.scrollMarginTop).toBe('16px');
  });

  it('moves no focus when it brings the hash section back', () => {
    render(<Probe />);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');

    growAboveLegal(80);

    expect(focus).not.toHaveBeenCalled();
  });

  it.each([
    ['wheel', (): Event => new WheelEvent('wheel')],
    ['touchstart', (): Event => new Event('touchstart')],
    ['pointerdown', (): Event => new Event('pointerdown')],
    ['keydown', (): Event => new KeyboardEvent('keydown', { key: 'Tab' })],
  ])('lets the page grow freely after the reader’s own %s', (_type, makeEvent) => {
    render(<Probe />);
    const observer = holdObserver();
    act(() => {
      globalThis.dispatchEvent(makeEvent());
    });
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');

    growAboveLegal(80);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(observer.disconnected).toBe(true);
  });

  it('lets the hash section go once another section is requested', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('security');
    });
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');

    growAboveLegal(80);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each(['hashchange', 'popstate'])(
    'lets the page grow freely after a %s to a hash that names no section',
    (type) => {
      render(<Probe />);
      const observer = holdObserver();
      globalThis.history.replaceState(null, '', '/settings#nowhere');
      act(() => {
        globalThis.dispatchEvent(new Event(type));
      });
      const scrollTo = vi.spyOn(scroller(), 'scrollTo');

      growAboveLegal(80);

      expect(scrollTo).not.toHaveBeenCalled();
      expect(observer.disconnected).toBe(true);
    }
  );

  it('follows the view again after a navigation to a hash that names no section', () => {
    render(<Probe />);
    latestObserver().report({ security: true, legal: true });
    globalThis.history.replaceState(null, '', '/settings#nowhere');

    act(() => {
      globalThis.dispatchEvent(new Event('hashchange'));
    });

    expect(currentSection()).toBe('security');
  });

  it.each(['hashchange', 'popstate'])(
    'arrives at the section a %s names and marks it current',
    (type) => {
      render(<Probe />);
      const scrollTo = vi.spyOn(scroller(), 'scrollTo');
      const scrolled = scroller().scrollTop;
      globalThis.history.replaceState(null, '', '/settings#security');

      act(() => {
        globalThis.dispatchEvent(new Event(type));
      });

      expect(scrollTo).toHaveBeenCalledWith({ top: scrolled - 16, behavior: 'instant' });
      expect(currentSection()).toBe('security');
    }
  );

  it('holds the newly named section, not the first, when the page grows', () => {
    render(<Probe />);
    globalThis.history.replaceState(null, '', '/settings#security');
    act(() => {
      globalThis.dispatchEvent(new Event('hashchange'));
    });
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');
    const scrolled = scroller().scrollTop;

    growAboveLegal(80);

    expect(scrollTo).not.toHaveBeenCalledWith({ top: 980 - 16, behavior: 'instant' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: scrolled - 16, behavior: 'instant' });
  });

  it('leaves the newly named section unfocused and unfocusable', () => {
    render(<Probe />);
    globalThis.history.replaceState(null, '', '/settings#security');

    act(() => {
      globalThis.dispatchEvent(new Event('hashchange'));
    });

    const security = document.querySelector('#security');
    expect(document.activeElement).not.toBe(security);
    expect(security).not.toHaveAttribute('tabindex');
  });

  it('stops listening for navigation on unmount', () => {
    const { unmount } = render(<Probe />);
    unmount();
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    globalThis.history.replaceState(null, '', '/settings#security');

    globalThis.dispatchEvent(new Event('hashchange'));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('stops watching the page content on unmount', () => {
    const { unmount } = render(<Probe />);
    const observer = holdObserver();

    unmount();

    expect(observer.disconnected).toBe(true);
  });
});

describe('scrollToSection', () => {
  it('scrolls the section to the pinned band plus a gap, smoothly', () => {
    render(<Probe />);
    pinBand(60);
    placeSection('security', 500);
    scroller().scrollTop = 100;
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');
    act(() => {
      scrollToSection('security');
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 100 + 500 - 60 - 16, behavior: 'smooth' });
  });

  it('ignores the band when it scrolls away with the page', () => {
    render(<Probe />);
    Object.defineProperty(pinnedBand(), 'offsetHeight', { configurable: true, value: 60 });
    placeSection('security', 500);
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');
    act(() => {
      scrollToSection('security');
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 16, behavior: 'smooth' });
  });

  it('jumps instantly under reduced motion', () => {
    useA11yStore.setState({ stopAnimations: true });
    render(<Probe />);
    placeSection('legal', 300);
    const scrollTo = vi.spyOn(scroller(), 'scrollTo');
    act(() => {
      scrollToSection('legal');
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 300 - 16, behavior: 'instant' });
  });

  it('moves focus to the section it brings into place', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('legal');
    });
    expect(document.activeElement).toBe(document.querySelector('#legal'));
  });

  it('makes the section focusable by script only', () => {
    render(<Probe />);
    act(() => {
      scrollToSection('legal');
    });
    expect(document.querySelector('#legal')).toHaveAttribute('tabindex', '-1');
  });

  it('focuses the section without a jump of its own', () => {
    render(<Probe />);
    const focus = vi.spyOn(document.querySelector<HTMLElement>('#legal')!, 'focus');
    act(() => {
      scrollToSection('legal');
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does nothing when no such section is on the page', () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    scrollToSection('security');
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
