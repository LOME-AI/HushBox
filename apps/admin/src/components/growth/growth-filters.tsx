import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  Button,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@hushbox/ui';
import { InlineInput, SelectField } from '@hushbox/ui/field';
import { useFormFactor } from '@hushbox/ui/platform';
import { AsyncRegion } from '@hushbox/ui/surface';
import { HOUR_MS, MINUTE_MS } from '@hushbox/shared/durations';
import { CampaignFilter, countLabel } from './campaign-filter.js';
import { dayOf, formatWeekLabel } from './growth-window.js';
import { DATA_EDGE_NO_CAMPAIGN, panelScopeNote } from './panel-scope.js';
import type { DataEdgeStatus } from './data-edge.js';
import type { DayRange } from './growth-window.js';
import type { GrowthCampaignWire, GrowthGrain } from '@hushbox/shared';

/**
 * Why the day range reaches no panel at the hour grain. Behind a tooltip on the
 * range's own wrapper rather than a full-width sentence under the toolbar, and
 * linked from both day controls by `aria-describedby`, so the reason arrives
 * with the control it is about instead of only being on the page somewhere.
 */
const RANGE_OFF_REASON = 'The hour grain reads the week selected, so the day range is off.';

/**
 * What no control on the page narrows about the day the status line states,
 * in the clause every panel states its own scope in. Derived rather than
 * written again here: the freshness read is keyed with no window and no
 * campaign, which is the same fact `panel-scope.ts` phrases for a panel.
 */
const EDGE_SCOPE_CLAUSE =
  panelScopeNote({ campaigns: DATA_EDGE_NO_CAMPAIGN, window: { kind: 'unwindowed' } }) ?? '';

/** How often the read age is recomputed, which is also the coarsest unit it states. */
const READ_AGE_TICK_MS = MINUTE_MS;

/**
 * How long ago the page spent its reads, coarse on purpose: the figure exists
 * to say whether the figures on screen are minutes or hours old, and a
 * seconds-resolution phrase would move while it is being read.
 */
function readAgeLabel(ageMs: number): string {
  if (ageMs < MINUTE_MS) return 'just now';
  if (ageMs < HOUR_MS) return `${String(Math.floor(ageMs / MINUTE_MS))} min ago`;
  return `${String(Math.floor(ageMs / HOUR_MS))} h ago`;
}

/**
 * What the page says about how current its data is, kept as three states
 * rather than one sentence: a skeleton while the read is in flight, the code
 * a refusal carried, or the sentence itself. A failure that drew the sentence
 * would read as the data stopping early, which is the reading this line exists
 * to prevent.
 */
function DataEdgeStatusLine({ edge }: Readonly<{ edge: DataEdgeStatus }>): React.JSX.Element {
  if (edge.state === 'pending') {
    return (
      <span>
        {/* Capped at the line's own width: 12rem outruns a narrow column once
            the widget's largest type scale is on. */}
        <span className="inline-block w-48 max-w-full align-middle">
          <AsyncRegion
            status="pending"
            label="How current this data is"
            placeholder={[{ kind: 'line', width: '100%' }]}
          >
            {null}
          </AsyncRegion>
        </span>
        <span className="sr-only">Reading how current this data is.</span>
      </span>
    );
  }
  if (edge.state === 'failed') {
    return (
      <span className="text-destructive">
        The freshness read failed with <code className="font-mono">{edge.code}</code>, so how far
        the data reaches is unknown. Refresh to try again.
      </span>
    );
  }
  return (
    <span>
      <span data-slot="data-edge-note">{edge.note}</span>{' '}
      <Tooltip>
        <TooltipTrigger className="underline decoration-dotted underline-offset-2">
          Not narrowed by the controls.
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{EDGE_SCOPE_CLAUSE}</TooltipContent>
      </Tooltip>
      <span className="sr-only">{EDGE_SCOPE_CLAUSE}</span>
    </span>
  );
}

/**
 * The two days a read covers, with both sentences that belong beside them: why
 * they reach no panel at the hour grain, and why the days on screen are not the
 * days being read.
 */
