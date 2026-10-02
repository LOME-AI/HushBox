import * as React from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@hushbox/ui';
import { Popover } from '@hushbox/ui/popover';
import { ChevronDown, Icon } from '@hushbox/ui/icons';
import { agreedOptions } from '@/lib/chat/multi-model-agreement';
import {
  AxisConflictNotice,
  GradedAspectRatios,
  isSendCheckUnavailable,
  MediaCostLine,
  MediaFundingNotice,
  useImageAspectRatio,
} from '@/components/chat/media/modality-config-panel';
import { AUTO_ASPECT_RATIO, RatioShape, ratioLabel } from '@/components/chat/media/ratio-chip';
import type { MediaDimensionAvailability, NoticeReason } from '@hushbox/shared';

/** The ratios the grid offers before "N more", in the order it draws them. */
export const COMMON_ASPECT_RATIOS: readonly string[] = [
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  '5:4',
  '4:3',
  '3:2',
  '16:9',
  '21:9',
];

/** A model's supported ratios, sorted into the grid's three places. */
interface AspectRatioSplit {
  /** The common ratios it supports, in the common order. */
  readonly common: readonly string[];
  /** Every other ratio it supports, in the order it declares them. */
  readonly more: readonly string[];
  /** Whether it lets the model choose. */
  readonly auto: boolean;
}

export function splitAspectRatios(supported: readonly string[]): AspectRatioSplit {
  return {
    common: COMMON_ASPECT_RATIOS.filter((ratio) => supported.includes(ratio)),
    more: supported.filter(
      (ratio) => ratio !== AUTO_ASPECT_RATIO && !COMMON_ASPECT_RATIOS.includes(ratio)
    ),
    auto: supported.includes(AUTO_ASPECT_RATIO),
  };
}

// A label too long for a narrow tile wraps inside it rather than running past its border.
const TILE_CLASS =
  'flex min-h-16 min-w-0 flex-col items-center justify-end gap-1.5 rounded-md border px-1 pt-2 pb-2 text-center text-xs leading-none [overflow-wrap:anywhere] transition-colors';

interface RatioTileProps {
  readonly ratio: string;
  readonly isActive: boolean;
  readonly onSelect: () => void;
  /** Present when the money layer refused this ratio; the tile stays focusable and says why. */
  readonly unavailable: { readonly reasonId: string } | undefined;
  readonly tileRef?: React.Ref<HTMLButtonElement> | undefined;
}

function RatioTile({
  ratio,
  isActive,
  onSelect,
  unavailable,
  tileRef,
}: Readonly<RatioTileProps>): React.JSX.Element {
  return (
    <button
      ref={tileRef}
      type="button"
      aria-pressed={isActive}
      {...(unavailable && { 'aria-disabled': true, 'aria-describedby': unavailable.reasonId })}
      onClick={() => {
        if (unavailable === undefined) onSelect();
      }}
      className={cn(
        TILE_CLASS,
        'border-border-control text-muted-foreground hover:bg-accent hover:text-foreground font-mono',
        'aria-pressed:border-brand-red aria-pressed:bg-brand-red aria-pressed:text-primary-foreground aria-pressed:font-semibold',
        // opacity-60, not lower: a greyed option must stay perceivable while reading as unavailable.
        unavailable && 'cursor-not-allowed opacity-60 hover:bg-transparent'
      )}
    >
      <RatioShape ratio={ratio} size="tile" />
      {ratioLabel(ratio)}
    </button>
  );
}

function MoreRatiosTile({
  count,
  onOpen,
}: Readonly<{ count: number; onOpen: () => void }>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onOpen}
      className={cn(
        TILE_CLASS,
        'border-brand-red text-brand-red hover:bg-brand-red-subtle border-dashed font-sans font-semibold'
      )}
    >
      <Icon icon={ChevronDown} size="sm" />
      {`${String(count)} more`}
    </button>
  );
}

interface MediaVerdictProps {
  /** The turn's per-axis verdicts, or `undefined` while there is none. */
  readonly dimensions?: readonly MediaDimensionAvailability[] | undefined;
  /** The composer's send refusal, as the money layer's own reason. */
  readonly sendRefusal?: NoticeReason | undefined;
}

/**
 * The image ratios in one grid: the common ones the selected models share, Auto,
 * and "N more", which opens every other shared ratio in place with Auto last.
 * A chosen ratio among the rest opens the grid whole, so the choice is in view.
 */
