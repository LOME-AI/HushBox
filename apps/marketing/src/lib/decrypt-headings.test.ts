import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { REDUCED_MOTION_CLASS } from '@hushbox/ui/accessibility';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { CIPHER_CHARS } from '@hushbox/ui/cipher-wall/engine';
import { initDecryptHeadings } from './decrypt-headings';

const WORDS = 'Zero Data Retention';

/** Every stand-in observer the code under test created, in order. */
const instances: StubObserver[] = [];

/** A stand-in for the browser's observer: the test decides when an element is in view. */
class StubObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
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

  /** Reports `target` in view, as the browser would; a stale report reaches the callback too. */
  report(target: Element): void {
    const rect = target.getBoundingClientRect();
    const entry: IntersectionObserverEntry = {
      boundingClientRect: rect,
      intersectionRatio: 1,
      intersectionRect: rect,
      isIntersecting: true,
      rootBounds: null,
      target,
      time: 0,
    };
    this.callback([entry], this);
  }
}

let frames: FrameRequestCallback[];

/** Runs the next queued animation frame at `timestamp`. */
function runFrame(timestamp: number): void {
  frames.shift()?.(timestamp);
}

/** Mounts one heading whose words carry the reveal marker, as the word block renders it. */
function mountHeading(words = WORDS): HTMLElement {
  const heading = document.createElement('h3');
  const marked = document.createElement('span');
  marked.dataset['decrypt'] = '';
  marked.textContent = words;
  heading.append(marked);
  document.body.append(heading);
  return marked;
}

/** The box the words occupy on every line; the inline marker spans only a line box. */
function wordsBoxOf(marked: HTMLElement): HTMLElement {
  const box = marked.querySelector<HTMLElement>('[aria-hidden="true"]');
  if (box === null) throw new Error('no words box');
  return box;
}

function observer(): StubObserver {
  const [only] = instances;
  if (only === undefined) throw new Error('nothing watches the headings');
  return only;
}

/** The words a screen reader reads from the marked element. */
function spokenWords(marked: HTMLElement): string {
  return [...marked.childNodes]
    .filter((node) => !(node instanceof HTMLElement && node.getAttribute('aria-hidden') === 'true'))
    .map((node) => node.textContent)
    .join('');
}

function glyphLayer(marked: HTMLElement): HTMLElement {
  const layer = marked.querySelector<HTMLElement>('[aria-hidden="true"] > .absolute');
  if (layer === null) throw new Error('no glyph layer');
  return layer;
}

/** The glyphs still standing in for words, without the words already resolved. */
function glyphsOf(marked: HTMLElement): string {
  return glyphLayer(marked).querySelector('.font-mono')?.textContent ?? '';
}

