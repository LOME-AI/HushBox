// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, renderHook } from '@testing-library/react';
import * as React from 'react';
import {
  usePromptPrediction,
  useActiveSuggestionIndex,
  PREDICTION_DEBOUNCE_MS,
} from '@/components/chat/input/use-prompt-prediction';
import { PredictionOverlay } from '@/components/chat/input/prediction-overlay';
import type { Prediction, PromptPredictor } from '@/lib/prediction/predictor';
import type { SuppressionReason } from '@/lib/prediction/suppression';

const TYPED = 'the quick brown fox';
const RAW_COMPLETION = ' jumps over the lazy';
const SHAPED_COMPLETION = ' jumps over the';
const RAW_ALTERNATIVE = ' leaps over the tall';
const SHAPED_ALTERNATIVE = ' leaps over the';
const RAW_ALTERNATIVE_2 = ' strolls across the open meadow';
const SHAPED_ALTERNATIVE_2 = ' strolls across the open';

/**
 * jsdom implements no `ResizeObserver`, so the test supplies one and decides
 * when it fires.
 */
class ResizeObserverStub {
  static readonly instances: ResizeObserverStub[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  /** Every live observer reports a geometry change. */
  static resizeAll(): void {
    for (const instance of ResizeObserverStub.instances) {
      if (instance.disconnected) continue;
      instance.callback([], instance as unknown as ResizeObserver);
    }
  }
}

interface RecordedCall {
  readonly text: string;
  readonly signal: AbortSignal;
  /** The raw callback the hook passed in — fires the completion phase directly. */
  readonly onCompletion: (completion: string) => void;
  /** Fires `onCompletion` with the prediction's completion, then resolves. */
  resolve: (prediction: Prediction) => void;
  reject: (reason: Error) => void;
}

/** A predictor whose every call is held open so the test decides when it answers. */
function createDeferredPredictor(): { predictor: PromptPredictor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const predictor: PromptPredictor = {
    predict(text, signal, onCompletion) {
      return new Promise<Prediction>((resolve, reject) => {
        calls.push({
          text,
          signal,
          onCompletion,
          resolve: (prediction) => {
            onCompletion(prediction.completion);
            resolve(prediction);
          },
          reject,
        });
      });
    },
  };
  return { predictor, calls };
}

function answer(): Prediction {
  return { completion: RAW_COMPLETION, alternatives: [RAW_ALTERNATIVE] };
}

function twoAlternativeAnswer(): Prediction {
  return { completion: RAW_COMPLETION, alternatives: [RAW_ALTERNATIVE, RAW_ALTERNATIVE_2] };
}

interface ReadyAwarePredictor {
  readonly predictor: PromptPredictor;
  readonly calls: RecordedCall[];
  /** Notifies every listener currently subscribed via `onReady`. */
  readonly fireReady: () => void;
}

/** A deferred predictor whose `onReady` notification the test fires directly. */
function createReadyAwarePredictor(): ReadyAwarePredictor {
  const calls: RecordedCall[] = [];
  const listeners = new Set<() => void>();
  const predictor: PromptPredictor = {
    predict(text, signal, onCompletion) {
      return new Promise<Prediction>((resolve, reject) => {
        calls.push({
          text,
          signal,
          onCompletion,
          resolve: (prediction) => {
            onCompletion(prediction.completion);
            resolve(prediction);
          },
          reject,
        });
      });
    },
    onReady: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    predictor,
    calls,
    fireReady: () => {
      for (const listener of listeners) listener();
    },
  };
}

function Harness({
  predictor,
  onCandidatesChange,
  disabled = false,
}: Readonly<{
  predictor: PromptPredictor | undefined;
  onCandidatesChange?: (candidates: readonly string[]) => void;
  disabled?: boolean;
}>): React.JSX.Element {
  const [value, setValue] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const prediction = usePromptPrediction({
    predictor,
    value,
    disabled,
    textareaRef,
    onCandidatesChange,
  });
  const take = (): void => {
    const accepted = prediction.accept();
    if (accepted !== null) setValue(accepted);
  };
  return (
    <div>
      <textarea
        ref={textareaRef}
        aria-label="composer"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        {...prediction.composerHandlers}
      />
      <PredictionOverlay state={prediction.state} onAccept={take} />
      {/* Reaches `accept` without going through the overlay, which is the only
          way to ask what acceptance does when nothing is rendered to click. */}
      <button type="button" onClick={take}>
        take the prediction
      </button>
    </div>
  );
}

/** What a key handler could see about visibility at the moment it must decide. */
interface Decision {
  readonly returned: SuppressionReason | null;
  readonly fromState: SuppressionReason | null;
}

/** A composer whose key handler decides on the spot, the way a gesture must. */
function GestureHarness({
  predictor,
  onDecision,
}: Readonly<{
  predictor: PromptPredictor;
  onDecision: (decision: Decision) => void;
}>): React.JSX.Element {
  const [value, setValue] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const prediction = usePromptPrediction({
    predictor,
    value,
    disabled: false,
    textareaRef,
    onCandidatesChange: undefined,
  });
  return (
    <textarea
      ref={textareaRef}
      aria-label="composer"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={() => {
        onDecision({
          returned: prediction.syncSuppression(),
          fromState: prediction.state.suppression,
        });
      }}
      {...prediction.composerHandlers}
    />
  );
}

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText('composer');
}

