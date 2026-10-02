import * as React from 'react';

import { Skeleton } from '../primitives/skeleton';
import { cn } from '../../lib/utilities';

/** How much room a panel holds, by the size of the body it draws. */
type PanelReserve = 'short' | 'medium' | 'tall';

/**
 * The room each size holds, and how many bars the loading ladder fills it with.
 *
 * The room sits on the body rather than on the skeleton, so a panel holds it
 * while its read is in flight, after the read fails, and after it draws. That
 * last state is the point: a page whose reads land one by one moves every
 * figure below a panel that grew, and a panel that drew less than it holds
 * settles into its room rather than jumping back up. Holding room is an
 * approximation of what a panel will occupy rather than a claim about it — too
 * little costs a smaller movement than none at all, too much costs dead space
 * at the foot of the panel in every one of those states — so the sizes are
 * floors rather than targets, each a little under the 100 / 300 / 520 pixels of
 * panel it stands for at the default text size. They are spacing-scale rem
 * rather than pixels so the room scales with the accessibility widget's
 * font-scaling tier, which an absolute height would not.
 */
const PANEL_RESERVE = {
  /** A sentence or two. */
  short: { room: 'min-h-14', bars: 2 },
  /** A handful of rows, a set of tiles, or a plot. */
  medium: { room: 'min-h-60', bars: 9 },
  /** A long table, a ladder of bars, or a map. */
  tall: { room: 'min-h-112', bars: 18 },
} as const satisfies Record<PanelReserve, { room: string; bars: number }>;

/**
 * The element a panel's title is drawn as, per level.
 *
 * Two levels because those are the depths this frame's callers sit at: a panel
 * directly under a screen's title, and one under a section heading inside it.
 * A caller nesting deeper adds its level here, which widens the union below
 * with it.
 */
const HEADING_TAG = { 2: 'h2', 3: 'h3' } as const;

/** How deep in the document a panel's title sits. */
type PanelHeadingLevel = keyof typeof HEADING_TAG;

interface PanelFrameProps {
  readonly title: string;
  readonly loading?: boolean | undefined;
  /** The panel's own failure code — it failed independently of its siblings. */
  readonly error?: string | undefined;
  readonly errorTestId?: string | undefined;
  /**
   * What the panel's figures are scoped to, beside the title: the clause a
   * reader needs before trusting a figure belongs in view rather than in the
   * body.
   */
  readonly scope?: React.ReactNode | undefined;
  /** The panel's own controls, right-aligned in the header row. */
  readonly actions?: React.ReactNode | undefined;
  /**
   * How much room this panel holds, by the size of the body it will draw. A
   * panel that declares none draws a two-bar placeholder and holds no room.
   */
  readonly reserves?: PanelReserve | undefined;
  /**
   * How deep the panel's title sits in the document outline. A panel nested
   * under a section heading names the level below it, so the outline states
   * that the panel is inside that section rather than beside it.
   */
  readonly headingLevel?: PanelHeadingLevel | undefined;
  readonly children?: React.ReactNode;
}

function PanelSkeleton({
  reserves,
}: Readonly<{ reserves?: PanelReserve | undefined }>): React.JSX.Element {
  const held = reserves === undefined ? undefined : PANEL_RESERVE[reserves];
  return (
    <div data-slot="panel-frame-skeleton" aria-hidden="true" className="flex grow flex-col gap-2">
      {held === undefined ? (
        <>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </>
      ) : (
        Array.from({ length: held.bars }, (_, index) => <Skeleton key={index} className="grow" />)
      )}
    </div>
  );
}

function PanelBody({
  loading,
  error,
  errorTestId,
  reserves,
  children,
}: Readonly<
  Pick<PanelFrameProps, 'loading' | 'error' | 'errorTestId' | 'reserves' | 'children'>
>): React.JSX.Element {
  if (loading === true) {
    return <PanelSkeleton reserves={reserves} />;
  }
  if (error !== undefined) {
    return (
      <p
        data-slot="panel-frame-error"
        data-testid={errorTestId}
        className="text-destructive text-sm"
      >
        Failed to load <span className="font-mono text-xs">{error}</span>
      </p>
    );
  }
  return <>{children}</>;
}

/**
 * One titled panel that loads and fails on its own: a per-panel skeleton and an
 * inline error, so one broken panel never blanks the page around it. The header
 * row carries the title, what the figures are scoped to, and the panel's own
 * controls, so none of the three spends a row of the body.
 */
function PanelFrame({
  title,
  loading,
  error,
  errorTestId,
  scope,
  actions,
  reserves,
  headingLevel,
  className,
  children,
  ...props
}: Readonly<React.ComponentProps<'section'> & PanelFrameProps>): React.JSX.Element {
  const Heading = HEADING_TAG[headingLevel ?? 2];
  return (
    <section
      data-slot="panel-frame"
      className={cn('border-border bg-card flex flex-col rounded-md border', className)}
      {...props}
    >
      <div
        data-slot="panel-frame-header"
        className="border-border flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2.5 py-2"
      >
        <Heading className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {title}
        </Heading>
        {scope !== undefined && (
          <div data-slot="panel-frame-scope" className="flex flex-wrap items-center gap-1.5">
            {scope}
          </div>
        )}
        {actions !== undefined && (
          <div data-slot="panel-frame-actions" className="ml-auto flex items-center gap-1">
            {actions}
          </div>
        )}
      </div>
      <div
        data-slot="panel-frame-body"
        className={cn(
          'flex grow flex-col p-2.5',
          reserves === undefined ? undefined : PANEL_RESERVE[reserves].room
        )}
      >
        <PanelBody loading={loading} error={error} errorTestId={errorTestId} reserves={reserves}>
          {children}
        </PanelBody>
      </div>
    </section>
  );
}

export { PanelFrame };
