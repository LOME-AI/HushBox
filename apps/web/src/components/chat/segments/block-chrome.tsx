import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@hushbox/ui';
import { DotPulseIndicator } from '@/components/chat/indicators/dot-pulse-indicator';

/**
 * The chrome every chat block shares: a one-line header (a live status or a
 * disclosure) over an optional body. Reasoning, search and any later block kind
 * draw their header from here, so every block reads as the same component at
 * every depth.
 */

/**
 * The chevron's slot, reserved in every state whether or not it is filled, so
 * a header's label never moves between a status line, a disclosure and a
 * plain line, and the body below hangs on the same vertical.
 */
export const LEAD_SLOT = 'flex w-3 shrink-0 items-center';

/** The one chrome row: sans, muted, intrinsic width, 24px hit target. */
export const ROW =
  'text-muted-foreground m-0 inline-flex min-h-6 max-w-full items-center gap-1.5 p-0 text-left font-sans text-xs font-medium';

/** The subordinate reading register a block's body is set in. */
export const READING =
  'text-muted-foreground max-w-[68ch] pl-[1.125rem] font-serif text-[0.9375rem]';

const TOGGLE =
  'hover:text-foreground focus-visible:outline-ring cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * A header's words. The live dots sit inside them rather than beside them, so
 * when a narrow column wraps the words the dots follow the last one instead of
 * standing apart at the row's far edge.
 */
export function RowLabel({
  text,
  pulse,
}: Readonly<{ text: string; pulse: boolean }>): React.JSX.Element {
  return (
    <span className="min-w-0 text-pretty">
      {text}
      {pulse ? (
        <span className="ml-1.5 inline-flex align-middle">
          <DotPulseIndicator />
        </span>
      ) : null}
    </span>
  );
}

interface BlockToggleProps {
  readonly open: boolean;
  /** The id of the body this header opens, which stays mounted while closed. */
  readonly panelId: string;
  /** The label's parts, shown joined by " · " and spoken joined by ", ". */
  readonly parts: readonly string[];
  /** Spoken after the parts, for trailing content whose visible form reads badly aloud. */
  readonly ariaSuffix?: string | undefined;
  readonly testId: string;
  readonly onToggle: () => void;
  /** Whether the block is still working, which the label shows as live dots. */
  readonly pulse?: boolean;
  /** Shown after the label: a detail that the label alone would crowd. */
  readonly children?: React.ReactNode;
}

/** A settled block's header: a native disclosure button over its body. */
export function BlockToggle({
  open,
  panelId,
  parts,
  ariaSuffix,
  testId,
  onToggle,
  pulse = false,
  children,
}: BlockToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={open}
      aria-controls={panelId}
      // Spelled out so each separator reads as a word boundary rather than
      // running one part into the next.
      aria-label={[...parts, ...(ariaSuffix === undefined ? [] : [ariaSuffix])].join(', ')}
      onClick={onToggle}
      className={cn(ROW, TOGGLE)}
    >
      <span className={LEAD_SLOT}>
        <ChevronRight
          aria-hidden="true"
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </span>
      <RowLabel text={parts.join(' · ')} pulse={pulse} />
      {children}
    </button>
  );
}
