import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Textarea } from '@hushbox/ui';
import { PredictionOverlay } from '@/components/chat/input/prediction-overlay';
import { initialPredictionState, type PredictionState } from '@/lib/prediction/state';
import './prediction-overlay.css';

/**
 * Real-browser fixture for `prediction-overlay.browser.test.ts`. Mounts the real
 * `PredictionOverlay` over the real `Textarea` in the composer's own configuration and
 * reads back the properties that decide where each layer breaks its lines.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint: it is served to a
 * real browser and never imported by the Node test process, so V8 coverage cannot observe
 * it executing; `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from the
 * coverage gate for that reason.
 */

interface WrapReading {
  overflowWrap: string;
  wordBreak: string;
  whiteSpace: string;
}

declare global {
  // Optional: unset until this script finishes running — the property the driving test
  // polls to know the fixture page has mounted.
  var __predictionOverlay:
    | {
        read(): { textarea: WrapReading; overlay: WrapReading };
      }
    | undefined;
}

// A typed prefix holding an unbroken string longer than any composer line, and a completion.
const TYPED =
  'Summarize https://example.com/research/2026/a-very-long-unbroken-path-segment-for-wrap';
const COMPLETION = ' in three bullet points for a newsletter';

const STATE: PredictionState = {
  ...initialPredictionState,
  typedText: TYPED,
  status: {
    kind: 'ready',
    requestText: TYPED,
    prediction: { completion: COMPLETION, candidates: [COMPLETION] },
  },
};

// The composer's own configuration, read from prompt-input.tsx.
const COMPOSER_STYLE = { minHeight: '4rem', maxHeight: '11.5rem' };
const COMPOSER_CLASSNAME = 'resize-none overflow-y-auto border-0 text-base focus-visible:ring-0';
const COMPOSER_ROWS = 2;

function Composer(): React.JSX.Element {
  return (
    <div className="px-4">
      <div className="relative">
        <Textarea
          id="prompt-input"
          readOnly
          value={TYPED}
          sizingValue={`${TYPED}${COMPLETION}`}
          rows={COMPOSER_ROWS}
          style={COMPOSER_STYLE}
          className={COMPOSER_CLASSNAME}
        />
        <PredictionOverlay state={STATE} onAccept={() => undefined} />
      </div>
    </div>
  );
}

function wrapOf(selector: string): WrapReading {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`missing element ${selector}`);
  const style = getComputedStyle(element);
  return {
    overflowWrap: style.overflowWrap,
    wordBreak: style.wordBreak,
    whiteSpace: style.whiteSpace,
  };
}

const rootElement = document.querySelector('#root');
if (rootElement === null) throw new Error('missing #root');
const root = createRoot(rootElement);
flushSync(() => {
  root.render(<Composer />);
});

globalThis.__predictionOverlay = {
  read() {
    return {
      textarea: wrapOf('#prompt-input'),
      overlay: wrapOf('[data-slot="prediction-overlay"]'),
    };
  },
};
