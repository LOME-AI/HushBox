'use client';

import * as React from 'react';

import { observeTextMetrics } from '../../lib/observe-text-metrics';
import { cn } from '../../lib/utilities';
import { ButtonRow } from '../button/button-row';
import { Icon } from '../icons/icon';
import { useOverlayPresentation } from '../overlay/overlay-presentation';
import { alertPairClasses } from '../primitives/alert';
import { NoticePlacementContext, type NoticePlacement } from './notice-placement';

type NoticeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'brand';

interface NoticeProps {
  tone: NoticeTone;
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: 'success';
  placement?: NoticePlacement;
  title?: React.ReactNode;
  children?: React.ReactNode;
  end?: React.ReactNode;
  actions?: React.ReactNode;
  /** With `destructive`, selects an Alert pair for an inline notice; other placements ignore both. */
  emphasis?: 'strong' | 'subtle';
  destructive?: boolean;
  live?: 'auto' | 'off';
  'data-testid'?: string;
  /** Tags the text block alone, whose text content is the cause, one space, then the action. */
  textTestId?: string;
}

interface ToneLook {
  edge: string;
  ink: string;
  strip: string;
  disc: string;
}

const TONE_LOOK: Readonly<Record<NoticeTone, ToneLook>> = {
  neutral: {
    edge: 'border-border',
    ink: 'text-muted-foreground',
    strip: 'border-l-muted-foreground',
    disc: 'bg-muted-foreground/14',
  },
  info: { edge: 'border-info/36', ink: 'text-info', strip: 'border-l-info', disc: 'bg-info/14' },
  success: {
    edge: 'border-success/36',
    ink: 'text-success',
    strip: 'border-l-success',
    disc: 'bg-success/14',
  },
  warning: {
    edge: 'border-warning/40',
    ink: 'text-warning',
    strip: 'border-l-warning',
    disc: 'bg-warning/14',
  },
  error: {
    edge: 'border-error/36',
    ink: 'text-error',
    strip: 'border-l-error',
    disc: 'bg-error/14',
  },
  brand: {
    edge: 'border-brand-red/36',
    ink: 'text-brand-red',
    strip: 'border-l-brand-red',
    disc: 'bg-brand-red/14',
  },
};

// The icon and the corner control share the text's row and centre on the whole text block.
const GRID =
  'grid items-center gap-x-2.5 gap-y-3 rounded-lg border px-3.5 py-3 text-left font-sans text-sm leading-[1.45]';

const WELL = 'bg-muted/50 text-foreground';

// The composer's strip is the one side stripe the design admits, by the founder's ruling.
const COMPOSER =
  'flex items-center gap-2 rounded border-l-3 bg-muted/50 px-3 py-2 font-sans text-sm text-foreground';

const LINKS = '[&_a]:text-primary [&_a]:underline-offset-4 [&_a:hover]:underline';

type Look = 'grid' | 'composer' | 'tile' | 'pairs';

// An inline notice draws the Alert pairs inside an overlay, and outside one whenever its
// caller names an emphasis or destructive.
function lookOf(
  { placement = 'inline', emphasis, destructive }: Readonly<NoticeProps>,
  inOverlay: boolean
): Look {
  if (placement === 'composer') return 'composer';
  if (placement === 'tile') return 'tile';
  if (placement === 'slot') return 'grid';
  return inOverlay || emphasis !== undefined || destructive !== undefined ? 'pairs' : 'grid';
}

function rootClass(
  look: Look,
  { tone, placement, end, emphasis, destructive }: Readonly<NoticeProps>
): string {
  if (look === 'composer') return cn(COMPOSER, TONE_LOOK[tone].strip);
  const columns =
    end === undefined ? 'grid-cols-[auto_minmax(0,1fr)]' : 'grid-cols-[auto_minmax(0,1fr)_auto]';
  if (look === 'pairs') {
    return cn(
      GRID,
      columns,
      'border-transparent',
      alertPairClasses({ variant: destructive === true ? 'destructive' : 'default', emphasis })
    );
  }
  return cn(
    GRID,
    columns,
    WELL,
    TONE_LOOK[tone].edge,
    look === 'tile' && 'group/notice gap-x-3 gap-y-3.5 p-4',
    placement === 'slot' && 'mt-0.5'
  );
}

