import * as React from 'react';
import { PanelFrame, Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { ApiError } from '@/lib/api-client';
import { panelScopeChips, panelScopeNote } from './panel-scope.js';
import type { PanelScope } from './panel-scope.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Which shape of body a panel holds room for. Taken off {@link PanelFrame}
 * rather than declared here, because the frame holds the room: the union is not
 * exported, and spelling it again would be two names for one set. Stripped of
 * `undefined` so this panel's own prop can stay required while the frame's
 * stays optional.
 */
type PanelReserve = NonNullable<React.ComponentProps<typeof PanelFrame>['reserves']>;

/**
 * How a section lays its panels out: twelve columns where the room allows, one
 * below that, and every item free to shrink under its own content.
 *
 * That last part is the load-bearing one. A grid item's automatic minimum is
 * its content's minimum width, so one panel holding a wide table made its
 * track wider than the screen and left the whole page scrolling sideways at a
 * narrow viewport under a scaled font. The items may shrink instead, and a
 * panel with more than fits bounds its own content.
 *
 * Twelve columns rather than two so a section can pair its panels unevenly:
 * which of a pair takes more of the row is a judgement about which one is read
 * first, and it lives at the call site as each panel's {@link PanelSpan}.
 */
export const PANEL_GRID = 'grid items-start gap-3 *:min-w-0 lg:grid-cols-12';

/**
 * How many of the grid's columns a panel takes at the desktop breakpoint, by
 * the number of them, with `full` for a panel that pairs with nothing and takes
 * the row. Spelled beside the grid's own column count so a span cannot name
 * more columns than there are; below that breakpoint the grid is a single
 * column and none of these apply.
 */
const PANEL_SPAN = {
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  8: 'lg:col-span-8',
  full: 'lg:col-span-full',
} as const;

/** How much of its section's row a panel takes. */
export type PanelSpan = keyof typeof PANEL_SPAN;

/**
 * Where a Growth panel's title sits in the document outline. Every one of them
 * is drawn inside a section whose heading is level 2, so the title goes a level
 * below that: at the same level the panels would be peers of the sections
 * containing them, and the outline would list each panel beside its section
 * rather than inside it.
 */
const PANEL_HEADING_LEVEL = 3;

/** A panel the server either filled or failed on its own. */
type ServerPanel<T> = { ok: true; data: T } | { ok: false; error: string };

/** A read that answered with a failure, carrying the code it failed with. */
interface FailedRead {
  readonly state: 'failed';
  readonly code: string;
}

/**
 * What a read has done, for a panel that draws on it: still in flight, failed
 * with a code, or answered.
 */
type ReadOutcome = { readonly state: 'pending' } | FailedRead | { readonly state: 'answered' };

interface GrowthPanelProps<Payload, Data> {
  readonly title: string;
  readonly query: UseQueryResult<Payload>;
  readonly panelOf: (payload: Payload) => ServerPanel<Data>;
  readonly render: (data: Data) => React.ReactNode;
  /**
   * The reads this panel draws figures from besides the one it frames, each
   * watched exactly as that one is: any of them still in flight leaves the panel
   * loading, any of them failed states its code.
   *
   * A panel that instead drew such a read through {@link panelDataOr} would
   * render whatever its figures make of no rows, which is the outage read as a
   * fact about the product this frame exists to prevent.
   */
  readonly alsoReads?: readonly ReadOutcome[];
  /**
   * Which of the page's controls reach this panel's read. Required rather than
   * optional: a panel that omitted it would look exactly like one the controls
   * govern, which is the confusion the note exists to remove.
   */
  readonly scope: PanelScope;
  /**
   * The shape of body this panel holds room for, so the page's reads landing one
   * by one do not move every figure below whoever has started reading. Required
   * rather than optional: a panel that declared none would be the one that moves
   * the page, and there is no default that is right for both a sentence and a
   * map.
   */
  readonly reserves: PanelReserve;
  readonly actions?: React.ReactNode;
  /**
   * How much of its section's row this panel takes. Required rather than
   * optional: a grid item that names no column spans one of the twelve, so a
   * panel added with no span would be drawn as a sliver a twelfth of the row
   * wide, and no default is right for both a paired panel and one that takes
   * the whole row.
   */
  readonly span: PanelSpan;
}

/**
 * The data a panel loaded, or the given empty value when the read has not
 * answered or the panel degraded. Used where a control beside the panel needs
 * the rows without repeating the outcome check at every call site.
 */
export function panelDataOr<Payload, Data>(
  query: UseQueryResult<Payload>,
  panelOf: (payload: Payload) => ServerPanel<Data>,
  fallback: Data
): Data {
  if (query.data === undefined) return fallback;
  const panel = panelOf(query.data);
  return panel.ok ? panel.data : fallback;
}

/** The code a failed read carries, so a refusal reads as a refusal on screen. */
function failureCodeOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'INTERNAL';
}

