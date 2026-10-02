// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import {
  PredictionSuggestionList,
  PredictionSuggestionListSpacer,
} from '@/components/chat/input/prediction-suggestion-list';
import {
  PREDICTION_SUGGESTION_LISTBOX_ID,
  setActiveSuggestionIndex,
  suggestionRowId,
} from '@/components/chat/input/use-prompt-prediction';

const TYPED = 'the quick brown fox';
const CANDIDATES = [' jumps over the', ' leaps over the', ' sleeps under the'];

/** 45 characters, so the tail budget has to cut it at a word boundary. */
const LONG_TYPED = 'alpha beta gamma delta epsilon zeta eta theta';
const LONG_TYPED_TAIL = 'delta epsilon zeta eta theta';

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="prediction-suggestion-row"]')];
}

function reservedRows(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-slot="prediction-suggestion-reserve-row"]'),
  ];
}

function tailOf(row: HTMLElement): string {
  return row.querySelector('[data-slot="prediction-suggestion-tail"]')?.textContent ?? '';
}

function completionOf(row: HTMLElement): HTMLElement {
  const element = row.querySelector<HTMLElement>('[data-slot="prediction-suggestion-completion"]');
  if (element === null) throw new Error('row has no completion segment');
  return element;
}

afterEach(() => {
  // The reset reaches components still mounted at this point: this file's
  // hook runs before the cleanup the test setup registers.
  act(() => {
    useA11yStore.getState().reset();
  });
  // The active-row store is a module singleton shared with every other
  // mounted consumer, so a test that moves it must not leak that into the
  // next one.
  act(() => {
    setActiveSuggestionIndex(null);
  });
});

describe('PredictionSuggestionList', () => {
  it('renders one row per candidate', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(rows(container).map((row) => completionOf(row).textContent)).toEqual(CANDIDATES);
  });

  it('repeats the same typed tail on every row so the coloured segments line up', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(rows(container).map((row) => tailOf(row))).toEqual([TYPED, TYPED, TYPED]);
  });

  it('gives the completion the same treatment as the inline hint', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    for (const className of ['text-prediction', 'underline', 'decoration-dotted']) {
      expect(completionOf(rows(container)[0]!)).toHaveClass(className);
    }
  });

  it('leaves the typed tail in the composer’s own colour', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const tail = rows(container)[0]!.querySelector('[data-slot="prediction-suggestion-tail"]');
    expect(tail).not.toHaveClass('text-prediction');
  });

  it('reports the clicked row’s completion for the caller to append', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={onSelect} />
    );
    fireEvent.click(rows(container)[1]!);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(CANDIDATES[1]);
  });

  it('renders nothing when there is no answer', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={[]} onSelect={vi.fn()} />
    );
    expect(rows(container)).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('renders a single alternative as one row, since candidates never repeat the inline hint', () => {
    const { container } = render(
      <PredictionSuggestionList
        typedText={TYPED}
        candidates={[' leaps over the']}
        onSelect={vi.fn()}
      />
    );
    expect(rows(container).map((row) => completionOf(row).textContent)).toEqual([
      ' leaps over the',
    ]);
  });

  it('shows at most four rows', () => {
    const { container } = render(
      <PredictionSuggestionList
        typedText={TYPED}
        candidates={[' one two', ' two three', ' three four', ' four five', ' five six']}
        onSelect={vi.fn()}
      />
    );
    expect(rows(container)).toHaveLength(4);
  });

  it('shows a short typed text in full with no ellipsis', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(tailOf(rows(container)[0]!)).toBe(TYPED);
  });

  it('elides a long typed text at a word boundary behind a leading ellipsis', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={LONG_TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(tailOf(rows(container)[0]!)).toBe(`…${LONG_TYPED_TAIL}`);
  });

  it('cuts a long unbroken run of text where no word boundary exists', () => {
    const unbroken = 'a'.repeat(40);
    const { container } = render(
      <PredictionSuggestionList typedText={unbroken} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(tailOf(rows(container)[0]!)).toBe(`…${'a'.repeat(32)}`);
  });

  it('keeps a row at its position when the settled set changes under it', () => {
    const { container, rerender } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const first = rows(container)[0]!;
    rerender(
      <PredictionSuggestionList
        typedText={TYPED}
        candidates={[' walks past the', ' runs past the']}
        onSelect={vi.fn()}
      />
    );
    expect(rows(container)[0]).toBe(first);
    expect(completionOf(rows(container)[0]!).textContent).toBe(' walks past the');
  });

  it('animates the list open', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(rows(container)[0]!.closest('[data-animated]')).toHaveAttribute('data-animated', 'true');
  });

  it('opens instantly under the merged reduced-motion signal', () => {
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(rows(container)[0]!.closest('[data-animated]')).toHaveAttribute(
      'data-animated',
      'false'
    );
  });

  it('exposes itself as a listbox for the composer to own via aria-owns', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const listbox = container.querySelector(`#${PREDICTION_SUGGESTION_LISTBOX_ID}`);
    expect(listbox).toHaveAttribute('role', 'listbox');
  });

  it('gives each row an option role and an id keyed by its position', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const found = rows(container);
    for (const [index, row] of found.entries()) {
      expect(row).toHaveAttribute('role', 'option');
      expect(row).toHaveAttribute('id', suggestionRowId(index));
    }
  });

  it('marks only the active row aria-selected', () => {
    act(() => {
      setActiveSuggestionIndex(1);
    });
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const found = rows(container);
    expect(found[0]).toHaveAttribute('aria-selected', 'false');
    expect(found[1]).toHaveAttribute('aria-selected', 'true');
    expect(found[2]).toHaveAttribute('aria-selected', 'false');
  });

  it('leaves every row aria-selected false while no row is active', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    for (const row of rows(container)) expect(row).toHaveAttribute('aria-selected', 'false');
  });

  it('gives the active row a visible focus ring', () => {
    act(() => {
      setActiveSuggestionIndex(1);
    });
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const found = rows(container);
    expect(found[1]).toHaveClass('ring-2');
    expect(found[0]).not.toHaveClass('ring-2');
  });

  it("hides each row's browser outline only while it has keyboard focus", () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const suppressions = rows(container).map((row) =>
      [...row.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
    );
    expect(suppressions).toEqual(CANDIDATES.map(() => ['focus-visible:outline-hidden']));
  });

  it('leaves forced colors an outline to paint on the active row alone', () => {
    act(() => {
      setActiveSuggestionIndex(1);
    });
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    expect(rows(container).map((row) => row.classList.contains('outline-hidden'))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('pads the rows container so a ring has room to render before AnimatedHeight clips it', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const listbox = container.querySelector(`#${PREDICTION_SUGGESTION_LISTBOX_ID}`);
    expect(listbox).toHaveClass('p-1');
  });

  it('gives the first, a middle, and the last row the identical padded container', () => {
    const { container } = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const found = rows(container);
    const first = found[0]!;
    const middle = found[1]!;
    const last = found.at(-1)!;
    expect(first.parentElement).toBe(middle.parentElement);
    expect(middle.parentElement).toBe(last.parentElement);
    expect(first.parentElement).toHaveClass('p-1');
  });
});