function ImageRatioGrid({
  supported,
  aspectRatio,
  choose,
  dimensions,
}: Readonly<
  Pick<MediaVerdictProps, 'dimensions'> & {
    supported: readonly string[];
    aspectRatio: string;
    choose: (ratio: string) => void;
  }
>): React.JSX.Element {
  const split = splitAspectRatios(supported);
  const [showAll, setShowAll] = React.useState(() => split.more.includes(aspectRatio));
  const firstMoreRef = React.useRef<HTMLButtonElement>(null);
  const ratios = [
    ...split.common,
    ...(showAll ? split.more : []),
    ...(split.auto ? [AUTO_ASPECT_RATIO] : []),
  ];
  const firstMore = split.more[0];

  return (
    // A fieldset will not shrink as a flex item, so a plain box around it is what scrolls. The
    // columns follow that box's own width, not the screen's: the popover is capped to the room
    // the main column leaves, which an open sidebar and large text both narrow.
    <div className="@container -m-0.5 min-h-0 shrink overflow-y-auto p-0.5">
      <fieldset className="grid grid-cols-3 gap-1.5 border-0 p-0 @[15rem]:grid-cols-4 @[22rem]:grid-cols-6">
        <legend className="sr-only">Aspect ratio</legend>
        <GradedAspectRatios
          ratios={ratios}
          dimensions={dimensions}
          renderOption={(ratio, refusal) => (
            <RatioTile
              ratio={ratio}
              isActive={aspectRatio === ratio}
              unavailable={refusal}
              tileRef={ratio === firstMore ? firstMoreRef : undefined}
              onSelect={() => {
                choose(ratio);
              }}
            />
          )}
        />
        {!showAll && split.more.length > 0 && (
          <MoreRatiosTile
            count={split.more.length}
            onOpen={() => {
              // The tile leaves as it opens the rest, so focus moves to the first ratio it revealed.
              flushSync(() => {
                setShowAll(true);
              });
              firstMoreRef.current?.focus();
            }}
          />
        )}
      </fieldset>
    </div>
  );
}

/** The ratio axis: its grid, or why there is none. */
function ImageRatioAxis({
  dimensions,
  sendRefusal,
}: Readonly<MediaVerdictProps>): React.JSX.Element | null {
  const { aspectRatio, choose, agreement } = useImageAspectRatio();
  // The conflict is named first: no retry clears it, while the unread funding resolves on its own.
  if (agreement.kind === 'conflict') return <AxisConflictNotice axis="aspect ratio" />;
  if (isSendCheckUnavailable(sendRefusal)) return null;
  return (
    <ImageRatioGrid
      supported={agreedOptions(agreement)}
      aspectRatio={aspectRatio}
      choose={choose}
      dimensions={dimensions}
    />
  );
}

interface GenerationSettingsPopoverProps extends MediaVerdictProps {
  readonly modality: 'image';
  /** The control it opens from; it is told whether the popover is open. */
  readonly trigger: React.ReactElement<{ expanded?: boolean; ref?: React.Ref<HTMLElement> }>;
  /** The composer it hangs below; until that is mounted it hangs from its chip. */
  readonly anchor: React.RefObject<HTMLElement | null>;
}

/**
 * A media turn's settings, opened from one composer chip: for an image, the
 * "Aspect ratio" grid and the turn's estimated cost. From 768 it hangs below the
 * composer inside the main column, flipping up only when short; below 768 it is
 * a sheet titled "Aspect ratio".
 */
export function GenerationSettingsPopover({
  trigger,
  anchor,
  dimensions,
  sendRefusal,
}: Readonly<GenerationSettingsPopoverProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [triggerElement, setTriggerElement] = React.useState<HTMLElement | null>(null);
  // Read as it opens: the composer is mounted by then, and the popover holds still while open.
  const [hangFrom, setHangFrom] = React.useState<HTMLElement | null>(null);
  const handleOpenChange = (next: boolean): void => {
    if (next) setHangFrom(anchor.current);
    setOpen(next);
  };
  // The main column below the header, the page shell's region, keeps the popover under the
  // header; a page with no shell falls back to the whole main column.
  const boundary =
    triggerElement?.closest<HTMLElement>('[data-page-slot="region"]') ??
    triggerElement?.closest('main') ??
    null;

  return (
    <Popover
      trigger={React.cloneElement(trigger, { expanded: open, ref: setTriggerElement })}
      title="Aspect ratio"
      width="lg"
      align="start"
      anchor={hangFrom}
      boundary={boundary}
      open={open}
      onOpenChange={handleOpenChange}
    >
      {/* The anchored popover is a column whose children keep their height unless they opt in:
          this body does, so the grid inside it is what scrolls. [&] outranks the column's
          *:shrink-0, which sorts after a plain utility. */}
      <div className="flex min-h-0 flex-col gap-3 [&]:shrink">
        {/* The sheet's head carries the title below 768. */}
        <h2 className="text-base font-normal max-md:hidden">Aspect ratio</h2>
        <MediaFundingNotice sendRefusal={sendRefusal} />
        <ImageRatioAxis dimensions={dimensions} sendRefusal={sendRefusal} />
        <div className="text-ui-sm text-muted-foreground flex items-baseline justify-between gap-4 pt-1">
          <span>Cost</span>
          <MediaCostLine modality="image" />
        </div>
      </div>
    </Popover>
  );
}