function DayRangeField({
  range,
  onRangeChange,
  off,
  refusal,
}: Readonly<{
  readonly range: DayRange;
  readonly onRangeChange: (range: DayRange) => void;
  /** Whether the grain in force reads the week instead, leaving these days idle. */
  readonly off: boolean;
  readonly refusal: string | null;
}>): React.JSX.Element {
  const startId = React.useId();
  const endId = React.useId();
  const reasonId = React.useId();

  const pair = (
    <div
      role="group"
      aria-label="Day range"
      // Wrapping rather than one line: at the widget's largest type the pair is
      // wider than a narrow viewport's column, and a fixed line put the second
      // field past the right edge, reachable only by scrolling sideways.
      className="flex flex-wrap items-end gap-2"
      // A disabled input emits no hover and takes no focus, so the wrapper is
      // what carries the reason and what a keyboard reaches it through.
      {...(off && { tabIndex: 0 })}
    >
      <div className="flex flex-col gap-1">
        <label
          id={`${startId}-label`}
          htmlFor={startId}
          className="text-muted-foreground text-xs font-medium"
        >
          From
        </label>
        <InlineInput
          id={startId}
          aria-labelledby={`${startId}-label`}
          type="date"
          className="h-8 w-[8.5rem] text-sm"
          value={range.start}
          disabled={off}
          {...(off && { 'aria-describedby': reasonId })}
          onChange={(event) => {
            onRangeChange({ ...range, start: event.target.value });
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          id={`${endId}-label`}
          htmlFor={endId}
          className="text-muted-foreground text-xs font-medium"
        >
          To
        </label>
        <InlineInput
          id={endId}
          aria-labelledby={`${endId}-label`}
          type="date"
          className="h-8 w-[8.5rem] text-sm"
          value={range.end}
          disabled={off}
          {...(off && { 'aria-describedby': reasonId })}
          onChange={(event) => {
            onRangeChange({ ...range, end: event.target.value });
          }}
        />
      </div>
      {off && (
        <p id={reasonId} className="sr-only">
          {RANGE_OFF_REASON}
        </p>
      )}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {off ? (
        <Tooltip>
          <TooltipTrigger asChild>{pair}</TooltipTrigger>
          <TooltipContent className="max-w-xs">{RANGE_OFF_REASON}</TooltipContent>
        </Tooltip>
      ) : (
        pair
      )}
      {refusal !== null && (
        <p role="status" className="text-destructive text-xs">
          {refusal}
        </p>
      )}
    </div>
  );
}

/**
 * The one press that puts the scoping controls out where the viewport is too
 * short to hold them open, and what it states about them while they are away.
 *
 * A count rides the trigger because the control that states it is behind it: a
 * panel the selection narrows states nothing — the moving figures are its
 * statement — so a folded page narrowed to a campaign would otherwise carry no
 * statement of that narrowing anywhere on screen.
 */
function ScopeFold({
  open,
  controlsId,
  campaignCount,
  onToggle,
}: Readonly<{
  readonly open: boolean;
  readonly controlsId: string;
  /** How much of the campaign list the selection covers, or null where it covers all of it. */
  readonly campaignCount: string | null;
  readonly onToggle: () => void;
}>): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="outline"
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      Filters
      {campaignCount !== null && (
        <span className="text-muted-foreground">
          {campaignCount}
          <span className="sr-only"> campaigns</span>
        </span>
      )}
      {open ? (
        <ChevronUp aria-hidden="true" className="size-3.5" />
      ) : (
        <ChevronDown aria-hidden="true" className="size-3.5" />
      )}
    </Button>
  );
}

/**
 * The page's toolbar: every control that scopes a read, and the two facts a
 * reader needs before trusting a figure below it.
 *
 * Refresh is a button rather than an interval because a read costs the actor
 * the same hourly budget its mutations come out of; a page that refetched on
 * its own would spend an operator's allowance while they read it, which is why
 * the status line says what another round costs rather than leaving it tacit.
 *
 * The day controls carry no `min` or `max`: a range the reads cannot serve is
 * refused here in words, and a browser that clamped the value first would leave
 * that sentence unreachable.
 */
