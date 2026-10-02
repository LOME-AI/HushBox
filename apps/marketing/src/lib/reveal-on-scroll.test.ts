import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { REDUCED_MOTION_CLASS } from '@hushbox/ui/accessibility';
import { initRevealOnScroll } from './reveal-on-scroll';

const VIEWPORT_HEIGHT = 800;

/** Every stand-in observer the code under test created, in order. */
const instances: StubObserver[] = [];

/** A stand-in for the browser's observer: the test decides when an element is in view. */
class StubObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.rootMargin = options?.rootMargin ?? '0px';
    this.thresholds = [options?.threshold ?? 0].flat();
    instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Reports `target` entering or leaving view, as the browser would. */
  report(target: Element, isIntersecting: boolean): void {
    if (!this.observed.has(target)) return;
    const rect = target.getBoundingClientRect();
    const entry: IntersectionObserverEntry = {
      boundingClientRect: rect,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: rect,
      isIntersecting,
      rootBounds: null,
      target,
      time: 0,
    };
    this.callback([entry], this);
  }
}

function observerOf(target: Element): StubObserver {
  const observer = instances.find((instance) => instance.observed.has(target));
  if (observer === undefined) throw new Error('nothing watches the section');
  return observer;
}

function watched(): Element[] {
  return instances.flatMap((instance) => [...instance.observed]);
}

/** Mounts one marked section whose top edge sits `top` pixels below the viewport's top. */
function mountSection(top: number): HTMLElement {
  const section = document.createElement('section');
  section.dataset['reveal'] = '';
  section.textContent = 'Transparent pricing';
  vi.spyOn(section, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 390, 600));
  document.body.append(section);
  return section;
}

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('IntersectionObserver', StubObserver);
  vi.stubGlobal('innerHeight', VIEWPORT_HEIGHT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.classList.remove(REDUCED_MOTION_CLASS);
});

describe('initRevealOnScroll', () => {
  it('hides a section that starts below the fold', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);

    initRevealOnScroll(document);

    expect(section.dataset['revealState']).toBe('hidden');
  });

  it('leaves a section in view at load untouched', () => {
    const section = mountSection(VIEWPORT_HEIGHT - 100);

    initRevealOnScroll(document);

    expect(section.dataset['revealState']).toBeUndefined();
  });

  it('leaves a section above the viewport at load untouched', () => {
    const section = mountSection(-2000);

    initRevealOnScroll(document);

    expect(section.dataset['revealState']).toBeUndefined();
  });

  it('shows a hidden section once it scrolls into view', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    initRevealOnScroll(document);

    observerOf(section).report(section, true);

    expect(section.dataset['revealState']).toBe('shown');
  });

  it('keeps a hidden section hidden while it stays out of view', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    initRevealOnScroll(document);

    observerOf(section).report(section, false);

    expect(section.dataset['revealState']).toBe('hidden');
  });

  it('stops watching a section once it is shown', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    initRevealOnScroll(document);
    observerOf(section).report(section, true);

    expect(watched()).toEqual([]);
  });

  it('never hides a shown section again', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    initRevealOnScroll(document);
    const observer = observerOf(section);
    observer.report(section, true);

    observer.report(section, false);

    expect(section.dataset['revealState']).toBe('shown');
  });

  it('fires as a section of any height rises past 90% of the viewport', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    initRevealOnScroll(document);

    const observer = observerOf(section);

    expect({ rootMargin: observer.rootMargin, thresholds: observer.thresholds }).toEqual({
      rootMargin: '0px 0px -10% 0px',
      thresholds: [0],
    });
  });

  it('watches only the sections it hid', () => {
    mountSection(VIEWPORT_HEIGHT - 100);
    const below = mountSection(VIEWPORT_HEIGHT + 200);

    initRevealOnScroll(document);

    expect(watched()).toEqual([below]);
  });

  it('leaves every section untouched under reduced motion', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    document.documentElement.classList.add(REDUCED_MOTION_CLASS);

    initRevealOnScroll(document);

    expect(section.dataset['revealState']).toBeUndefined();
  });

  it('asks the injected reduced-motion reading', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);

    initRevealOnScroll(document, { reducedMotion: () => true });

    expect(section.dataset['revealState']).toBeUndefined();
  });

  it('leaves every section untouched without IntersectionObserver', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');

    initRevealOnScroll(document);

    expect(section.dataset['revealState']).toBeUndefined();
  });

  it('shows a hidden section when the injected watcher reports it visible', () => {
    const section = mountSection(VIEWPORT_HEIGHT + 200);
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    const watchers = new Map<Element, () => void>();

    initRevealOnScroll(document, {
      observe: (el, onVisible) => {
        watchers.set(el, onVisible);
      },
    });
    watchers.get(section)?.();

    expect(section.dataset['revealState']).toBe('shown');
  });

  it('looks for marked sections only inside the root', () => {
    const outside = mountSection(VIEWPORT_HEIGHT + 200);
    const root = document.createElement('div');
    document.body.append(root);

    initRevealOnScroll(root);

    expect(outside.dataset['revealState']).toBeUndefined();
  });

  it('disconnects its watchers when disposed', () => {
    mountSection(VIEWPORT_HEIGHT + 200);
    mountSection(VIEWPORT_HEIGHT + 900);
    const dispose = initRevealOnScroll(document);

    dispose();

    expect(instances.map((observer) => observer.disconnected)).toEqual([true, true]);
  });
});

// No test here lays out CSS, so the states the script sets are asserted against the stylesheet
// that draws them.
describe('the reveal stylesheet', () => {
  const css = readFileSync(path.resolve(__dirname, '../styles/global.css'), 'utf8');

  it('hides by opacity and transform only, so the page never shifts', () => {
    expect(css).toMatch(
      /\[data-reveal-state='hidden'\] \{\s*opacity: 0;\s*transform: translateY\(2rem\);\s*\}/
    );
  });

  it('fades up with the motion tokens, easing nothing but opacity and transform', () => {
    expect(css).toMatch(
      /\[data-reveal-state='shown'\] \{\s*transition:\s*opacity var\(--motion-deliberate\) var\(--ease-out\),\s*transform var\(--motion-deliberate\) var\(--ease-out\);\s*\}/
    );
  });

  it('holds a delayed element back by the base motion step', () => {
    expect(css).toMatch(
      /\[data-reveal='delayed'\]\[data-reveal-state='shown'\] \{\s*transition-delay: var\(--motion-base\);\s*\}/
    );
  });

  it('shows a hidden element once reduced motion turns on', () => {
    expect(css).toMatch(
      /html\.reduced-motion \[data-reveal-state='hidden'\] \{\s*opacity: 1;\s*transform: none;\s*\}/
    );
  });
});
