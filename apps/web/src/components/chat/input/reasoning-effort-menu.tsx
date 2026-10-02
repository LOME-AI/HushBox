import * as React from 'react';
import {
  noticeText,
  REASONING_EFFORT_DESCRIPTIONS,
  REASONING_EFFORT_LABELS,
  REASONING_OFF,
  TEST_IDS,
  TEST_SIGNALS,
} from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { Gauge } from '@hushbox/ui/icons';
import { Menu, MenuRadioGroup, MenuRadioItem } from '@hushbox/ui/menu';
import { Chip } from '@/components/shared/chip';
import {
  useEffortAvailabilityPublisher,
  useReasoningEffort,
} from '@/hooks/chat/use-reasoning-effort';
import type {
  Availability,
  DimensionAvailability,
  ReasoningEffortSelection,
} from '@hushbox/shared';

/**
 * The menu renders the producer's PRESENTED SET for the effort dimension —
 * `affordable.turnDimensions` — and grades nothing itself.
 *
 * That set is the union of the selected models' rungs, each graded by the SAME
 * query the send gate runs (AND over pinned siblings, inside OR over the
 * arrangements a smart slot could become). The intersection clamp this replaced
 * was wrong in both directions at once: it HID a rung only one sibling offers
 * (per-model resolution falls downward, so the turn can honour it) and it
 * ENABLED a rung both siblings name but neither can fund. Greyed-never-hidden,
 * for every tier including trial.
 */
interface EffortOption {
  readonly selection: ReasoningEffortSelection;
  readonly availability: Availability;
}

/**
 * Display order: Auto first (always selectable — it delegates the choice), then
 * the canonical rungs strongest-first, then Min last. Order is presentation;
 * MEMBERSHIP is the producer's.
 */
export function effortOptionsFrom(dimension?: DimensionAvailability): EffortOption[] {
  const auto: EffortOption = { selection: 'auto', availability: { available: true } };
  if (dimension === undefined) return [auto];
  const rungs = dimension.options.filter((option) => option.optionId !== REASONING_OFF);
  const min = dimension.options.find((option) => option.optionId === REASONING_OFF);
  const ordered = rungs.toReversed();
  const rows = min === undefined ? ordered : [...ordered, min];
  return [
    auto,
    ...rows.map(
      (option): EffortOption => ({
        selection: option.optionId as ReasoningEffortSelection,
        availability: option.availability,
      })
    ),
  ];
}

interface ReasoningEffortMenuProps {
  /** The produced effort dimension (`affordable.turnDimensions`), or undefined while it loads. */
  effortDimension: DimensionAvailability | undefined;
  /** From 768px, the element the menu opens 0.5rem below, flush with its left edge. */
  anchor?: React.RefObject<HTMLElement | null> | undefined;
  /** Set by a caller that also opens the menu from elsewhere, with `onOpenChange`. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Where focus returns as the menu closes while its chip is hidden, as on a narrow composer. */
  fallbackFocus?: React.RefObject<HTMLElement | null> | undefined;
}

interface MenuData {
  readonly options: readonly EffortOption[];
  readonly effective: ReasoningEffortSelection;
}

function menuDataKey(data: MenuData): string {
  const options = data.options
    .map((option) =>
      option.availability.available
        ? `${option.selection}:ok`
        : `${option.selection}:${option.availability.reason}`
    )
    .join('|');
  return `${options}@${data.effective}`;
}

function sameMenuData(a: MenuData | null, b: MenuData): boolean {
  return a !== null && menuDataKey(a) === menuDataKey(b);
}

/**
 * Slide-out needs the outgoing chip to stay in the DOM while the wrapper
 * collapses (the new model's ladder is already empty, so re-deriving options
 * would render nothing and the chip would vanish before the slide). The last
 * visible chip's data is retained in state, rendered inert until the caller
 * reports transitionend via `onCollapseEnd`. Render-phase setState (the React
 * "storing information from previous renders" pattern) keeps the retained
 * snapshot and closing flag in the SAME render the visibility flips — an
 * effect would leave a one-frame gap where the collapsing chip is empty.
 */
function useSlideRetention(
  visible: boolean,
  current: MenuData
): { menuData: MenuData | null; onCollapseEnd: () => void } {
  const [closing, setClosing] = React.useState(false);
  const [previousVisible, setPreviousVisible] = React.useState(false);
  const [retained, setRetained] = React.useState<MenuData | null>(null);

  if (previousVisible !== visible) {
    setPreviousVisible(visible);
    if (!visible) setClosing(true);
  }
  if (visible && !sameMenuData(retained, current)) setRetained(current);

  let menuData: MenuData | null = null;
  if (visible) menuData = current;
  else if (closing) menuData = retained;

  return {
    menuData,
    onCollapseEnd: () => {
      setClosing(false);
    },
  };
}

/**
 * The slide wrapper's three observable states. `collapsing` is not cosmetic: the
 * outgoing chip stays mounted under the SAME test id until `transitionend`, so a
 * point-in-time read of chip visibility cannot tell a chip that is arriving from
 * one that is leaving, and grades the ladder of the model that was replaced.
 */
function effortControlState(
  visible: boolean,
  menuData: MenuData | null
): 'present' | 'collapsing' | 'absent' {
  if (visible) return 'present';
  return menuData === null ? 'absent' : 'collapsing';
}

/** The menu's name, which its phone sheet carries with no head drawn. */
const MENU_TITLE = 'Reasoning effort';