function type(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
}

function visibleText(): string | null {
  return document.querySelector('[data-slot="prediction-text"]')?.textContent ?? null;
}

function settleDebounce(): void {
  act(() => {
    vi.advanceTimersByTime(PREDICTION_DEBOUNCE_MS);
  });
}

async function flush(work: () => void): Promise<void> {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

describe('usePromptPrediction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ResizeObserverStub.instances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sits at a perceptible pause rather than firing on every keystroke', () => {
    expect(PREDICTION_DEBOUNCE_MS).toBeGreaterThanOrEqual(150);
    expect(PREDICTION_DEBOUNCE_MS).toBeLessThanOrEqual(250);
  });

  describe('without a predictor', () => {
    it('never predicts, and offers the composer no extra handlers', () => {
      const { predictor, calls } = createDeferredPredictor();
      const { result } = renderHook(() =>
        usePromptPrediction({
          predictor: undefined,
          value: TYPED,
          disabled: false,
          textareaRef: { current: null },
          onCandidatesChange: undefined,
        })
      );
      settleDebounce();
      expect(calls).toHaveLength(0);
      expect(result.current.composerHandlers).toBeUndefined();
      expect(result.current.state.typedText).toBe('');
      expect(result.current.accept()).toBeNull();
      expect(predictor).toBeDefined();
    });

    it('renders no prediction however long the user types and waits', () => {
      render(<Harness predictor={undefined} />);
      type(TYPED);
      settleDebounce();
      expect(visibleText()).toBeNull();
    });
  });

  describe('with a predictor', () => {
    it('waits out the debounce before asking for a prediction', () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      act(() => {
        vi.advanceTimersByTime(PREDICTION_DEBOUNCE_MS - 1);
      });
      expect(calls).toHaveLength(0);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toBe(TYPED);
    });

    it('renders the shaped completion once the answer arrives', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);
    });

    it('renders nothing when the predictor rejects', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.reject(new Error('no model'));
      });
      expect(visibleText()).toBeNull();
    });

    it('aborts an outstanding call once the typed text moves on', () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      expect(calls[0]?.signal.aborted).toBe(false);
      type(`${TYPED} and`);
      expect(calls[0]?.signal.aborted).toBe(true);
    });

    it('assigns the whole composer value on acceptance, never an insertion', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      fireEvent.pointerDown(document.querySelector('[data-slot="prediction-text"]')!);
      expect(composer().value).toBe(`${TYPED}${SHAPED_COMPLETION}`);
      expect(visibleText()).toBeNull();
    });

    it('offers nothing to accept once the composer is disabled', async () => {
      const { predictor, calls } = createDeferredPredictor();
      const { rerender } = render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      rerender(<Harness predictor={predictor} disabled />);
      fireEvent.click(screen.getByRole('button', { name: 'take the prediction' }));
      expect(composer().value).toBe(TYPED);
    });

    it('asks the predictor for nothing while the composer is disabled', () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} disabled />);
      type(TYPED);
      settleDebounce();
      expect(calls).toHaveLength(0);
    });

    it('reports the candidate set as it appears and empties it when the text moves on', async () => {
      const { predictor, calls } = createDeferredPredictor();
      const onCandidatesChange = vi.fn<(candidates: readonly string[]) => void>();
      render(<Harness predictor={predictor} onCandidatesChange={onCandidatesChange} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(onCandidatesChange).toHaveBeenLastCalledWith([SHAPED_ALTERNATIVE]);
      type(`${TYPED} and`);
      expect(onCandidatesChange).toHaveBeenLastCalledWith([]);
    });

    it('renders the inline completion the moment it lands, before the alternatives finish', async () => {
      const { predictor, calls } = createDeferredPredictor();
      const onCandidatesChange = vi.fn<(candidates: readonly string[]) => void>();
      render(<Harness predictor={predictor} onCandidatesChange={onCandidatesChange} />);
      type(TYPED);
      settleDebounce();

      await flush(() => {
        calls[0]?.onCompletion(RAW_COMPLETION);
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);
      expect(onCandidatesChange).toHaveBeenLastCalledWith([]);

      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);
      expect(onCandidatesChange).toHaveBeenLastCalledWith([SHAPED_ALTERNATIVE]);
    });

    it('withholds the prediction while an input method is composing', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      fireEvent.compositionStart(composer());
      expect(visibleText()).toBeNull();
      fireEvent.compositionEnd(composer());
      expect(visibleText()).toBe(SHAPED_COMPLETION);
    });

    it('withholds the prediction once the caret leaves the end of the value', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);
      act(() => {
        composer().setSelectionRange(2, 2);
      });
      fireEvent.select(composer());
      expect(visibleText()).toBeNull();
    });

    it('withholds the prediction once the composer scrolls its own content', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);
      Object.defineProperty(composer(), 'scrollHeight', { value: 200, configurable: true });
      Object.defineProperty(composer(), 'clientHeight', { value: 100, configurable: true });
      fireEvent.scroll(composer());
      expect(visibleText()).toBeNull();
    });

    it("withholds the prediction once the held completion would overflow the composer's own box", async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);

      // The composer's own (typed-text-only) box stays comfortably within its
      // height; only the mirror measuring typed text plus the completion — a
      // node this test cannot reach directly — needs to read as taller.
      Object.defineProperty(composer(), 'scrollHeight', { value: 40, configurable: true });
      Object.defineProperty(composer(), 'clientHeight', { value: 40, configurable: true });
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      Object.defineProperty(Element.prototype, 'scrollHeight', {
        configurable: true,
        get: () => 200,
      });
      try {
        fireEvent.scroll(composer());
        expect(visibleText()).toBeNull();
      } finally {
        if (original) Object.defineProperty(Element.prototype, 'scrollHeight', original);
      }
    });

    it('never renders an answer that arrives while the composer is already scrolling', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      Object.defineProperty(composer(), 'scrollHeight', { value: 200, configurable: true });
      Object.defineProperty(composer(), 'clientHeight', { value: 100, configurable: true });
      expect(calls).toHaveLength(1);
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBeNull();
    });

    it('notices a suppression that only typing caused, with no composer event to announce it', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);
      // Growing past its maximum height is the one suppression the composer
      // reaches by typing alone: no caret move, no scroll, no event to hear.
      Object.defineProperty(composer(), 'scrollHeight', { value: 200, configurable: true });
      Object.defineProperty(composer(), 'clientHeight', { value: 100, configurable: true });
      type(`${TYPED} and it`);
      settleDebounce();
      expect(visibleText()).toBeNull();
      expect(calls).toHaveLength(1);
    });

    it('discards an answer that arrives after its request was abandoned', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      type(`${TYPED} and`);
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBeNull();
    });

    it('swallows the rejection its own cancellation produces', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      type(`${TYPED} and`);
      await flush(() => {
        calls[0]?.reject(new Error('aborted'));
      });
      expect(visibleText()).toBeNull();
    });

    it('makes no call for a request armed before the predictor was taken away', () => {
      const { predictor, calls } = createDeferredPredictor();
      const { rerender } = render(<Harness predictor={predictor} />);
      type(TYPED);
      rerender(<Harness predictor={undefined} />);
      settleDebounce();
      expect(calls).toHaveLength(0);
      expect(visibleText()).toBeNull();
    });

    it('re-reads suppression on demand, for a caller acting before the next render', () => {
      const textarea = document.createElement('textarea');
      textarea.value = TYPED;
      textarea.setSelectionRange(2, 2);
      const { result } = renderHook(() =>
        usePromptPrediction({
          predictor: createDeferredPredictor().predictor,
          value: TYPED,
          disabled: false,
          textareaRef: { current: textarea },
          onCandidatesChange: undefined,
        })
      );
      expect(result.current.state.suppression).toBe('caret-not-at-end');
      act(() => {
        textarea.setSelectionRange(TYPED.length, TYPED.length);
        result.current.syncSuppression();
      });
      expect(result.current.state.suppression).toBeNull();
    });

    it('withholds the hint when geometry alone pushes the composer past its height', async () => {
      const { predictor, calls } = createDeferredPredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(visibleText()).toBe(SHAPED_COMPLETION);

      // A rotation, a viewport resize or the accessibility widget's font scale
      // changes the box with no caret move, no scroll and no render of its own.
      Object.defineProperty(composer(), 'scrollHeight', { value: 200, configurable: true });
      Object.defineProperty(composer(), 'clientHeight', { value: 100, configurable: true });
      act(() => {
        ResizeObserverStub.resizeAll();
      });

      expect(visibleText()).toBeNull();
    });

    describe('the font swap', () => {
      /**
       * jsdom implements no `FontFaceSet`, so the test supplies a `document.fonts`
       * whose `ready` promise it resolves on demand, and counts how many times
       * that promise is read.
       */
      function stubFontsReady(): { resolveReady: () => void; readyAccesses: () => number } {
        let accesses = 0;
        let resolveReady: () => void = () => {};
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        Object.defineProperty(document, 'fonts', {
          configurable: true,
          get: () => ({
            get ready() {
              accesses += 1;
              return ready;
            },
          }),
        });
        return { resolveReady, readyAccesses: () => accesses };
      }

      afterEach(() => {
        Reflect.deleteProperty(document, 'fonts');
      });

      it('withholds a completion that only fit under fallback-font metrics once the real face swaps in', async () => {
        const { resolveReady } = stubFontsReady();
        const { predictor, calls } = createDeferredPredictor();
        render(<Harness predictor={predictor} />);
        type(TYPED);
        settleDebounce();
        await flush(() => {
          calls[0]?.resolve(answer());
        });
        expect(visibleText()).toBe(SHAPED_COMPLETION);

        // The composer's own (typed-text-only) box is unaffected by the swap;
        // only the mirror measuring typed text plus the completion — read
        // against the real face once it loads — grows past the composer.
        Object.defineProperty(composer(), 'scrollHeight', { value: 40, configurable: true });
        Object.defineProperty(composer(), 'clientHeight', { value: 40, configurable: true });
        const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
        Object.defineProperty(Element.prototype, 'scrollHeight', {
          configurable: true,
          get: () => 200,
        });
        try {
          await flush(() => {
            resolveReady();
          });
          expect(visibleText()).toBeNull();
        } finally {
          if (original) Object.defineProperty(Element.prototype, 'scrollHeight', original);
        }
      });

      it('keeps rendering a completion that still fits once the real face swaps in', async () => {
        const { resolveReady } = stubFontsReady();
        const { predictor, calls } = createDeferredPredictor();
        render(<Harness predictor={predictor} />);
        type(TYPED);
        settleDebounce();
        await flush(() => {
          calls[0]?.resolve(answer());
        });
        expect(visibleText()).toBe(SHAPED_COMPLETION);

        // No geometry changes at all: the completion fit before the swap and
        // still fits after it, so suppressing it would trade a visible defect
        // for an invisible one.
        await flush(() => {
          resolveReady();
        });
        expect(visibleText()).toBe(SHAPED_COMPLETION);
      });

      it('reads document.fonts.ready once per mount, never again while the user keeps typing', async () => {
        const { readyAccesses } = stubFontsReady();
        const { predictor, calls } = createDeferredPredictor();
        render(<Harness predictor={predictor} />);
        type(TYPED);
        settleDebounce();
        await flush(() => {
          calls[0]?.resolve(answer());
        });
        expect(readyAccesses()).toBe(1);

        type(`${TYPED} a`);
        settleDebounce();
        type(`${TYPED} an`);
        settleDebounce();
        type(`${TYPED} and`);
        settleDebounce();
        expect(readyAccesses()).toBe(1);
      });
    });

    it('watches the composer itself, and stops once the composer goes away', () => {
      const { unmount } = render(<Harness predictor={createDeferredPredictor().predictor} />);
      const observer = ResizeObserverStub.instances[0];
      expect(observer?.observed).toEqual([composer()]);
      unmount();
      expect(observer?.disconnected).toBe(true);
    });

    it('hands an event handler the reading it just took, not the state behind it', () => {
      const decisions: Decision[] = [];
      render(
        <GestureHarness
          predictor={createDeferredPredictor().predictor}
          onDecision={(decision) => decisions.push(decision)}
        />
      );
      type(TYPED);
      // The caret moves with no `select` event and no render, so the committed
      // state still says nothing is withholding a prediction.
      composer().setSelectionRange(2, 2);
      fireEvent.keyDown(composer(), { key: 'Tab' });
      expect(decisions).toEqual([{ returned: 'caret-not-at-end', fromState: null }]);
    });

    it('reports the decision in force when there is no composer left to read', () => {
      const textarea = document.createElement('textarea');
      textarea.value = TYPED;
      textarea.setSelectionRange(2, 2);
      const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: textarea };
      const { result } = renderHook(() =>
        usePromptPrediction({
          predictor: createDeferredPredictor().predictor,
          value: TYPED,
          disabled: false,
          textareaRef,
          onCandidatesChange: undefined,
        })
      );
      expect(result.current.state.suppression).toBe('caret-not-at-end');
      textareaRef.current = null;
      expect(result.current.syncSuppression()).toBe('caret-not-at-end');
    });

    it('leaves suppression alone when the composer element is not mounted', () => {
      const { result, rerender } = renderHook(
        ({ value }: { value: string }) =>
          usePromptPrediction({
            predictor: createDeferredPredictor().predictor,
            value,
            disabled: false,
            textareaRef: { current: null },
            onCandidatesChange: undefined,
          }),
        { initialProps: { value: '' } }
      );
      rerender({ value: TYPED });
      expect(result.current.state.suppression).toBeNull();
      expect(result.current.state.typedText).toBe(TYPED);
    });
  });

  describe('a predictor whose session becomes ready after refusing a request', () => {
    it('asks again, after the usual debounce, for text still sitting unanswered', async () => {
      const { predictor, calls, fireReady } = createReadyAwarePredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.reject(new Error('prediction session is not ready'));
      });
      expect(calls).toHaveLength(1);

      act(() => {
        fireReady();
      });
      expect(calls).toHaveLength(1);
      settleDebounce();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.text).toBe(TYPED);
    });

    it('issues no request when the composer is empty', () => {
      const { predictor, calls, fireReady } = createReadyAwarePredictor();
      render(<Harness predictor={predictor} />);
      act(() => {
        fireReady();
      });
      settleDebounce();
      expect(calls).toHaveLength(0);
    });

    it('issues no request when the session never reaches ready', async () => {
      const { predictor, calls } = createReadyAwarePredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.reject(new Error('the load was abandoned'));
      });
      expect(calls).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(PREDICTION_DEBOUNCE_MS * 10);
      });
      expect(calls).toHaveLength(1);
    });

    it('issues no second request for text a prediction already arrived for', async () => {
      const { predictor, calls, fireReady } = createReadyAwarePredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      expect(calls).toHaveLength(1);

      act(() => {
        fireReady();
      });
      settleDebounce();
      expect(calls).toHaveLength(1);
    });

    it('issues no second request while one is already in flight', () => {
      const { predictor, calls, fireReady } = createReadyAwarePredictor();
      render(<Harness predictor={predictor} />);
      type(TYPED);
      settleDebounce();
      expect(calls).toHaveLength(1);

      act(() => {
        fireReady();
      });
      settleDebounce();
      expect(calls).toHaveLength(1);
    });
  });

  describe('list navigation', () => {
    /** A hook instance with a resolved candidate list, ready for arrow keys. */
    async function withCandidates(
      prediction: Prediction,
      { wireConsumer = true }: { wireConsumer?: boolean } = {}
    ): Promise<ReturnType<typeof renderHook<ReturnType<typeof usePromptPrediction>, unknown>>> {
      const { predictor, calls } = createDeferredPredictor();
      const onCandidatesChange = wireConsumer
        ? vi.fn<(candidates: readonly string[]) => void>()
        : undefined;
      const hook = renderHook(() =>
        usePromptPrediction({
          predictor,
          value: TYPED,
          disabled: false,
          textareaRef: { current: null },
          onCandidatesChange,
        })
      );
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(prediction);
      });
      return hook;
    }

    afterEach(() => {
      // The active row lives in a module-scoped store outside React's own
      // reset between tests; a stray index from one test must never leak into
      // the next test's initial expectations.
      const { result } = renderHook(() => useActiveSuggestionIndex());
      expect(result.current).toBeNull();
    });

    it('does not claim ArrowDown when no candidate consumer is wired up', async () => {
      const { result } = await withCandidates(answer(), { wireConsumer: false });
      expect(result.current.state.status.kind).toBe('ready');
      let claimed = true;
      act(() => {
        claimed = result.current.handleArrowDown();
      });
      expect(claimed).toBe(false);
      expect(result.current.activeSuggestion).toBeNull();
    });

    it('does not claim ArrowDown when the candidate list is empty', () => {
      const { predictor } = createDeferredPredictor();
      const onCandidatesChange = vi.fn<(candidates: readonly string[]) => void>();
      const { result } = renderHook(() =>
        usePromptPrediction({
          predictor,
          value: TYPED,
          disabled: false,
          textareaRef: { current: null },
          onCandidatesChange,
        })
      );
      let claimed = true;
      act(() => {
        claimed = result.current.handleArrowDown();
      });
      expect(claimed).toBe(false);
      expect(result.current.activeSuggestion).toBeNull();
    });

    it('enters the list at the first row on ArrowDown from no active row', async () => {
      const { result } = await withCandidates(answer());
      act(() => {
        result.current.handleArrowDown();
      });
      expect(result.current.activeSuggestion).toBe(0);
      // Leave the module store clean for the next test.
      act(() => {
        result.current.handleArrowUp();
      });
    });

    it('walks forward through multiple candidates without wrapping past the last row', async () => {
      const { result } = await withCandidates(twoAlternativeAnswer());
      act(() => {
        result.current.handleArrowDown();
      });
      act(() => {
        result.current.handleArrowDown();
      });
      expect(result.current.activeSuggestion).toBe(1);
      let claimed = false;
      act(() => {
        claimed = result.current.handleArrowDown();
      });
      expect(claimed).toBe(true);
      expect(result.current.activeSuggestion).toBe(1);
      act(() => {
        result.current.handleArrowUp();
        result.current.handleArrowUp();
      });
    });

    it('moves the virtual focus up one row at a time', async () => {
      const { result } = await withCandidates(twoAlternativeAnswer());
      act(() => {
        result.current.handleArrowDown();
        result.current.handleArrowDown();
      });
      expect(result.current.activeSuggestion).toBe(1);
      act(() => {
        result.current.handleArrowUp();
      });
      expect(result.current.activeSuggestion).toBe(0);
      act(() => {
        result.current.handleArrowUp();
      });
    });

    it('leaves the list on ArrowUp from the first row, returning to no active row', async () => {
      const { result } = await withCandidates(answer());
      act(() => {
        result.current.handleArrowDown();
      });
      let claimed = false;
      act(() => {
        claimed = result.current.handleArrowUp();
      });
      expect(claimed).toBe(true);
      expect(result.current.activeSuggestion).toBeNull();
    });

    it('returns false from ArrowUp when no row is active', async () => {
      const { result } = await withCandidates(answer());
      let claimed = true;
      act(() => {
        claimed = result.current.handleArrowUp();
      });
      expect(claimed).toBe(false);
      expect(result.current.activeSuggestion).toBeNull();
    });

    it('resets the active row when the candidate set changes', async () => {
      const { predictor, calls } = createDeferredPredictor();
      const onCandidatesChange = vi.fn<(candidates: readonly string[]) => void>();
      const { result, rerender } = renderHook(
        ({ value }: { value: string }) =>
          usePromptPrediction({
            predictor,
            value,
            disabled: false,
            textareaRef: { current: null },
            onCandidatesChange,
          }),
        { initialProps: { value: TYPED } }
      );
      settleDebounce();
      await flush(() => {
        calls[0]?.resolve(answer());
      });
      act(() => {
        result.current.handleArrowDown();
      });
      expect(result.current.activeSuggestion).toBe(0);

      rerender({ value: `${TYPED} and` });
      expect(result.current.activeSuggestion).toBeNull();
    });

    it('returns null from applyActiveSuggestion when no row is active', async () => {
      const { result } = await withCandidates(answer());
      let applied: string | null = 'not called';
      act(() => {
        applied = result.current.applyActiveSuggestion();
      });
      expect(applied).toBeNull();
    });

    it('applies the active row, returning the composer to idle with no row active', async () => {
      const { result } = await withCandidates(answer());
      act(() => {
        result.current.handleArrowDown();
      });
      let applied: string | null = null;
      act(() => {
        applied = result.current.applyActiveSuggestion();
      });
      expect(applied).toBe(`${TYPED}${SHAPED_ALTERNATIVE}`);
      expect(result.current.activeSuggestion).toBeNull();
      expect(result.current.state.status.kind).toBe('idle');
    });

    it('applies the candidate at the active row, not always the first', async () => {
      const { result } = await withCandidates(twoAlternativeAnswer());
      act(() => {
        result.current.handleArrowDown();
        result.current.handleArrowDown();
      });
      expect(result.current.activeSuggestion).toBe(1);
      let applied: string | null = null;
      act(() => {
        applied = result.current.applyActiveSuggestion();
      });
      expect(applied).toBe(`${TYPED}${SHAPED_ALTERNATIVE_2}`);
    });

    it('exposes the active row to an independent subscriber outside the composer', async () => {
      const { result: prediction } = await withCandidates(answer());
      const { result: subscriber } = renderHook(() => useActiveSuggestionIndex());
      expect(subscriber.current).toBeNull();

      act(() => {
        prediction.current.handleArrowDown();
      });
      expect(subscriber.current).toBe(0);

      act(() => {
        prediction.current.handleArrowUp();
      });
    });
  });
});
