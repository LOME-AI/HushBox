import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Textarea } from '@hushbox/ui';
import { PredictionOverlay } from '@/components/chat/input/prediction-overlay';
import { initialPredictionState, type PredictionState } from '@/lib/prediction/state';
import './prediction-overlay.css';

/**
 * Real-browser fixture for `prediction-overlay-tap.browser.test.ts`: the hint over the real
 * `Textarea` with a model chip in a bar below it, under a block that stands only while the hint
 * is offered. Accepting the hint removes that block and the chip rises under the finger that
 * tapped the hint — the new-chat page's shape, whose stack shrinks above the composer when the
 * hint is taken, so the click a tap generates is hit-tested after that re-layout.
 *
 * Test infrastructure, not shipped runtime: served to a real browser and never imported by the
 * Node test process; `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from coverage.
 */

interface TapReading {
  /** The `id` of each element a click was dispatched to, in order. */
  clickTargets: string[];
  modelSelectorOpen: boolean;
  focusedId: string;
  value: string;
}

declare global {
  // Optional: unset until this script finishes running — the property the driving test polls.
  var __predictionOverlayTap: { read(): TapReading } | undefined;
}

const TYPED = 'the quick brown fox jumps';
const COMPLETION = ' over the lazy dog.';

const OFFERED: PredictionState = {
  ...initialPredictionState,
  typedText: TYPED,
  status: {
    kind: 'ready',
    requestText: TYPED,
    prediction: { completion: COMPLETION, candidates: [COMPLETION] },
  },
};

/** The rise that brings the chip's middle to the hint's first line. */
const OFFERED_ONLY_BLOCK_STYLE = { height: '68px' };

const clickTargets: string[] = [];
// Registered before the page mounts, so it observes every click ahead of any listener the
// overlay adds, whatever that listener then does with it.
globalThis.addEventListener(
  'click',
  (event) => {
    clickTargets.push(event.target instanceof Element ? event.target.id : '');
  },
  { capture: true }
);

function NewChatStack(): React.JSX.Element {
  const [value, setValue] = useState(TYPED);
  const selector = useRef<HTMLDialogElement>(null);
  const offered = value === TYPED;
  return (
    <div className="flex flex-col gap-2 pt-48">
      {offered && <div id="offered-only-block" style={OFFERED_ONLY_BLOCK_STYLE} />}
      <div className="relative px-4">
        <Textarea
          id="prompt-input"
          readOnly
          value={value}
          rows={2}
          style={{ minHeight: '4rem' }}
          className="resize-none border-0 text-base focus-visible:ring-0"
        />
        <PredictionOverlay
          state={offered ? OFFERED : { ...initialPredictionState, typedText: value }}
          onAccept={() => {
            setValue(`${TYPED}${COMPLETION}`);
          }}
        />
      </div>
      <div className="flex justify-end px-4">
        <button
          id="model-chip"
          type="button"
          className="h-8 w-40 rounded-full border"
          onClick={() => selector.current?.showModal()}
        >
          Smart Model
        </button>
      </div>
      <dialog id="model-selector" ref={selector} aria-label="Select model">
        <button id="model-selector-close" type="button">
          Close
        </button>
      </dialog>
    </div>
  );
}

const container = document.querySelector('#root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(<NewChatStack />);

globalThis.__predictionOverlayTap = {
  read() {
    const dialog = document.querySelector('#model-selector');
    return {
      clickTargets: [...clickTargets],
      modelSelectorOpen: dialog instanceof HTMLDialogElement && dialog.open,
      focusedId: document.activeElement?.id ?? '',
      value: document.querySelector('textarea')?.value ?? '',
    };
  },
};
