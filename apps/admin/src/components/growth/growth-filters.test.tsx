import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { GrowthFilters } from './growth-filters.js';
import { dayOf } from './growth-window.js';
import { DATA_EDGE_NO_CAMPAIGN, panelScopeNote } from './panel-scope.js';
import type { DataEdgeStatus } from './data-edge.js';
import type { GrowthCampaignWire } from '@hushbox/shared';
import type { FormFactor } from '@hushbox/ui/platform';

const PHONE: FormFactor = { band: 'phone', pointer: 'coarse' };
const TABLET: FormFactor = { band: 'desktop', pointer: 'coarse' };
const DESKTOP: FormFactor = { band: 'desktop', pointer: 'fine' };

/** The form factor the toolbar believes it is at, set by mocking the hook. */
const formFactor = vi.fn((): FormFactor => DESKTOP);

vi.mock('@hushbox/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui/platform')>()),
  useFormFactor: (): FormFactor => formFactor(),
}));

const WEEKS: readonly Date[] = [
  new Date(TEST_DAY_START - 7 * 24 * HOUR_MS),
  new Date(TEST_DAY_START),
];

/**
 * The selected week, written with a zone offset instead of as UTC and an hour
 * past the UTC day it falls in. The screen that mounts this toolbar selects a
 * week as a UTC midnight, so a day read off that string and the day the week
 * phrase names agree on every week the picker can hold; an instant carrying an
 * offset is the one shape of input they part on, and so the only one that can
 * hold the trigger to the shared derivation rather than to a second one.
 */
const WEEK_AS_A_ZONED_INSTANT = `${isoAt(TEST_DAY_START + HOUR_MS).replace('Z', '')}+02:00`;

function campaignRow(tag: string): GrowthCampaignWire {
  return { tag, label: tag, status: 'active', createdAt: isoAt(TEST_DAY_START) };
}

const CAMPAIGNS: readonly GrowthCampaignWire[] = [
  campaignRow('hn-launch'),
  campaignRow('x-thread'),
];

/** The sentence the toolbar states when the day range reaches no panel. */
const RANGE_OFF_REASON = 'The hour grain reads the week selected, so the day range is off.';

/** A refusal sentence, standing in for whichever one the screen produced. */
const REFUSAL = 'Pick a range of at most 92 days.';

const ANSWERED: DataEdgeStatus = { state: 'answered', note: 'Data runs through 2026-09-19.' };

/** The toolbar with everything answered and nothing refused, which each case narrows. */
function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof GrowthFilters>> = {}
): ReturnType<typeof render> {
  return render(
    <GrowthFilters
      weeks={WEEKS}
      selectedWeek={WEEKS[1]!.toISOString()}
      onWeekChange={vi.fn()}
      grain="day"
      onGrainChange={vi.fn()}
      range={{ start: '2026-06-23', end: '2026-09-20' }}
      onRangeChange={vi.fn()}
      campaigns={CAMPAIGNS}
      selectedCampaigns={[]}
      onCampaignToggle={vi.fn()}
      refusal={null}
      edge={ANSWERED}
      readAt={TEST_DAY_START}
      onRefresh={vi.fn()}
      {...overrides}
    />
  );
}

/** The one line the page states its freshness, staleness and read age in. */
function statusLine(): HTMLElement {
  const status = document.querySelector('[data-slot="growth-status"]');
  if (status === null) throw new Error('no status line in the toolbar');
  return status as HTMLElement;
}