/**
 * What one read has done, for a panel drawing on reads besides the one it
 * frames. The same three outcomes {@link GrowthPanel} reads off its own query,
 * so a figure from either source states the same thing about a failure.
 */
export function readOutcome<Payload, Data>(
  query: UseQueryResult<Payload>,
  panelOf: (payload: Payload) => ServerPanel<Data>
): ReadOutcome {
  if (query.isPending) return { state: 'pending' };
  if (query.isError || query.data === undefined) {
    return { state: 'failed', code: failureCodeOf(query.error) };
  }
  const panel = panelOf(query.data);
  return panel.ok ? { state: 'answered' } : { state: 'failed', code: panel.error };
}

/** A panel standing for its failure, under whichever code it failed with. */
function failedPanel(
  title: string,
  code: string,
  reserves: PanelReserve,
  span: PanelSpan
): React.JSX.Element {
  return (
    <PanelFrame
      title={title}
      headingLevel={PANEL_HEADING_LEVEL}
      error={code}
      errorTestId={TEST_IDS.adminPanelError}
      reserves={reserves}
      className={PANEL_SPAN[span]}
      data-testid={TEST_ID_BUILDERS.adminGrowthPanel('failed')}
    />
  );
}

/**
 * What a panel covers, beside its title: one chip per control that does not
 * reach it, each carrying its whole clause.
 *
 * The chip shows the subject, so what a panel covers is on the panel without a
 * pointer or a keystroke; the reason and the remedy are behind the chip. They
 * are behind a tooltip and in text beside it rather than in the tooltip alone,
 * because a tooltip's content exists only while it is open, and a clause that
 * exists only on hover is one a reader can be in front of and never meet. The
 * chip is the tooltip's trigger, which is a button, so a keyboard reaches every
 * clause the screen states.
 */
function PanelScopeChips({ scope }: Readonly<{ scope: PanelScope }>): React.JSX.Element {
  const note = panelScopeNote(scope);
  return (
    <>
      {panelScopeChips(scope).map((chip) => (
        <Tooltip key={chip.subject}>
          <TooltipTrigger
            data-slot="panel-scope-chip"
            className="border-border bg-muted text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-w-0 rounded-md border px-2 py-0.5 text-left text-xs leading-tight focus-visible:ring-[3px] focus-visible:outline-hidden"
          >
            {chip.subject}
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{chip.clause}</TooltipContent>
        </Tooltip>
      ))}
      {note !== null && (
        <span data-slot="panel-scope-note" className="sr-only">
          {note}
        </span>
      )}
    </>
  );
}

/**
 * One Growth panel, with the two independent ways it can fail kept apart: the
 * read itself refused or never arrived, or the read succeeded and this panel
 * inside it degraded to an error code while its siblings loaded. Both render as
 * a stated failure and neither renders as data.
 *
 * That distinction is the whole reason the reads degrade per panel. A panel
 * that failed and drew a zero would be indistinguishable from a panel that
 * measured nothing, and a reader would act on an outage as if it were a fact
 * about the product. `alsoReads` extends that to a panel whose figures come
 * from more reads than the one it frames.
 */
export function GrowthPanel<Payload, Data>({
  title,
  query,
  panelOf,
  render,
  scope,
  reserves,
  actions,
  alsoReads,
  span,
}: Readonly<GrowthPanelProps<Payload, Data>>): React.JSX.Element {
  const also = alsoReads ?? [];
  if (query.isPending || also.some((read) => read.state === 'pending')) {
    return (
      <PanelFrame
        title={title}
        headingLevel={PANEL_HEADING_LEVEL}
        loading
        reserves={reserves}
        className={PANEL_SPAN[span]}
        data-testid={TEST_ID_BUILDERS.adminGrowthPanel('pending')}
      />
    );
  }
  if (query.isError || query.data === undefined) {
    return failedPanel(title, failureCodeOf(query.error), reserves, span);
  }
  const panel = panelOf(query.data);
  if (!panel.ok) {
    return failedPanel(title, panel.error, reserves, span);
  }
  const failed = also.find((read): read is FailedRead => read.state === 'failed');
  if (failed !== undefined) {
    return failedPanel(title, failed.code, reserves, span);
  }
  const note = panelScopeNote(scope);
  return (
    <PanelFrame
      title={title}
      headingLevel={PANEL_HEADING_LEVEL}
      reserves={reserves}
      scope={note === null ? undefined : <PanelScopeChips scope={scope} />}
      actions={actions}
      className={PANEL_SPAN[span]}
      data-testid={TEST_ID_BUILDERS.adminGrowthPanel('answered')}
    >
      {render(panel.data)}
    </PanelFrame>
  );
}
