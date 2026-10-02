import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Textarea, TEXTAREA_MIRROR_CLASSES } from '@hushbox/ui';
import './composer-growth.css';

/**
 * Real-browser fixture for `composer-growth.browser.test.ts`. Reproduces the
 * composer's exact `Textarea` configuration (apps/web/src/components/chat/input/prompt-input.tsx)
 * next to a hand-built reconstruction of the sizing mechanism it replaced —
 * `field-sizing-content` alone, no grid replica — so the same growth
 * measurement can be run against both and compared per engine.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint — it is
 * served to a real browser, never imported by the Node test process, so V8
 * coverage instrumentation cannot observe it executing; `apps/web/vitest.config.ts`
 * excludes `src/**\/*-fixture/**` from the coverage gate for exactly this reason.
 */

/**
 * A minimal external store bridging the driving test's imperative
 * `page.evaluate()` writes into React state without reassigning a module-level
 * variable during render (banned by `react-hooks/globals` as an impure
 * side-effect) — `useSyncExternalStore` is the sanctioned React mechanism for
 * exactly this shape of outside-write, in-render-read bridge.
 */
function createValueStore(initial: string): {
  set(value: string): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): string;
} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: string): void {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): string {
      return value;
    },
  };
}

const shippedStore = createValueStore('');
const legacyStore = createValueStore('');

// The composer's own configuration, read verbatim from prompt-input.tsx.
const COMPOSER_STYLE = { minHeight: '4rem', maxHeight: '11.5rem' };
const COMPOSER_CLASSNAME = 'resize-none overflow-y-auto border-0 text-base focus-visible:ring-0';
const COMPOSER_ROWS = 2;

function ShippedComposer(): React.JSX.Element {
  const value = useSyncExternalStore(
    (listener) => shippedStore.subscribe(listener),
    () => shippedStore.getSnapshot()
  );
  return (
    <Textarea
      id="shipped-composer"
      readOnly
      value={value}
      rows={COMPOSER_ROWS}
      style={COMPOSER_STYLE}
      className={COMPOSER_CLASSNAME}
    />
  );
}

// Pre-redesign reconstruction: a plain textarea sized by `field-sizing-content`
// alone (Tailwind's utility for the CSS `field-sizing: content` property), no
// grid wrapper and no sizing replica — the mechanism the shipped primitive
// replaced. Same rows/style/className as the composer, so the only variable
// between this and ShippedComposer is the sizing mechanism.
function LegacyComposer(): React.JSX.Element {
  const value = useSyncExternalStore(
    (listener) => legacyStore.subscribe(listener),
    () => legacyStore.getSnapshot()
  );
  return (
    <textarea
      id="legacy-composer"
      readOnly
      value={value}
      rows={COMPOSER_ROWS}
      style={COMPOSER_STYLE}
      className={`field-sizing-content min-h-16 w-full rounded-md bg-transparent outline-none ${TEXTAREA_MIRROR_CLASSES} ${COMPOSER_CLASSNAME}`}
    />
  );
}

function App(): React.JSX.Element {
  return (
    <>
      <div style={{ width: '320px', margin: '20px' }}>
        <ShippedComposer />
      </div>
      <div style={{ width: '320px', margin: '20px' }}>
        <LegacyComposer />
      </div>
    </>
  );
}

declare global {
  // Optional: unset until this script finishes running — the property the
  // driving test polls to know the fixture page has mounted.
  var __growth:
    | {
        setShipped(value: string): void;
        setLegacy(value: string): void;
        heightOf(id: string): number;
      }
    | undefined;
}

const rootElement = document.querySelector('#root');
if (rootElement === null) throw new Error('missing #root');
const root = createRoot(rootElement);
flushSync(() => {
  root.render(<App />);
});

globalThis.__growth = {
  setShipped(value: string): void {
    flushSync(() => {
      shippedStore.set(value);
    });
  },
  setLegacy(value: string): void {
    flushSync(() => {
      legacyStore.set(value);
    });
  },
  heightOf(id: string): number {
    const el = document.querySelector(`#${id}`);
    if (el === null) throw new Error(`missing element ${id}`);
    return el.clientHeight;
  },
};