beforeEach(() => {
  formFactor.mockReturnValue(DESKTOP);
  freezeClock(TEST_DAY_START, { shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GrowthFilters', () => {
  it('names the page in its own heading', () => {
    renderToolbar();
    expect(screen.getByRole('heading', { name: 'Growth', level: 1 })).toBeInTheDocument();
  });

  it('sets its heading at the size every other admin screen sets one', () => {
    renderToolbar();
    expect(screen.getByRole('heading', { name: 'Growth', level: 1 })).toHaveClass(
      'text-[1.2rem]',
      'font-bold'
    );
  });

  it('lets the week picker shrink to the row rather than running past its edge', () => {
    renderToolbar();
    const trigger = screen.getByRole('combobox', { name: /^Week/ });
    expect(trigger.closest('[data-slot="growth-week-field"]')).toHaveClass('w-44', 'max-w-full');
    expect(trigger).toHaveClass('w-full');
    expect(trigger.parentElement).toHaveClass('min-w-0');
  });

  it("draws the week picker at the toolbar's small control height", () => {
    renderToolbar();
    expect(screen.getByRole('combobox', { name: /^Week/ })).toHaveAttribute('data-size', 'sm');
  });

  it('draws the week picker on the control border', () => {
    renderToolbar();
    expect(screen.getByRole('combobox', { name: /^Week/ })).toHaveClass('border-border-control');
  });

  it('sticks to the top of the scroll container from the width it leaves room below it', () => {
    renderToolbar();
    const toolbar = document.querySelector('[data-slot="growth-toolbar"]');
    expect(toolbar).toHaveClass('md:sticky', 'md:top-0');
    expect(toolbar).not.toHaveClass('sticky');
  });
});

describe('GrowthFilters at a narrow viewport', () => {
  it('folds the controls that scope a read behind one disclosure', () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('combobox', { name: /^Week/ })).not.toBeInTheDocument();
  });

  it('unfolds them when an operator asks for them', async () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('combobox', { name: /^Week/ })).toBeInTheDocument();
  });

  it('keeps a standing refusal in view with the controls folded away', () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar({ refusal: REFUSAL });
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('combobox', { name: /^Week/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(REFUSAL);
  });

  it('folds the controls back away while a refusal stands, rather than refusing the press', async () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar({ refusal: REFUSAL });
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(screen.getByRole('combobox', { name: /^Week/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(screen.queryByRole('combobox', { name: /^Week/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(REFUSAL);
  });

  it('states the campaign narrowing on the fold, which is where its count went', () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar({ selectedCampaigns: ['hn-launch'] });
    expect(screen.getByRole('button', { name: 'Filters 1 of 2 campaigns' })).toBeInTheDocument();
  });

  it('states no count on the fold where the selection narrows nothing', () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('shows the week as the day alone, since the phrase does not fit the column', async () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    const trigger = screen.getByRole('combobox', { name: /^Week/ });
    expect(trigger).toHaveTextContent(isoAt(TEST_DAY_START).slice(0, 10));
    expect(trigger).not.toHaveTextContent('Week of');
  });

  it('names the day the selected week falls in, as the week phrase names it', async () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar({ selectedWeek: WEEK_AS_A_ZONED_INSTANT });
    await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(screen.getByRole('combobox', { name: /^Week/ })).toHaveTextContent(
      dayOf(new Date(WEEK_AS_A_ZONED_INSTANT))
    );
  });

  it('keeps refreshing out of the fold, since it is what a stale figure needs', () => {
    formFactor.mockReturnValue(PHONE);
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});

describe('GrowthFilters at a wide viewport', () => {
  it('holds the controls in the row itself, with nothing to unfold', () => {
    renderToolbar();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^Week/ })).toBeInTheDocument();
  });

  it('holds them in the row on a tablet too, since a coarse pointer does not narrow the viewport', () => {
    formFactor.mockReturnValue(TABLET);
    renderToolbar();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^Week/ })).toBeInTheDocument();
  });
});

describe('GrowthFilters week picker', () => {
  it('names the week it is set to', () => {
    renderToolbar();
    expect(screen.getByRole('combobox', { name: /^Week/ })).toHaveTextContent(
      `Week of ${isoAt(TEST_DAY_START).slice(0, 10)}`
    );
  });

  it('reports the week an operator picks', async () => {
    const onWeekChange = vi.fn();
    renderToolbar({ onWeekChange });
    await userEvent.click(screen.getByRole('combobox', { name: /^Week/ }));
    await userEvent.click(
      await screen.findByRole('option', {
        name: `Week of ${isoAt(TEST_DAY_START - 7 * 24 * HOUR_MS).slice(0, 10)}`,
      })
    );
    expect(onWeekChange).toHaveBeenCalledWith(WEEKS[0]!.toISOString());
  });
});

