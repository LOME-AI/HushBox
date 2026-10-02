// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TEXTAREA_MIRROR_CLASSES,
  TEXTAREA_WRAP_CLASSES,
  TouchDeviceOverrideContext,
} from '@hushbox/ui';
import { PredictionOverlay } from '@/components/chat/input/prediction-overlay';
import { initialPredictionState, type PredictionState } from '@/lib/prediction/state';
import type { SuppressionReason } from '@/lib/prediction/suppression';

const TYPED = 'the quick brown fox';
const COMPLETION = ' jumps over the lazy dog';

function readyState(overrides: Partial<PredictionState> = {}): PredictionState {
  return {
    ...initialPredictionState,
    typedText: TYPED,
    status: {
      kind: 'ready',
      requestText: TYPED,
      prediction: { completion: COMPLETION, candidates: [COMPLETION, ' leaps over the fence'] },
    },
    ...overrides,
  };
}

function overlayElement(): HTMLElement | null {
  return document.querySelector('[data-slot="prediction-overlay"]');
}

function predictionElement(): HTMLElement | null {
  return document.querySelector('[data-slot="prediction-text"]');
}

function hintElement(): HTMLElement | null {
  return document.querySelector('[data-slot="prediction-hint"]');
}

/** The hook's lazy initial state always reads this, even when a test forces
 * the value through {@link TouchDeviceOverrideContext} — the override is
 * checked only on return, after the state hook has already run. */
function stubMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

/**
 * Every reason predictions may be withheld, as a total map so a new member of
 * the union fails to compile here rather than slipping past the suppression
 * cases below untested.
 */
const EVERY_SUPPRESSION_REASON: Record<SuppressionReason, true> = {
  'caret-not-at-end': true,
  'composer-scrolls': true,
  'right-to-left': true,
  'completion-too-tall': true,
};

