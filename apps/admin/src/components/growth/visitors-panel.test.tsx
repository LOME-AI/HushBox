import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DAY_MS, HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { VisitorsPanel } from './visitors-panel.js';
import type { Area, XAxis } from 'recharts';

// Recharts' ResponsiveContainer measures its box and clones the chart with the
// result; the test DOM has no layout engine, so it measures zero and the chart
// warns and draws nothing. The stub hands it fixed dimensions instead (the same
// approach the product app's chart tests take).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 220 }}>
        {React.cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
          width: 800,
          height: 220,
        })}
      </div>
    ),
    AreaChart: (props: React.ComponentProps<typeof actual.AreaChart>) => {
      plotted = (props.data ?? []) as Record<string, unknown>[];
      return <actual.AreaChart {...props} />;
    },
    // The series' own props are what say it is a filled line rather than a bar
    // per bucket, and recharts draws them into SVG the test DOM cannot measure.
    Area: (props: React.ComponentProps<typeof actual.Area>) => {
      series = props;
      return <actual.Area {...props} />;
    },
    XAxis: (props: React.ComponentProps<typeof actual.XAxis>) => {
      xAxis = props;
      return <actual.XAxis {...props} />;
    },
    // Recharts drives its tooltip from a pointer position the test DOM never
    // produces. The stub renders the wired content with the entry recharts
    // would hand it for the first point — the plotted number, and the datum
    // that point was read from, taken from the chart's own data rather than
    // written here, so what the panel puts on a datum is what the tooltip sees.
    Tooltip: ({
      content,
      cursor,
    }: {
      content: React.ReactElement<Record<string, unknown>>;
      cursor?: unknown;
    }): React.ReactElement | null => {
      tooltipCursor = cursor;
      const [first] = plotted;
      if (first === undefined) return null;
      return (
        <>
          <div data-slot="visitors-tooltip">
            {React.cloneElement(content, {
              active: true,
              payload: [{ dataKey: 'visitors', value: first['visitors'], payload: first }],
            })}
          </div>
          {/* The datum on a tooltip entry is optional in the chart primitive's
              own contract, so the panel is rendered against an entry without
              one too. */}
          <div data-slot="visitors-tooltip-without-datum">
            {React.cloneElement(content, {
              active: true,
              payload: [{ dataKey: 'visitors', value: first['visitors'] }],
            })}
          </div>
        </>
      );
    },
  };
});

/** The data the chart was handed on the last render, as recharts received it. */
let plotted: Record<string, unknown>[] = [];

/** The series' props on the last render, as recharts received them. */
let series: React.ComponentProps<typeof Area> | undefined;

/** What the tooltip was told to draw at the hovered bucket, if anything. */
let tooltipCursor: unknown;

/** The bucket axis' props on the last render, as recharts received them. */
let xAxis: React.ComponentProps<typeof XAxis> | undefined;

/** The series' props, or a failure naming what was not drawn. */
function seriesProps(): React.ComponentProps<typeof Area> {
  if (series === undefined) throw new Error('no area series was drawn');
  return series;
}

/** The real table the chart ships beside the plot, which the tooltip echoes. */
function dataTable(): HTMLElement {
  const node = document.querySelector('[data-slot="chart-data-table"]');
  if (node === null) throw new Error('no data table was rendered');
  return node as HTMLElement;
}

function tooltip(): HTMLElement {
  const node = document.querySelector('[data-slot="visitors-tooltip"]');
  if (node === null) throw new Error('no tooltip was rendered');
  return node as HTMLElement;
}

/** The same tooltip rendered against an entry carrying no datum at all. */
function tooltipWithoutDatum(): HTMLElement {
  const node = document.querySelector('[data-slot="visitors-tooltip-without-datum"]');
  if (node === null) throw new Error('no tooltip was rendered');
  return node as HTMLElement;
}

const POINTS = [
  { bucket: isoAt(TEST_DAY_START), visitors: 100, overflow: false },
  { bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 140, overflow: false },
];