describe('GrowthFilters grain control', () => {
  it('marks the grain it is set to as the one chosen', () => {
    renderToolbar();
    expect(screen.getByRole('radio', { name: 'Day' })).toHaveAttribute('data-state', 'on');
  });

  it('reports the grain an operator picks', async () => {
    const onGrainChange = vi.fn();
    renderToolbar({ onGrainChange });
    await userEvent.click(screen.getByRole('radio', { name: 'Hour' }));
    expect(onGrainChange).toHaveBeenCalledWith('hour');
  });

  it('keeps the grain it has when the chosen option is pressed again', async () => {
    const onGrainChange = vi.fn();
    renderToolbar({ onGrainChange });
    await userEvent.click(screen.getByRole('radio', { name: 'Day' }));
    expect(onGrainChange).not.toHaveBeenCalled();
  });
});

describe('GrowthFilters day range', () => {
  it('reports a start day an operator sets', () => {
    const onRangeChange = vi.fn();
    renderToolbar({ onRangeChange });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-06-01' } });
    expect(onRangeChange).toHaveBeenCalledWith({ start: '2026-06-01', end: '2026-09-20' });
  });

  it('reports an end day an operator sets', () => {
    const onRangeChange = vi.fn();
    renderToolbar({ onRangeChange });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-01' } });
    expect(onRangeChange).toHaveBeenCalledWith({ start: '2026-06-23', end: '2026-09-01' });
  });

  it('draws each day control as the inline input', () => {
    renderToolbar();
    expect(screen.getByLabelText('From')).toHaveAttribute('data-slot', 'inline-input');
    expect(screen.getByLabelText('To')).toHaveAttribute('data-slot', 'inline-input');
  });

  it('turns both days off at the grain that reads the week selected instead', () => {
    renderToolbar({ grain: 'hour' });
    expect(screen.getByLabelText('From')).toBeDisabled();
    expect(screen.getByLabelText('To')).toBeDisabled();
  });

  it('states why the days are off without waiting for a pointer', () => {
    renderToolbar({ grain: 'hour' });
    expect(screen.getByText(RANGE_OFF_REASON)).toBeInTheDocument();
  });

  it('describes each day control by that reason, so it is announced with the control', () => {
    renderToolbar({ grain: 'hour' });
    const described = screen.getByLabelText('From').getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.querySelector(`[id="${described!}"]`)).toHaveTextContent(RANGE_OFF_REASON);
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-describedby', described);
  });

  it('opens the reason on focus, so it is reachable with no pointer', async () => {
    renderToolbar({ grain: 'hour' });
    const wrapper = screen.getByRole('group', { name: 'Day range' });
    expect(wrapper).toHaveAttribute('tabindex', '0');
    act(() => {
      wrapper.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(RANGE_OFF_REASON);
  });

  it('wraps the two days onto a second line rather than running the last one off the edge', () => {
    renderToolbar();
    expect(screen.getByRole('group', { name: 'Day range' })).toHaveClass('flex-wrap');
  });

  it('states no such reason while the days are live', () => {
    renderToolbar();
    expect(screen.queryByText(RANGE_OFF_REASON)).not.toBeInTheDocument();
  });
});

describe('GrowthFilters range refusal', () => {
  it('states a refused range where the operator can see it', () => {
    renderToolbar({ refusal: 'Pick a range of at most 92 days.' });
    expect(screen.getByText('Pick a range of at most 92 days.')).toBeInTheDocument();
  });

  it('announces the refusal rather than only drawing it', () => {
    renderToolbar({ refusal: 'Pick a range of at most 92 days.' });
    expect(screen.getByRole('status')).toHaveTextContent('Pick a range of at most 92 days.');
  });

  it('states nothing where the range was not refused', () => {
    renderToolbar();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('GrowthFilters status line', () => {
  it('states how far the data reaches once its read has answered', () => {
    renderToolbar();
    expect(statusLine()).toHaveTextContent('Data runs through 2026-09-19.');
  });

  it('states the code a failed freshness read carried, in monospace', () => {
    renderToolbar({ edge: { state: 'failed', code: 'UNAVAILABLE' } });
    const code = screen.getByText('UNAVAILABLE');
    expect(code.tagName).toBe('CODE');
    expect(code).toHaveClass('font-mono');
  });

  it('says a failed freshness read failed rather than that the data stops early', () => {
    renderToolbar({ edge: { state: 'failed', code: 'UNAVAILABLE' } });
    expect(statusLine()).toHaveTextContent('how far the data reaches is unknown');
    expect(statusLine()).not.toHaveTextContent('runs through');
  });

  it('draws a skeleton in place of the sentence while the freshness read is in flight', () => {
    renderToolbar({ edge: { state: 'pending' } });
    expect(statusLine().querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(statusLine().querySelector('[data-slot="data-edge-note"]')).toBeNull();
  });

  it('keeps that skeleton inside the line rather than past the column it sits in', () => {
    renderToolbar({ edge: { state: 'pending' } });
    expect(statusLine().querySelector('[data-slot="async-region"]')?.parentElement).toHaveClass(
      'max-w-full'
    );
  });

  it('marks the freshness line busy while its read is in flight', () => {
    renderToolbar({ edge: { state: 'pending' } });
    expect(screen.getByRole('group', { name: 'How current this data is' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });

  it('says the figures are as the database holds them now, whatever the freshness read did', () => {
    renderToolbar({ edge: { state: 'pending' } });
    expect(statusLine()).toHaveTextContent(/reflect the database now/);
  });

  it('carries the clause saying no control narrows the day it states', () => {
    renderToolbar();
    expect(statusLine()).toHaveTextContent(
      panelScopeNote({ campaigns: DATA_EDGE_NO_CAMPAIGN, window: { kind: 'unwindowed' } }) ?? ''
    );
  });

  it('says the page was read just now when it was', () => {
    renderToolbar();
    expect(statusLine()).toHaveTextContent('Read just now');
  });

  it('says how many minutes ago the page was read', () => {
    renderToolbar({ readAt: TEST_DAY_START - 5 * MINUTE_MS });
    expect(statusLine()).toHaveTextContent('Read 5 min ago');
  });

  it('says how many hours ago the page was read', () => {
    renderToolbar({ readAt: TEST_DAY_START - 3 * HOUR_MS });
    expect(statusLine()).toHaveTextContent('Read 3 h ago');
  });

  it('ages the read on its own, without the page being touched', () => {
    renderToolbar();
    expect(statusLine()).toHaveTextContent('Read just now');
    act(() => {
      vi.advanceTimersByTime(2 * MINUTE_MS);
    });
    expect(statusLine()).toHaveTextContent('Read 2 min ago');
  });

  it('says what another round of reads costs', () => {
    renderToolbar();
    expect(statusLine()).toHaveTextContent('each refresh spends another round of reads');
  });
});

describe('GrowthFilters refresh', () => {
  it('spends another round of reads when asked to', async () => {
    const onRefresh = vi.fn();
    renderToolbar({ onRefresh });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('GrowthFilters campaign selection', () => {
  it('holds the campaign multi-select in the toolbar', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: /^Campaigns/ })).toBeInTheDocument();
  });

  it('reports the campaign an operator chooses', async () => {
    const onCampaignToggle = vi.fn();
    renderToolbar({ onCampaignToggle });
    await userEvent.click(screen.getByRole('button', { name: /^Campaigns/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'hn-launch' }));
    expect(onCampaignToggle).toHaveBeenCalledWith('hn-launch', true);
  });
});