describe('PredictionSuggestionListSpacer', () => {
  it('renders the same rows as the list so it takes exactly the same height', () => {
    const list = render(
      <PredictionSuggestionList typedText={TYPED} candidates={CANDIDATES} onSelect={vi.fn()} />
    );
    const spacer = render(
      <PredictionSuggestionListSpacer typedText={TYPED} candidates={CANDIDATES} />
    );
    expect(reservedRows(spacer.container).map((row) => row.textContent)).toEqual(
      rows(list.container).map((row) => row.textContent)
    );
  });

  it('is invisible and hidden from assistive technology', () => {
    const { container } = render(
      <PredictionSuggestionListSpacer typedText={TYPED} candidates={CANDIDATES} />
    );
    const spacer = container.querySelector('[data-slot="prediction-suggestion-spacer"]');
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
    expect(spacer).toHaveClass('invisible');
  });

  it('takes no row out of the tab order and answers no click', () => {
    const { container } = render(
      <PredictionSuggestionListSpacer typedText={TYPED} candidates={CANDIDATES} />
    );
    const reserved = reservedRows(container);
    expect(reserved).toHaveLength(CANDIDATES.length);
    for (const row of reserved) expect(row).toHaveAttribute('tabindex', '-1');
    expect(() => {
      fireEvent.click(reserved[0]!);
    }).not.toThrow();
  });

  it('collapses to nothing exactly when the list does', () => {
    const { container } = render(
      <PredictionSuggestionListSpacer typedText={TYPED} candidates={[]} />
    );
    expect(reservedRows(container)).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('carries no listbox or option semantics, since aria-hidden already removes it', () => {
    act(() => {
      setActiveSuggestionIndex(1);
    });
    const { container } = render(
      <PredictionSuggestionListSpacer typedText={TYPED} candidates={CANDIDATES} />
    );
    expect(container.querySelector(`#${PREDICTION_SUGGESTION_LISTBOX_ID}`)).toBeNull();
    for (const row of reservedRows(container)) {
      expect(row).not.toHaveAttribute('role');
      expect(row).not.toHaveAttribute('aria-selected');
    }
  });

  it('reserves the same padded rows container as the real list, since it is the same subtree', () => {
    const { container } = render(
      <PredictionSuggestionListSpacer typedText={TYPED} candidates={CANDIDATES} />
    );
    const reserved = reservedRows(container);
    expect(reserved[0]!.parentElement).toHaveClass('p-1');
  });
});
