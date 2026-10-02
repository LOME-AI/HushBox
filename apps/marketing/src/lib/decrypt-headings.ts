import { REDUCED_MOTION_CLASS } from '@hushbox/ui/accessibility';
import { runAnimationFrameLoop } from '@hushbox/ui/animation-frame';
import { randomCipherChar } from '@hushbox/ui/cipher-wall/engine';

interface DecryptDeps {
  reducedMotion?: () => boolean;
  randomChar?: () => string;
  durationMs?: number;
}

interface MarkedHeading {
  element: HTMLElement;
  /** What the observer watches: an inline marker's box is one line box, this spans them all. */
  wordsBox: HTMLElement;
  words: string;
  glyphLayer: HTMLElement;
  stop: () => void;
}

const DURATION_MS = 650;
const OBSERVER_OPTIONS: IntersectionObserverInit = { threshold: 0.6 };

// The words box shrinks to the words, capped at the heading's width so a word the accessibility
// widget's largest text cannot fit still breaks inside it rather than widening the page.
const WORDS_BOX_CLASS = 'relative inline-block max-w-full';
// Mono glyphs run wider than the words; they wrap inside the words' box and are clipped to it.
const GLYPH_LAYER_CLASS = 'absolute inset-0 overflow-hidden break-all';
const GLYPH_CLASS = 'font-mono font-normal tracking-[0.02em] text-muted-foreground';

function noop(): void {
  /* Nothing was started, so there is nothing to stop. */
}

function isReducedMotion(): boolean {
  return document.documentElement.classList.contains(REDUCED_MOTION_CLASS);
}

function span(className: string, text = ''): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/** Draws the first `resolved` characters as words and the rest as fresh glyphs; spaces stay. */
function drawGlyphs(heading: MarkedHeading, resolved: number, randomChar: () => string): void {
  const rest = heading.words.slice(resolved).replaceAll(/[^ ]/gu, () => randomChar());
  heading.glyphLayer.replaceChildren(heading.words.slice(0, resolved), span(GLYPH_CLASS, rest));
}

/**
 * Each `[data-decrypt]` element under `root` waits as cipher-wall glyphs, drawn over an
 * invisible copy of its words so its box never changes size, and resolves into its words left
 * to right the first time 60% of it is in view. A visually hidden copy keeps the words as the
 * heading's accessible name throughout. Without script, without IntersectionObserver or under
 * reduced motion the markup's words stand untouched, and reduced motion turning on later shows
 * every heading's words at once. Returns a disposer that stops everything and shows the words.
 */
export function initDecryptHeadings(root: ParentNode, deps: DecryptDeps = {}): () => void {
  const reducedMotion = deps.reducedMotion ?? isReducedMotion;
  const randomChar = deps.randomChar ?? randomCipherChar;
  const durationMs = deps.durationMs ?? DURATION_MS;
  if (typeof IntersectionObserver !== 'function' || reducedMotion()) return noop;

  const waiting = new Map<Element, MarkedHeading>();
  const resolving = new Set<MarkedHeading>();

  const showWords = (heading: MarkedHeading): void => {
    heading.stop();
    heading.element.textContent = heading.words;
    heading.element.dataset['decryptState'] = 'done';
    waiting.delete(heading.wordsBox);
    resolving.delete(heading);
  };

  const resolve = (heading: MarkedHeading): void => {
    waiting.delete(heading.wordsBox);
    resolving.add(heading);
    heading.element.dataset['decryptState'] = 'resolving';
    let start: number | undefined;
    heading.stop = runAnimationFrameLoop((now) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / durationMs);
      const resolved = Math.floor(progress * heading.words.length);
      if (resolved === heading.words.length) {
        showWords(heading);
        return false;
      }
      drawGlyphs(heading, resolved, randomChar);
      return true;
    });
  };

  const inView = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const heading = waiting.get(entry.target);
      if (!entry.isIntersecting || heading === undefined) continue;
      inView.unobserve(entry.target);
      resolve(heading);
    }
  }, OBSERVER_OPTIONS);

  const dispose = (): void => {
    inView.disconnect();
    motionWatch.disconnect();
    for (const heading of [...waiting.values(), ...resolving]) showWords(heading);
  };

  const motionWatch = new MutationObserver(() => {
    if (reducedMotion()) dispose();
  });
  motionWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  for (const element of root.querySelectorAll<HTMLElement>('[data-decrypt]')) {
    if (element.dataset['decryptState'] !== undefined) continue;
    const words = element.textContent;
    const glyphLayer = span(GLYPH_LAYER_CLASS);
    const wordsBox = span(WORDS_BOX_CLASS);
    wordsBox.setAttribute('aria-hidden', 'true');
    wordsBox.append(span('invisible', words), glyphLayer);
    element.replaceChildren(span('sr-only', words), wordsBox);
    element.dataset['decryptState'] = 'waiting';

    const heading: MarkedHeading = { element, wordsBox, words, glyphLayer, stop: noop };
    drawGlyphs(heading, 0, randomChar);
    waiting.set(wordsBox, heading);
    inView.observe(wordsBox);
  }
  return dispose;
}