export function GrowthFilters({
  weeks,
  selectedWeek,
  onWeekChange,
  grain,
  onGrainChange,
  range,
  onRangeChange,
  campaigns,
  selectedCampaigns,
  onCampaignToggle,
  refusal,
  edge,
  readAt,
  onRefresh,
}: Readonly<{
  readonly weeks: readonly Date[];
  readonly selectedWeek: string;
  readonly onWeekChange: (week: string) => void;
  readonly grain: GrowthGrain;
  readonly onGrainChange: (grain: GrowthGrain) => void;
  readonly range: DayRange;
  readonly onRangeChange: (range: DayRange) => void;
  readonly campaigns: readonly GrowthCampaignWire[];
  readonly selectedCampaigns: readonly string[];
  readonly onCampaignToggle: (tag: string, chosen: boolean) => void;
  /** Why the days shown are not the days being read, or null where they are. */
  readonly refusal: string | null;
  /** What the read behind the freshness sentence has done. */
  readonly edge: DataEdgeStatus;
  /** When the page last spent a round of reads, as an epoch instant. */
  readonly readAt: number;
  readonly onRefresh: () => void;
}>): React.JSX.Element {
  const grainLabelId = React.useId();
  const scopeId = React.useId();

  // Below the shared mobile breakpoint every control takes a row of its own, so
  // the six of them plus the status line fill a short viewport at the widget's
  // largest type and leave no panel above the fold. There the controls fold
  // behind one disclosure and the toolbar stops being sticky, because an
  // unfolded toolbar pinned to the top would take the viewport back. At every
  // width an operator works at, neither applies and the row is unchanged.
  const narrow = useFormFactor().band === 'phone';
  const [scopeOpen, setScopeOpen] = React.useState(false);

  // The age is the one thing here that changes with no operator action, so the
  // toolbar keeps its own clock; nothing else on the page reads it.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, READ_AGE_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // At the hour grain the series reads the week the picker names, so the day
  // range reaches no panel. Left live it would be a control an operator can set
  // and see nothing move anywhere, which is the confusion every panel's scope
  // note exists to prevent.
  const rangeOff = grain === 'hour';

  const scopeShown = !narrow || scopeOpen;

  // The phrase the week is named by is longer than a narrow viewport's whole
  // content column at the widget's largest type scale, and a trigger holding it
  // clipped the day's last digits — a date that looks complete and is not. The
  // field's own label above the trigger says which control this is, so the day
  // alone loses nothing there; the phrase stays where it is read without that
  // label, in the list of weeks.
  const weekStart = new Date(selectedWeek);
  const weekLabel = narrow ? dayOf(weekStart) : formatWeekLabel(weekStart);

  // A refusal is the sentence saying why the figures on screen are not the days
  // asked for, so it cannot be folded away. It sits beside the field it is
  // about wherever that field is on screen, and on a line of its own where the
  // fold has taken the field — one of the two, never both, so the page states
  // it once.
  const refusalFolded = !scopeShown && refusal !== null;

  // Folded, the campaign trigger goes with the rest of the scoping controls and
  // takes its count with it, and a panel the selection does narrow states
  // nothing — a narrowed page would read with nothing on screen saying so. The
  // disclosure carries the count while it holds the control that would.
  const foldedCampaignCount =
    !scopeShown && selectedCampaigns.length > 0
      ? countLabel(campaigns.length, selectedCampaigns.length)
      : null;

  const scopeControls = (
    <>
      {/* `min-w-0` so the row can shrink this column: the trigger's width is a
          fixed rem figure, which the widget's largest type scale turns into
          more than a narrow viewport's whole content column. */}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-muted-foreground text-xs">Week</span>
        <div data-slot="growth-week-field" className="w-44 max-w-full">
          <SelectField
            label="Week"
            labelHidden
            size="sm"
            value={selectedWeek}
            onValueChange={onWeekChange}
            options={weeks.map((week) => ({
              value: week.toISOString(),
              label: formatWeekLabel(week),
            }))}
            triggerText={weekLabel}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span id={grainLabelId} className="text-muted-foreground text-xs">
          Grain
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-labelledby={grainLabelId}
          value={grain}
          // A single-select toggle group reports an empty value when the
          // chosen item is pressed again; the series is read at one grain or
          // the other, so that press keeps the grain it has.
          onValueChange={(value) => {
            if (value === 'day' || value === 'hour') onGrainChange(value);
          }}
        >
          <ToggleGroupItem value="day" className="px-3 text-sm">
            Day
          </ToggleGroupItem>
          <ToggleGroupItem value="hour" className="px-3 text-sm">
            Hour
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <DayRangeField
        range={range}
        onRangeChange={onRangeChange}
        off={rangeOff}
        refusal={refusalFolded ? null : refusal}
      />

      <CampaignFilter
        campaigns={campaigns}
        selected={selectedCampaigns}
        onToggle={onCampaignToggle}
      />
    </>
  );

  return (
    <div
      data-slot="growth-toolbar"
      data-chrome=""
      className="bg-background border-border z-10 border-b md:sticky md:top-0"
    >
      <div className="flex flex-wrap items-end gap-3 px-4 pt-3">
        <h1 className="mr-1 text-[1.2rem] font-bold">Growth</h1>

        {narrow ? (
          <ScopeFold
            open={scopeShown}
            controlsId={scopeId}
            campaignCount={foldedCampaignCount}
            onToggle={() => {
              setScopeOpen((open) => !open);
            }}
          />
        ) : (
          scopeControls
        )}

        <Button size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      {narrow && (
        <div id={scopeId} hidden={!scopeShown} className="flex flex-wrap items-end gap-3 px-4 pt-3">
          {scopeControls}
        </div>
      )}

      {refusalFolded && (
        <p role="status" className="text-destructive px-4 pt-1.5 text-xs">
          {refusal}
        </p>
      )}

      {/*
        On a line of its own rather than beside the controls: these sentences
        are longer than any control, and sharing the row made a wrapping
        sentence set the height of the whole toolbar.
      */}
      <div
        data-slot="growth-status"
        className="text-muted-foreground px-4 pt-1.5 pb-2.5 text-right text-xs leading-snug"
      >
        <DataEdgeStatusLine edge={edge} />
        {' \u00B7 '}
        <span>
          Figures reflect the database now, not as of the week: a refund yesterday changes last
          week&rsquo;s revenue.
        </span>
        {' \u00B7 '}
        <span>Read {readAgeLabel(now - readAt)}; each refresh spends another round of reads.</span>
      </div>
    </div>
  );
}
