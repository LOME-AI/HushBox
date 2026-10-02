import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { EMPTY_FILTERS } from './logic/filters';
import { FilterRail } from './filter-rail';
import type { FilterRailProps } from './filter-rail';

const areas = [
  { value: 'packages/db', count: 21 },
  { value: 'unknown', count: 93 },
];

function renderRail(props: Partial<FilterRailProps> = {}): {
  onChange: ReturnType<typeof vi.fn>;
  onClear: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(
    <FilterRail
      filters={EMPTY_FILTERS}
      areas={areas}
      onChange={onChange}
      onClear={onClear}
      {...props}
    />
  );
  return { onChange, onClear };
}

describe('FilterRail', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('offers every dimension', () => {
    renderRail();

    expect(screen.getByText('Severity')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Kind')).toBeInTheDocument();
    expect(screen.getByLabelText('Area')).toBeInTheDocument();
    expect(screen.getByLabelText('Has a warning')).toBeInTheDocument();
    expect(screen.getByLabelText('In a group')).toBeInTheDocument();
  });

  it('turns a severity on', () => {
    const { onChange } = renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'critical' }));

    expect(onChange).toHaveBeenCalledWith({ severity: ['critical'] });
  });

  it('turns a status on', () => {
    const { onChange } = renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'latent' }));

    expect(onChange).toHaveBeenCalledWith({ status: ['latent'] });
  });

  it('turns a kind on', () => {
    const { onChange } = renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'decision' }));

    expect(onChange).toHaveBeenCalledWith({ kind: ['decision'] });
  });

  it('lists every area with how many findings carry it', () => {
    renderRail();

    expect(screen.getByRole('option', { name: 'packages/db (21)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'unknown (93)' })).toBeInTheDocument();
  });

  it('says what its area counts are counted over, so a number elsewhere reads as a different scope', () => {
    renderRail();

    expect(
      screen.getByText('Counted in this section, with your other filters on.')
    ).toBeInTheDocument();
  });

  it('narrows to one area', () => {
    const { onChange } = renderRail();

    fireEvent.change(screen.getByTestId(TEST_IDS.areaFilter), {
      target: { value: 'packages/db' },
    });

    expect(onChange).toHaveBeenCalledWith({ area: 'packages/db' });
  });

  it('widens back to every area', () => {
    const { onChange } = renderRail({
      filters: { ...EMPTY_FILTERS, area: 'packages/db' },
    });

    fireEvent.change(screen.getByTestId(TEST_IDS.areaFilter), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ area: null });
  });

  it('narrows to warned findings', () => {
    const { onChange } = renderRail();

    fireEvent.click(screen.getByLabelText('Has a warning'));

    expect(onChange).toHaveBeenCalledWith({ warning: true });
  });

  it('narrows to grouped findings', () => {
    const { onChange } = renderRail();

    fireEvent.click(screen.getByLabelText('In a group'));

    expect(onChange).toHaveBeenCalledWith({ grouped: true });
  });

  it('turns a narrowed toggle back off', () => {
    const { onChange } = renderRail({ filters: { ...EMPTY_FILTERS, warning: true } });

    fireEvent.click(screen.getByLabelText('Has a warning'));

    expect(onChange).toHaveBeenCalledWith({ warning: false });
  });

  it('offers a clear only while something is filtered', () => {
    renderRail();

    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('clears everything at once', () => {
    const { onClear } = renderRail({ filters: { ...EMPTY_FILTERS, warning: true } });

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('offers a way to close itself where there is room for it', () => {
    renderRail();

    expect(screen.getByRole('button', { name: 'Hide filters' })).toBeInTheDocument();
  });

  it('closes, so the reading area gets the width', () => {
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }));

    expect(screen.queryByText('Severity')).not.toBeInTheDocument();
  });

  /**
   * The reader closes the rail once and reads for hours; reopening it on every
   * reload would be the console undoing that decision on their behalf.
   */
  it('is still closed after the console is loaded again', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }));
    cleanup();

    renderRail();

    expect(screen.queryByText('Severity')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('is still open after the console is loaded again', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    cleanup();

    renderRail();

    expect(screen.getByText('Severity')).toBeInTheDocument();
  });
});

/**
 * At 375px the rail held 224px of the viewport, leaving the finding it was
 * filtering about 150px to be read in.
 */
describe('FilterRail on a narrow viewport', () => {
  const original = globalThis.matchMedia;

  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  function viewport(narrow: boolean): void {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: narrow,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: original });
    vi.restoreAllMocks();
  });

  it('leaves the rail alone on a viewport with room for it', () => {
    viewport(false);
    renderRail();

    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByText('Severity')).toBeInTheDocument();
  });

  it('folds the filters away, so the finding gets the width', () => {
    viewport(true);
    renderRail();

    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('Severity')).not.toBeInTheDocument();
  });

  it('opens them when the reader asks for them', () => {
    viewport(true);
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    expect(screen.getByText('Severity')).toBeInTheDocument();
  });

  it('folds them back up', () => {
    viewport(true);
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    fireEvent.click(screen.getByRole('button', { name: 'Hide filters' }));

    expect(screen.queryByText('Severity')).not.toBeInTheDocument();
  });

  // The width class is the mechanism that hands the viewport back to the finding.
  // The test environment has no layout engine, so the class is the only observable
  // form of it; asserting the rendered width class is what these three do.
  it('keeps the rail its own fixed width where there is room for it', () => {
    viewport(false);
    renderRail();

    expect(screen.getByTestId(TEST_IDS.filterRail).className).toContain('w-56');
  });

  it('shrinks to its toggle when folded, so the width goes to the finding', () => {
    viewport(true);
    renderRail();

    expect(screen.getByTestId(TEST_IDS.filterRail).className).toContain('w-auto');
  });

  it('takes the whole viewport while it is open, because the queue is behind it', () => {
    viewport(true);
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    expect(screen.getByTestId(TEST_IDS.filterRail).className).toContain('w-full');
  });

  it('says a filter is on, because a folded rail must not hide why a queue is short', () => {
    viewport(true);
    renderRail({ filters: { ...EMPTY_FILTERS, warning: true } });

    expect(screen.getByRole('button', { name: 'Filters on' })).toBeInTheDocument();
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

describe('FilterRail at each form factor', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('opens folded on a phone', () => {
    stubFormFactor(390, 'coarse');
    renderRail();

    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('takes the whole width once opened on a phone', () => {
    stubFormFactor(390, 'coarse');
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    expect(screen.getByTestId(TEST_IDS.filterRail)).toHaveClass('w-full');
  });

  it('opens with the filters on screen at its fixed width on a tablet, whose width has room for it', () => {
    stubFormFactor(834, 'coarse');
    renderRail();

    expect(screen.getByText('Severity')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.filterRail)).toHaveClass('w-56');
  });

  it('opens with the filters on screen at its fixed width on a desktop', () => {
    stubFormFactor(1440, 'fine');
    renderRail();

    expect(screen.getByText('Severity')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.filterRail)).toHaveClass('w-56');
  });
});