function liveRole(
  look: Look,
  { tone, destructive, live }: Readonly<NoticeProps>
): 'alert' | 'status' | undefined {
  if (live === 'off') return undefined;
  const interrupts = tone === 'error' || (look === 'pairs' && destructive === true);
  return interrupts ? 'alert' : 'status';
}

function iconInk(look: Look, { tone, iconTone }: Readonly<NoticeProps>): string {
  if (iconTone === 'success') return 'text-success';
  return look === 'pairs' ? 'text-current' : TONE_LOOK[tone].ink;
}

function NoticeIcon({
  look,
  props,
}: Readonly<{ look: Look; props: NoticeProps }>): React.JSX.Element {
  const ink = iconInk(look, props);
  if (look === 'composer') {
    return <Icon icon={props.icon} size="md" className={cn('shrink-0', ink)} />;
  }
  if (look === 'tile') {
    return (
      <span
        className={cn(
          'col-start-1 row-start-1 flex size-9 shrink-0 items-center justify-center rounded-full',
          TONE_LOOK[props.tone].disc,
          ink
        )}
      >
        <Icon icon={props.icon} size="md-lg" />
      </span>
    );
  }
  return (
    <Icon icon={props.icon} size="md-lg" className={cn('col-start-1 row-start-1 shrink-0', ink)} />
  );
}

// A stacked tile keeps its three tracks, with the icon and the corner control on the first
// row and the text across all three below them. A spanning item does not size the `auto`
// tracks, so the text track is as wide stacked as side by side, and the measure cannot flip.
const STACKED_TEXT =
  'group-data-stacked/notice:col-start-1 group-data-stacked/notice:-col-end-1 group-data-stacked/notice:row-start-2';

/** The width of the text's longest unbreakable run as drawn: its min-content width. */
function widestWord(text: HTMLElement): number {
  text.style.width = 'min-content';
  const width = text.getBoundingClientRect().width;
  // The text block has no inline style of its own to give back.
  text.removeAttribute('style');
  return width;
}

/** The resolved width of the grid's second track, the text's column when side by side. */
function textTrackWidth(tile: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(tile).gridTemplateColumns.split(' ')[1] ?? '');
}

// The narrowest column, in the text's own ems, that still reads as lines of words rather
// than a word per line.
const READABLE_MEASURE_EM = 6;

/** The narrowest column the text reads in: its longest word, and never under the readable measure. */
function narrowestColumn(text: HTMLElement): number {
  const em = Number.parseFloat(getComputedStyle(text).fontSize);
  return Math.max(widestWord(text), READABLE_MEASURE_EM * em);
}

/**
 * Marks a tile `data-stacked` while its text column is narrower than the text's longest
 * word or the readable measure, so a large text size sets whole words, several to a line,
 * under the icon and the corner control. It measures again as the tile resizes and as the
 * text's drawn size may change, and releases everything on unmount.
 */
function useStackWhenNarrow(
  enabled: boolean,
  tileRef: React.RefObject<HTMLDivElement | null>,
  textRef: React.RefObject<HTMLDivElement | null>
): void {
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const tile = tileRef.current;
    const text = textRef.current;
    // A layout effect runs once the refs are attached, so both elements are there.
    /* v8 ignore next */
    if (tile === null || text === null) return;
    const measure = (): void => {
      const column = textTrackWidth(tile);
      tile.toggleAttribute('data-stacked', narrowestColumn(text) > column);
    };
    measure();
    // Stacking changes the tile's height, and a change to an observed box made inside its own
    // resize callback is reported as a ResizeObserver loop error, so a resize restacks in a
    // task of its own. A microtask would still run inside the observer's delivery.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const sizes = new ResizeObserver(() => {
      pending = setTimeout(measure, 0);
    });
    sizes.observe(tile);
    const release = observeTextMetrics(measure);
    return () => {
      sizes.disconnect();
      clearTimeout(pending);
      release();
    };
  }, [enabled, tileRef, textRef]);
}