function EffortRung({ option }: Readonly<{ option: EffortOption }>): React.JSX.Element {
  const refusal = option.availability.available
    ? {}
    : {
        disabled: true,
        // One home for money copy: the rung's reason renders the same sentence the
        // send gate would give for that condition.
        disabledReason: noticeText(option.availability.reason),
      };
  return (
    <MenuRadioItem<ReasoningEffortSelection>
      value={option.selection}
      title={REASONING_EFFORT_LABELS[option.selection]}
      description={REASONING_EFFORT_DESCRIPTIONS[option.selection]}
      density="compact"
      {...refusal}
    />
  );
}

interface EffortChipProps {
  readonly data: MenuData;
  readonly anchor: React.RefObject<HTMLElement | null> | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly fallbackFocus: React.RefObject<HTMLElement | null> | undefined;
  readonly onSelect: (selection: ReasoningEffortSelection) => void;
}

function EffortChip({
  data,
  anchor,
  open,
  onOpenChange,
  fallbackFocus,
  onSelect,
}: Readonly<EffortChipProps>): React.JSX.Element {
  const word = REASONING_EFFORT_LABELS[data.effective];
  return (
    <Menu
      trigger={
        <Chip
          icon={Gauge}
          aria-label={`${MENU_TITLE}: ${word}`}
          expanded={open}
          data-testid={TEST_IDS.effortChip}
        >
          {/* Ghost-word stack: every possible word sits invisibly in the same grid
              cell, so the chip is always exactly as wide as its widest word and
              never resizes when the selection changes. Chosen over a ch-based
              min-width because ch measures the "0" glyph, an approximation under
              the proportional UI font; the stack is font-exact. */}
          <span className="grid">
            <span className="col-start-1 row-start-1">{word}</span>
            {Object.values(REASONING_EFFORT_LABELS).map((ghost) => (
              <span key={ghost} aria-hidden="true" className="invisible col-start-1 row-start-1">
                {ghost}
              </span>
            ))}
          </span>
        </Chip>
      }
      title={MENU_TITLE}
      align="start"
      sheetHeader="none"
      {...(anchor !== undefined && { anchor: { element: anchor, offset: '0.5rem' } })}
      {...(fallbackFocus !== undefined && { fallbackFocus })}
      open={open}
      onOpenChange={onOpenChange}
    >
      {/* From 768px the menu is as wide as its rows, up to 22.5rem, where a long reason wraps. */}
      <div className="md:max-w-90">
        <MenuRadioGroup<ReasoningEffortSelection>
          value={data.effective}
          onValueChange={(value) => {
            // Authoritative guard whatever the item does with a press: a greyed
            // rung never commits a selection.
            const option = data.options.find((entry) => entry.selection === value);
            if (option?.availability.available === true) onSelect(value);
          }}
        >
          {data.options.map((option) => (
            <EffortRung key={option.selection} option={option} />
          ))}
        </MenuRadioGroup>
      </div>
    </Menu>
  );
}

/**
 * The reasoning-effort chip in the composer controls row: the gauge and the
 * effective word, opening the rungs as a radio menu below the composer (a sheet
 * with no head on a phone). Rendered whenever the turn carries an effort
 * selection at all — a selection with no offered level carries none, and
 * neither does a non-text modality. The Smart Model slot DOES carry one: the
 * level pins the slot, and the server derives its candidates at that rung. The
 * chip slides in/out on model/modality switches via the CSS grid-columns
 * wrapper below.
 */
export function ReasoningEffortMenu({
  effortDimension,
  anchor,
  open: controlledOpen,
  onOpenChange,
  fallbackFocus,
}: Readonly<ReasoningEffortMenuProps>): React.JSX.Element {
  const { effective, models, setSelection } = useReasoningEffort();
  const [ownOpen, setOwnOpen] = React.useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  // The only publisher of the graded set, sited here because this is the one
  // control that greys from it and it belongs to the composer alone. The gates
  // that also grade a turn (regenerate, queue drain) render no effort control,
  // so they cannot publish a verdict scoped to another payer. Published
  // whatever the chip's visibility: a turn whose ladder is empty still owes the
  // send producer an answer.
  useEffortAvailabilityPublisher(effortDimension);

  const visible = effective !== undefined && models !== undefined;
  // Greyed-never-hidden for EVERY tier (trial and guest included): infeasible
  // options render greyed with a reason, never filtered out.
  const options = visible ? effortOptionsFrom(effortDimension) : [];

  // `effective` is defined whenever `visible`; the 'auto' arm only feeds the
  // (never-rendered) current snapshot of hidden states.
  const { menuData, onCollapseEnd } = useSlideRetention(visible, {
    options,
    effective: effective ?? 'auto',
  });

  return (
    // The persistent slide wrapper: grid-template-columns 0fr↔1fr animates
    // to/from the chip's natural width with a pure CSS transition. No
    // motion-reduce:transition-none here — the global html.reduced-motion
    // kill (0.01ms, deliberately event-preserving) collapses the slide while
    // still firing the transitionend that unmounts the outgoing chip.
    <div
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !visible) onCollapseEnd();
      }}
      {...{ [TEST_SIGNALS.effortControl]: effortControlState(visible, menuData) }}
      className={cn(
        'grid shrink-0 transition-[grid-template-columns] duration-300 ease-in-out',
        visible ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]'
      )}
    >
      <div
        className={cn('overflow-hidden', !visible && 'pointer-events-none')}
        {...(!visible && { 'aria-hidden': true })}
      >
        {menuData !== null && (
          <EffortChip
            data={menuData}
            anchor={anchor}
            open={open}
            onOpenChange={setOpen}
            fallbackFocus={fallbackFocus}
            onSelect={setSelection}
          />
        )}
      </div>
    </div>
  );
}
