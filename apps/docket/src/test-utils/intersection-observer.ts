import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * happy-dom ships an `IntersectionObserver` whose `observe` is an empty method
 * and whose callback is never called, so a test that merely renders proves the
 * console constructed one and nothing else. This stands in for it so a test can
 * say what the reader can see and watch the console answer.
 *
 * It reports what it is told, not what is on screen: happy-dom lays nothing
 * out, so no test built on this measures visibility. What it measures is the
 * console's response to being told.
 */
export interface IntersectionStub {
  /** Everything every live observer is watching, in the order it was observed. */
  readonly watching: () => readonly Element[];
  /**
   * What each live observer was built with. The box an observer measures
   * against is its whole meaning — a margin on the wrong box is silently no
   * margin at all — and it is the one part of this that a test dom can check.
   */
  readonly built: () => readonly IntersectionObserverInit[];
  /** Reports these as on screen and everything else watched as off it. */
  readonly show: (onScreen: readonly Element[]) => void;
  readonly restore: () => void;
}

interface Live {
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit;
  readonly targets: Set<Element>;
}

export function stubIntersectionObserver(): IntersectionStub {
  const live = new Set<Live>();
  const original = globalThis.IntersectionObserver;

  class Stub {
    readonly #own: Live;

    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.#own = { callback, options, targets: new Set() };
      live.add(this.#own);
    }

    observe(target: Element): void {
      this.#own.targets.add(target);
    }

    unobserve(target: Element): void {
      this.#own.targets.delete(target);
    }

    disconnect(): void {
      this.#own.targets.clear();
      live.delete(this.#own);
    }

    takeRecords(): readonly IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal('IntersectionObserver', Stub);

  return {
    watching: () => [...live].flatMap((observer) => [...observer.targets]),
    built: () => [...live].map((observer) => observer.options),
    show: (onScreen) => {
      act(() => {
        for (const observer of live) {
          const entries = [...observer.targets].map((target) => ({
            target,
            isIntersecting: onScreen.includes(target),
          }));
          if (entries.length > 0) {
            observer.callback(
              entries as unknown as IntersectionObserverEntry[],
              undefined as unknown as IntersectionObserver
            );
          }
        }
      });
    },
    restore: () => {
      live.clear();
      vi.stubGlobal('IntersectionObserver', original);
    },
  };
}