/** Lets a class change on `<html>` reach the mutation observer. */
async function flushMutations(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  instances.length = 0;
  frames = [];
  useA11yStore.getState().reset();
  vi.stubGlobal('IntersectionObserver', StubObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => {
    frames = [];
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.classList.remove(REDUCED_MOTION_CLASS);
  useA11yStore.getState().reset();
});

describe('initDecryptHeadings', () => {
  describe('before a heading is seen', () => {
    it('draws its glyphs from the cipher wall set', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      const glyphs = glyphsOf(marked).match(/[^ ]/gu) ?? [];
      expect(glyphs.every((glyph) => CIPHER_CHARS.includes(glyph))).toBe(true);
    });

    it('draws one glyph for each character, keeping the spaces between words', () => {
      const marked = mountHeading();

      initDecryptHeadings(document, { randomChar: () => '#' });

      expect(glyphsOf(marked)).toBe('#### #### #########');
    });

    it('sets the glyphs in mono and muted', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      expect(glyphLayer(marked).querySelector('span')?.className).toBe(
        'font-mono font-normal tracking-[0.02em] text-muted-foreground'
      );
    });

    it('keeps an invisible copy of the words to hold the heading at its size', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      const sizeCopy = marked.querySelector('[aria-hidden="true"] > .invisible');
      expect(sizeCopy?.textContent).toBe(WORDS);
    });

    it('lays the glyphs over the size copy and clips them to its box', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      expect(glyphLayer(marked).className).toBe('absolute inset-0 overflow-hidden break-all');
    });

    it('draws the words box no wider than the heading', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      expect(marked.querySelector('[aria-hidden="true"]')?.className).toBe(
        'relative inline-block max-w-full'
      );
    });

    it('keeps the words for assistive technology', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      expect(spokenWords(marked)).toBe(WORDS);
    });

    it('reads the words from a visually hidden copy', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      expect(marked.querySelector('.sr-only')?.textContent).toBe(WORDS);
    });

    it('waits until 60% of the heading is in view', () => {
      mountHeading();

      initDecryptHeadings(document);

      expect(observer().thresholds).toEqual([0.6]);
    });

    it('watches the words box, which covers every line the heading wraps to', () => {
      const marked = mountHeading();

      initDecryptHeadings(document);

      expect([...observer().observed]).toEqual([wordsBoxOf(marked)]);
    });

    it('requests no frame', () => {
      mountHeading();

      initDecryptHeadings(document);

      expect(frames).toEqual([]);
    });
  });

  describe('once a heading is seen', () => {
    it('resolves the words from the left as time passes', () => {
      const marked = mountHeading('Anonymous');
      initDecryptHeadings(document, { randomChar: () => '#', durationMs: 900 });

      observer().report(wordsBoxOf(marked));
      runFrame(1000);
      runFrame(1300);

      expect(glyphLayer(marked).textContent).toBe('Ano######');
    });

    it('holds the heading as plain words once the time is up', () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      observer().report(wordsBoxOf(marked));
      runFrame(1000);
      runFrame(1650);

      expect(marked.innerHTML).toBe(WORDS);
    });

    it('still shows glyphs just before the default 650ms are up', () => {
      const marked = mountHeading();
      initDecryptHeadings(document, { randomChar: () => '#' });

      observer().report(wordsBoxOf(marked));
      runFrame(1000);
      runFrame(1649);

      expect(glyphsOf(marked)).toBe('#');
    });

    it('requests no frame after the words hold', () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      observer().report(wordsBoxOf(marked));
      runFrame(1000);
      runFrame(1650);

      expect(frames).toEqual([]);
    });

    it('keeps the words for assistive technology while they resolve', () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      observer().report(wordsBoxOf(marked));
      runFrame(1000);
      runFrame(1300);

      expect(spokenWords(marked)).toBe(WORDS);
    });

    it('stops watching the heading', () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      observer().report(wordsBoxOf(marked));

      expect(observer().observed.size).toBe(0);
    });

    it('runs once, however often it is reported', () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      observer().report(wordsBoxOf(marked));
      observer().report(wordsBoxOf(marked));

      expect(frames).toHaveLength(1);
    });

    it('never runs again after the words hold', () => {
      const marked = mountHeading();
      initDecryptHeadings(document);
      const box = wordsBoxOf(marked);
      observer().report(box);
      runFrame(1000);
      runFrame(1650);

      observer().report(box);

      expect({ frames: frames.length, html: marked.innerHTML }).toEqual({ frames: 0, html: WORDS });
    });

    it('resolves only the heading that was seen', () => {
      const seen = mountHeading();
      const unseen = mountHeading('Anonymous');
      initDecryptHeadings(document);

      observer().report(wordsBoxOf(seen));
      runFrame(1000);
      runFrame(1650);

      expect(unseen.innerHTML).not.toBe('Anonymous');
    });
  });

  describe('where the words show at once', () => {
    it('leaves the heading as words under reduced motion', () => {
      const marked = mountHeading();
      document.documentElement.classList.add(REDUCED_MOTION_CLASS);

      initDecryptHeadings(document);

      expect(marked.innerHTML).toBe(WORDS);
    });

    it('asks the injected reduced-motion reading', () => {
      const marked = mountHeading();

      initDecryptHeadings(document, { reducedMotion: () => true });

      expect(marked.innerHTML).toBe(WORDS);
    });

    it('leaves the heading as words without IntersectionObserver', () => {
      const marked = mountHeading();
      Reflect.deleteProperty(globalThis, 'IntersectionObserver');

      initDecryptHeadings(document);

      expect(marked.innerHTML).toBe(WORDS);
    });

    it('shows a waiting heading as words when reduced motion turns on', async () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      document.documentElement.classList.add(REDUCED_MOTION_CLASS);
      await flushMutations();

      expect(marked.innerHTML).toBe(WORDS);
    });

    it('shows a resolving heading as words when reduced motion turns on', async () => {
      const marked = mountHeading();
      initDecryptHeadings(document);
      observer().report(wordsBoxOf(marked));
      runFrame(1000);

      document.documentElement.classList.add(REDUCED_MOTION_CLASS);
      await flushMutations();

      expect({ frames: frames.length, html: marked.innerHTML }).toEqual({ frames: 0, html: WORDS });
    });

    it('keeps waiting when another class on the page changes', async () => {
      const marked = mountHeading();
      initDecryptHeadings(document);

      document.documentElement.classList.add('dark');
      await flushMutations();
      document.documentElement.classList.remove('dark');

      expect(marked.innerHTML).not.toBe(WORDS);
    });
  });

  it('looks for marked headings only inside the root', () => {
    const outside = mountHeading();
    const root = document.createElement('div');
    document.body.append(root);

    initDecryptHeadings(root);

    expect(outside.innerHTML).toBe(WORDS);
  });

  it('prepares a heading once when started twice', () => {
    const marked = mountHeading();
    initDecryptHeadings(document);

    initDecryptHeadings(document);

    expect(spokenWords(marked)).toBe(WORDS);
  });

  describe('the disposer', () => {
    it('stops watching', () => {
      mountHeading();
      const dispose = initDecryptHeadings(document);

      dispose();

      expect(observer().disconnected).toBe(true);
    });

    it('shows a waiting heading as words', () => {
      const marked = mountHeading();
      const dispose = initDecryptHeadings(document);

      dispose();

      expect(marked.innerHTML).toBe(WORDS);
    });

    it('stops a resolving heading and shows its words', () => {
      const marked = mountHeading();
      const dispose = initDecryptHeadings(document);
      observer().report(wordsBoxOf(marked));
      runFrame(1000);

      dispose();

      expect({ frames: frames.length, html: marked.innerHTML }).toEqual({ frames: 0, html: WORDS });
    });

    it('stops watching for reduced motion', async () => {
      const marked = mountHeading();
      const dispose = initDecryptHeadings(document);
      dispose();
      marked.textContent = 'Replaced';

      document.documentElement.classList.add(REDUCED_MOTION_CLASS);
      await flushMutations();

      expect(marked.innerHTML).toBe('Replaced');
    });

    it('is harmless where nothing was started', () => {
      const marked = mountHeading();
      const dispose = initDecryptHeadings(document, { reducedMotion: () => true });

      dispose();

      expect(marked.innerHTML).toBe(WORDS);
    });
  });
});