describe('VisitorsPanel', () => {
  it('names the figure by the bucketing each point was counted in', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(screen.getByRole('heading', { name: 'Visitors (daily uniques)' })).toBeInTheDocument();
  });

  it('changes the name when the grain changes', () => {
    render(<VisitorsPanel points={POINTS} grain="hour" />);
    expect(screen.getByRole('heading', { name: 'Visitors (hourly uniques)' })).toBeInTheDocument();
  });

  it('offers every point as a real table row', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(POINTS.length + 1);
  });

  it('states the direction of travel in the caption', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(screen.getByText(/rose/i)).toBeInTheDocument();
  });

  it('says the trend fell when it did', () => {
    render(
      <VisitorsPanel
        points={[
          { bucket: isoAt(TEST_DAY_START), visitors: 140, overflow: false },
          { bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 100, overflow: false },
        ]}
        grain="day"
      />
    );
    expect(screen.getByText(/fell/i)).toBeInTheDocument();
  });

  it('marks a bucket the ceiling cut off as a floor in the table', () => {
    render(
      <VisitorsPanel
        points={[{ bucket: isoAt(TEST_DAY_START), visitors: 100_000, overflow: true }]}
        grain="day"
      />
    );
    expect(within(dataTable()).getByText('100,000+')).toBeInTheDocument();
  });

  it('says nothing was counted when there are no points', () => {
    render(<VisitorsPanel points={[]} grain="day" />);
    expect(screen.getByText(/Nothing was counted/i)).toBeInTheDocument();
  });
});

describe('VisitorsPanel with a single point', () => {
  it('says the figure held steady when there is no second point to compare', () => {
    render(
      <VisitorsPanel
        points={[{ bucket: isoAt(TEST_DAY_START), visitors: 100, overflow: false }]}
        grain="day"
      />
    );
    expect(screen.getByText(/held steady/i)).toBeInTheDocument();
  });

  it('says the figure held steady when it started and ended level', () => {
    render(
      <VisitorsPanel
        points={[
          { bucket: isoAt(TEST_DAY_START), visitors: 100, overflow: false },
          { bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 100, overflow: false },
        ]}
        grain="day"
      />
    );
    expect(screen.getByText(/held steady/i)).toBeInTheDocument();
  });

  it('labels an hour-grain bucket with more than the day a day-grain bucket carries', () => {
    const bucket = isoAt(TEST_DAY_START + 10 * HOUR_MS);
    const day = isoAt(TEST_DAY_START).slice(0, 10);
    const points = [{ bucket, visitors: 100, overflow: false }];

    const { unmount } = render(<VisitorsPanel points={points} grain="day" />);
    const dayLabel = screen.getByRole('rowheader').textContent;
    unmount();

    render(<VisitorsPanel points={points} grain="hour" />);
    const hourLabel = screen.getByRole('rowheader').textContent;

    expect(dayLabel).toBe(day);
    expect(hourLabel.startsWith(day)).toBe(true);
    expect(hourLabel.length).toBeGreaterThan(dayLabel.length);
  });
});

describe('VisitorsPanel data table spacing', () => {
  // Without padding between the two cells of a row, a bucket's date runs
  // straight into its count and reads as one longer number.
  it('holds each bucket clear of the count beside it', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    const [bucket, count] = within(dataTable()).getAllByRole('row')[1]?.children ?? [];
    expect(bucket?.className).toContain('pr-2');
    expect(count?.className).toContain('pl-2');
  });
});

describe('VisitorsPanel data table naming', () => {
  it('names the figures column as the caption above it names them', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(
      screen.getByRole('columnheader', { name: 'Visitors (daily uniques)' })
    ).toBeInTheDocument();
  });
});

describe('VisitorsPanel measurement claims', () => {
  it('claims no summing on any surface, because each point is one bucket alone', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(screen.queryByText(/summed/i)).toBeNull();
  });

  it('warns that adding the buckets up would count a returning visitor more than once', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(
      screen.getByText(/adding the buckets up counts a returning visitor once per bucket/i)
    ).toBeInTheDocument();
  });

  it('names the plot region with the figure across the buckets it covers', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(
      screen.getByRole('img', { name: /Visitors \(daily uniques\) across 2 buckets/ })
    ).toBeInTheDocument();
  });
});