function textPlacement(look: Look): string {
  if (look === 'composer') return 'flex-1 [&_a]:whitespace-nowrap';
  return cn('col-start-2 row-start-1 flex flex-col gap-0.5', look === 'tile' && STACKED_TEXT);
}

function NoticeBody({
  look,
  title,
  children,
  testId,
  ref,
}: Readonly<{
  look: Look;
  title: React.ReactNode;
  children: React.ReactNode;
  testId: string | undefined;
  ref: React.Ref<HTMLDivElement>;
}>): React.JSX.Element {
  const composer = look === 'composer';
  const tile = look === 'tile';
  return (
    <div
      ref={ref}
      className={cn(
        // A word wider than its column breaks inside it, so large text never runs under a control.
        'min-w-0 text-pretty wrap-break-word',
        LINKS,
        textPlacement(look)
      )}
      {...(testId !== undefined && { 'data-testid': testId })}
    >
      {title !== undefined && (
        <span
          className={cn(
            composer ? 'font-normal' : 'font-semibold',
            tile && 'text-[0.9375rem] leading-[1.4] text-balance'
          )}
        >
          {title}
        </span>
      )}
      {title !== undefined && children !== undefined && ' '}
      {children !== undefined && (
        <span className={cn('font-normal', tile && 'text-muted-foreground')}>{children}</span>
      )}
    </div>
  );
}

// The negative margins keep a corner control from growing the notice; on touch the control
// grows to the 2.75rem target and the margins grow with it.
const END_SLOT =
  'col-start-3 row-start-1 -my-1 -mr-1.5 ml-1 flex pointer-coarse:-my-3 pointer-coarse:-mr-3.5 pointer-coarse:ml-0';

/**
 * The one notice: a required icon whose shape names the severity, a cause and an action
 * sentence, and an optional corner control. `placement` sets it under the composer, as a
 * turn's tile in the thread, or in a multi-model slot. The default placement draws the
 * Alert pairs inside an overlay, and anywhere its caller names `emphasis` or `destructive`.
 */
function Notice(props: Readonly<NoticeProps>): React.JSX.Element {
  const {
    placement = 'inline',
    title,
    children,
    end,
    actions,
    'data-testid': testId,
    textTestId,
  } = props;
  const look = lookOf(props, useOverlayPresentation() !== null);
  const role = liveRole(look, props);
  const tileRef = React.useRef<HTMLDivElement>(null);
  const textRef = React.useRef<HTMLDivElement>(null);
  useStackWhenNarrow(look === 'tile', tileRef, textRef);
  return (
    <NoticePlacementContext value={placement}>
      <div
        ref={tileRef}
        data-slot="notice"
        data-tone={props.tone}
        data-placement={placement}
        className={rootClass(look, { ...props, placement })}
        {...(role !== undefined && { role })}
        {...(testId !== undefined && { 'data-testid': testId })}
      >
        <NoticeIcon look={look} props={props} />
        <NoticeBody look={look} title={title} testId={textTestId} ref={textRef}>
          {children}
        </NoticeBody>
        {end !== undefined && (
          <div className={look === 'composer' ? 'flex shrink-0' : END_SLOT}>{end}</div>
        )}
        {actions !== undefined && (
          <div className={look === 'tile' ? 'col-span-full' : 'col-start-2 -col-end-1'}>
            <ButtonRow>{actions}</ButtonRow>
          </div>
        )}
      </div>
    </NoticePlacementContext>
  );
}

export { Notice, type NoticeProps, type NoticeTone };