describe('PredictionOverlay', () => {
  it('renders the completion immediately after the typed text', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(overlayElement()).toHaveTextContent(`${TYPED}${COMPLETION}`.trim());
    expect(predictionElement()).toHaveTextContent(COMPLETION.trim());
  });

  it('renders the typed prefix transparently so the real glyphs below stay legible', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    const prefix = document.querySelector('[data-slot="prediction-mirror-prefix"]');
    expect(prefix).toHaveTextContent(TYPED);
    expect(prefix).toHaveClass('text-transparent');
  });

  it('mirrors the composer typography and padding so layout alone places the text', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    const overlay = overlayElement();
    for (const className of [
      'absolute',
      // Pinned to the top and full width, but not to the bottom: a bottom pin
      // would force the box to the textarea's own height and clip a
      // completion that wraps past it.
      'top-0',
      'inset-x-0',
      // Both the wrap behavior and the metrics that align the mirror come from
      // the primitive the composer renders, so there is one definition of them
      // and not two.
      ...TEXTAREA_WRAP_CLASSES.split(' '),
      ...TEXTAREA_MIRROR_CLASSES.split(' '),
    ]) {
      expect(overlay).toHaveClass(className);
    }
  });

  it('hides the overlay from assistive technology and from the pointer', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(overlayElement()).toHaveAttribute('aria-hidden', 'true');
    expect(overlayElement()).toHaveClass('pointer-events-none');
  });

  it('styles the prediction with the token colour, a dotted underline, and its own pointer target', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    for (const className of [
      'text-prediction',
      'underline',
      'decoration-dotted',
      'pointer-events-auto',
    ]) {
      expect(predictionElement()).toHaveClass(className);
    }
  });

  it('renders no background tint behind the prediction', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(predictionElement()).not.toHaveClass('bg-prediction-tint');
  });

  it('never clips its own box to the textarea, so a wrapped line has room to render', () => {
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    const overlay = overlayElement();
    expect(overlay).not.toHaveClass('overflow-hidden');
    expect(overlay).toHaveClass('overflow-visible');
  });

  it('shows a hint that Tab accepts the prediction on a non-touch device', () => {
    stubMatchMedia();
    render(
      <TouchDeviceOverrideContext value={false}>
        <PredictionOverlay state={readyState()} onAccept={vi.fn()} />
      </TouchDeviceOverrideContext>
    );
    expect(hintElement()).toHaveTextContent('Tab');
  });

  it('places the hint after the prediction text, inside the same aria-hidden overlay', () => {
    stubMatchMedia();
    render(
      <TouchDeviceOverrideContext value={false}>
        <PredictionOverlay state={readyState()} onAccept={vi.fn()} />
      </TouchDeviceOverrideContext>
    );
    const overlay = overlayElement();
    const prediction = predictionElement();
    const hint = hintElement();
    expect(overlay).toContainElement(hint);
    expect(
      prediction!.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('hides the Tab hint on a touch device, where there is no Tab key', () => {
    stubMatchMedia();
    render(
      <TouchDeviceOverrideContext value={true}>
        <PredictionOverlay state={readyState()} onAccept={vi.fn()} />
      </TouchDeviceOverrideContext>
    );
    expect(hintElement()).toBeNull();
    // Withholding the hint must not withhold the prediction itself.
    expect(predictionElement()).toHaveTextContent(COMPLETION.trim());
  });

  it('accepts on pointer-down and prevents the default so focus never leaves the composer', () => {
    const onAccept = vi.fn();
    render(<PredictionOverlay state={readyState()} onAccept={onAccept} />);
    const defaultAllowed = fireEvent.pointerDown(predictionElement()!);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(defaultAllowed).toBe(false);
  });

  for (const reason of Object.keys(EVERY_SUPPRESSION_REASON) as SuppressionReason[]) {
    it(`renders nothing while suppressed by ${reason}`, () => {
      render(<PredictionOverlay state={readyState({ suppression: reason })} onAccept={vi.fn()} />);
      expect(overlayElement()).toBeNull();
      expect(screen.queryByText(COMPLETION.trim())).toBeNull();
    });
  }

  it('renders nothing while an input method is composing', () => {
    render(<PredictionOverlay state={readyState({ composing: true })} onAccept={vi.fn()} />);
    expect(overlayElement()).toBeNull();
  });

  it('renders nothing when no answer is held', () => {
    render(
      <PredictionOverlay
        state={{ ...initialPredictionState, typedText: TYPED }}
        onAccept={vi.fn()}
      />
    );
    expect(overlayElement()).toBeNull();
  });

  it('renders nothing once the typed text has left the text the answer was computed from', () => {
    render(
      <PredictionOverlay state={readyState({ typedText: `${TYPED} and` })} onAccept={vi.fn()} />
    );
    expect(overlayElement()).toBeNull();
  });
});

/**
 * A viewport `width` CSS pixels wide whose primary pointer is `pointer`, as
 * `matchMedia` reports it: a max-width query matches at or below its bound,
 * and the coarse-pointer query matches only for a coarse pointer.
 */
function stubFormFactor(width: number, pointer: 'fine' | 'coarse'): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches =
      maxWidth === null
        ? query === '(pointer: coarse)' && pointer === 'coarse'
        : width <= Number(maxWidth[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

describe('PredictionOverlay Tab hint at each form factor', () => {
  it('withholds the hint on a phone, whose pointer is coarse', () => {
    stubFormFactor(390, 'coarse');
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(hintElement()).toBeNull();
  });

  it('withholds the hint on a tablet, whose pointer is coarse at a desktop width', () => {
    stubFormFactor(834, 'coarse');
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(hintElement()).toBeNull();
  });

  it('shows the hint on a desktop with a fine pointer', () => {
    stubFormFactor(1440, 'fine');
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(hintElement()).toHaveTextContent('Tab');
  });

  it('shows the hint at a phone width when the pointer is fine, since the pointer alone decides', () => {
    stubFormFactor(390, 'fine');
    render(<PredictionOverlay state={readyState()} onAccept={vi.fn()} />);
    expect(hintElement()).toHaveTextContent('Tab');
  });
});
