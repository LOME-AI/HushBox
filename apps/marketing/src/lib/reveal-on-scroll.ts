import { REDUCED_MOTION_CLASS } from '@hushbox/ui/accessibility';

interface RevealDeps {
  reducedMotion?: () => boolean;
  observe?: (el: Element, onVisible: () => void) => void;
}

// Fires once the element's top edge rises past 90% of the viewport's height. A ratio threshold
// would never fire on a section taller than the viewport divided by that ratio, which the
// accessibility widget's largest text produces at phone widths.
const OBSERVER_OPTIONS: IntersectionObserverInit = { rootMargin: '0px 0px -10% 0px' };

function isReducedMotion(): boolean {
  return document.documentElement.classList.contains(REDUCED_MOTION_CLASS);
}

/**
 * Fades up each `[data-reveal]` element under `root` the first time it scrolls into view.
 * Only an element that starts below the fold is ever hidden, and only here, so a page without
 * script, under reduced motion or without IntersectionObserver shows everything at once; the
 * stylesheet draws the `data-reveal-state` this sets. Returns a disposer that stops watching.
 */
export function initRevealOnScroll(root: ParentNode, deps: RevealDeps = {}): () => void {
  const observers: IntersectionObserver[] = [];
  const dispose = (): void => {
    for (const observer of observers) observer.disconnect();
  };

  const observeOnce = (element: Element, onVisible: () => void): void => {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onVisible();
    }, OBSERVER_OPTIONS);
    observer.observe(element);
    observers.push(observer);
  };

  const reducedMotion = deps.reducedMotion ?? isReducedMotion;
  const observe =
    deps.observe ?? (typeof IntersectionObserver === 'function' ? observeOnce : undefined);
  if (observe === undefined || reducedMotion()) return dispose;

  for (const element of root.querySelectorAll<HTMLElement>('[data-reveal]')) {
    if (element.getBoundingClientRect().top < globalThis.innerHeight) continue;
    element.dataset['revealState'] = 'hidden';
    observe(element, () => {
      element.dataset['revealState'] = 'shown';
    });
  }
  return dispose;
}