describe('VisitorsPanel tooltip', () => {
  it('marks a bucket the ceiling cut off as a floor, as the data table does', () => {
    render(
      <VisitorsPanel
        points={[{ bucket: isoAt(TEST_DAY_START), visitors: 100_000, overflow: true }]}
        grain="day"
      />
    );
    expect(within(tooltip()).getByText('100,000+')).toBeInTheDocument();
  });

  it('leaves a bucket inside its ceiling unmarked', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(within(tooltip()).getByText('100')).toBeInTheDocument();
  });

  it('names the figure as the table beside it names it', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(within(tooltip()).getByText('Visitors (daily uniques)')).toBeInTheDocument();
  });
});

describe('what VisitorsPanel puts on a chart datum', () => {
  it('keeps the ceiling flag off it, because recharts copies a datum onto the bar element', () => {
    render(
      <VisitorsPanel
        points={[{ bucket: isoAt(TEST_DAY_START), visitors: 100_000, overflow: true }]}
        grain="day"
      />
    );
    expect(
      plotted.map((datum) => Object.keys(datum).toSorted((one, other) => one.localeCompare(other)))
    ).toEqual([['label', 'visitors']]);
  });
});

describe('VisitorsPanel tooltip without a datum', () => {
  it('states the figure plainly, because an absent flag is not a reading of none', () => {
    render(
      <VisitorsPanel
        points={[{ bucket: isoAt(TEST_DAY_START), visitors: 100_000, overflow: true }]}
        grain="day"
      />
    );
    expect(within(tooltipWithoutDatum()).getByText('100,000')).toBeInTheDocument();
  });
});

describe('how VisitorsPanel draws ninety buckets', () => {
  it('draws one filled line rather than a bar for every bucket', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(plotted).toHaveLength(POINTS.length);
    expect(seriesProps().dataKey).toBe('visitors');
  });

  it('fills under the line in the same token the line is stroked in', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    const props = seriesProps();
    expect(props.stroke).toBe(props.fill);
    expect(props.stroke).toMatch(/^var\(--/);
  });

  it('washes that fill back, so the line rather than the area is the mark', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(Number(seriesProps().fillOpacity)).toBeLessThan(1);
  });

  it('draws no dot per bucket, which ninety of would read as noise', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(seriesProps().dot).toBe(false);
  });

  it('marks the hovered bucket with a crosshair drawn from a token', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(tooltipCursor).toEqual(expect.objectContaining({ stroke: expect.any(String) }));
    expect((tooltipCursor as { stroke: string }).stroke).toMatch(/^var\(--/);
  });
});

describe('VisitorsPanel inside a panel card', () => {
  it('draws no card of its own, because the panel around it is already one', () => {
    const { container } = render(<VisitorsPanel points={POINTS} grain="day" />);
    const chart = container.querySelector('[data-slot="recharts-chart"]');
    expect(chart).not.toBeNull();
    // The frame merges what it is handed over its own classes, so the reading
    // that matters is what survives the merge: the bare `border` utility is the
    // card's hairline, and `border-border` is only a colour for a width that is
    // now zero.
    const classes = (chart as HTMLElement).className;
    expect(classes).not.toMatch(/(^|\s)border(\s|$)/);
    expect(classes).not.toMatch(/\bbg-card\b/);
    expect(classes).not.toMatch(/\brounded-md\b/);
    expect(classes).not.toMatch(/\bp-3\b/);
  });
});

describe('where VisitorsPanel sits in the document outline', () => {
  it('sets the chart title a level below the panel heading, so the chart reads as inside its panel', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(
      screen.getByRole('heading', { level: 4, name: 'Visitors (daily uniques)' })
    ).toBeInTheDocument();
  });
});

describe('how VisitorsPanel spaces the bucket axis', () => {
  it('holds ticks apart by more than recharts own default, which drew two dates over each other', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(Number(xAxis?.minTickGap)).toBeGreaterThan(5);
  });

  it('keeps the first and last bucket, so the range the caption speaks of is the range drawn', () => {
    render(<VisitorsPanel points={POINTS} grain="day" />);
    expect(xAxis?.interval).toBe('preserveStartEnd');
  });
});
