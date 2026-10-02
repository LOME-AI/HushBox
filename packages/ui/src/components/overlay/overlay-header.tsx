import * as React from 'react';
import { cn } from '../../lib/utilities';
import { typeRoleClass } from '../type/type-role-class';
import { OverlayTitle } from './overlay-title';

interface OverlayHeaderProps {
  /** Inside an `Overlay`, this is also the dialog's accessible name. */
  title: string;
  /** Optional description below the title; inside an `Overlay`, also the dialog's accessible description. */
  description?: React.ReactNode;
  /**
   * The flow's position, written above the title; it never joins the accessible name.
   * `'pending'` holds the line's space with no text while the count is not yet known, so
   * the title does not move when the count arrives.
   */
  step?: { current: number; total: number } | 'pending';
  /** `lg` sets the title in the title-1 role. */
  size?: 'default' | 'lg';
  align?: 'start' | 'center';
  /** Drawn above the title, such as a mark. */
  media?: React.ReactNode;
  /** Drawn between the title and the description. */
  meta?: React.ReactNode;
  className?: string;
  titleTestId?: string;
  descriptionTestId?: string;
}

const STEP_LINE_CLASS = 'text-muted-foreground mb-0.5 text-xs';

function StepLine({
  step,
}: Readonly<{ step: NonNullable<OverlayHeaderProps['step']> }>): React.JSX.Element {
  if (step === 'pending') {
    return (
      <p data-slot="overlay-step" aria-hidden="true" className={cn(STEP_LINE_CLASS, 'invisible')}>
        {'\u00A0'}
      </p>
    );
  }
  return (
    <p data-slot="overlay-step" className={STEP_LINE_CLASS}>
      {`Step ${String(step.current)} of ${String(step.total)}`}
    </p>
  );
}

/** Whether the overlay around a header draws its back button, which takes a row of its own. */
export const OverlayBackButtonContext = React.createContext(false);

type OverlayDescriptionPrimitive = React.ComponentType<{
  asChild?: boolean;
  children?: React.ReactNode;
}>;

interface OverlayDescriber {
  /** The variant's dialog-description primitive, which carries the id the dialog is described by. */
  Description: OverlayDescriptionPrimitive;
  /** Registers a drawn description as the dialog's for as long as it stays mounted. */
  claimDescription: () => () => void;
}

/** Set by an overlay renderer inside its dialog element; absent, a header's description is plain text. */
export const OverlayDescriptionContext = React.createContext<OverlayDescriber | null>(null);

/**
 * The describer an overlay renderer provides to its headers, and the props its dialog element
 * spreads. With no description drawn they drop `aria-describedby`, which also keeps the dialog
 * primitive from warning that its description is missing; with one, the primitive's own
 * `aria-describedby` names it.
 */
export function useOverlayDescriber(Description: OverlayDescriptionPrimitive): {
  describer: OverlayDescriber;
  describedByProps: { 'aria-describedby'?: undefined };
} {
  const [claims, setClaims] = React.useState(0);
  // Counted rather than a flag: a step transition unmounts one header and mounts the next in one commit.
  const claimDescription = React.useCallback((): (() => void) => {
    setClaims((count) => count + 1);
    return () => {
      setClaims((count) => count - 1);
    };
  }, []);
  const describer = React.useMemo(
    () => ({ Description, claimDescription }),
    [Description, claimDescription]
  );
  return { describer, describedByProps: claims > 0 ? {} : { 'aria-describedby': undefined } };
}

function DescriptionLine({
  testId,
  children,
}: Readonly<{ testId: string | undefined; children: React.ReactNode }>): React.JSX.Element {
  const describer = React.useContext(OverlayDescriptionContext);
  const claimDescription = describer?.claimDescription;

  React.useLayoutEffect(() => claimDescription?.(), [claimDescription]);

  // A div, not a paragraph: a description may hold paragraphs of its own.
  const line = (
    <div data-testid={testId} className="text-muted-foreground text-sm">
      {children}
    </div>
  );
  if (describer === null) return line;
  const { Description } = describer;
  return <Description asChild>{line}</Description>;
}

const TITLE_CLASS = {
  default: 'text-lg leading-normal font-semibold',
  lg: typeRoleClass('title-1'),
} as const;

export function OverlayHeader({
  title,
  description,
  step,
  size = 'default',
  align = 'start',
  media,
  meta,
  className,
  titleTestId,
  descriptionTestId,
}: Readonly<OverlayHeaderProps>): React.JSX.Element {
  const belowBackButton = React.useContext(OverlayBackButtonContext);
  return (
    <div
      className={cn(
        'flex flex-col',
        // A start-aligned header leaves the close button's corner free.
        align === 'center' ? 'items-center gap-1.5 px-4 text-center' : 'gap-1 pr-6',
        // The first block after a description sits 0.5rem further down than whatever spacing
        // the header's container gives. Padding adds to a container's gap or `space-y-*`; a margin
        // here would replace a `space-y-*` margin, and one on the next block would collapse into it.
        description !== undefined && 'pb-2',
        // The back button's corner row sits above the title and any step line, never beside them.
        belowBackButton && 'pt-6',
        className
      )}
    >
      {media !== undefined && <div className="mb-1">{media}</div>}
      {step !== undefined && <StepLine step={step} />}
      <OverlayTitle data-testid={titleTestId} className={TITLE_CLASS[size]}>
        {title}
      </OverlayTitle>
      {meta !== undefined && <div className="mt-1">{meta}</div>}
      {description !== undefined && (
        <DescriptionLine testId={descriptionTestId}>{description}</DescriptionLine>
      )}
    </div>
  );
}
