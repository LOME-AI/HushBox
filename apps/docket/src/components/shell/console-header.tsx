import { useState } from 'react';
import { Button, Kbd, Meter, ThemeToggle, cn, formatHotkey } from '@hushbox/ui';
import { useFormFactor } from '@hushbox/ui/platform';
import { TEST_IDS } from '@/test-ids';
import { ConsoleInput } from '../console-fields';
import { AuditSwitcher } from './audit-switcher';
import { SectionNav } from './section-nav';
import { SHORTCUTS_COMBO } from './hooks/use-console-hotkeys';
import { VIEW_MODES } from './logic/view-mode';
import type { SectionId } from './logic/sections';
import type { ViewMode } from './logic/view-mode';
import type { JSX } from 'react';

export interface ConsoleHeaderProps {
  readonly auditTitle: string;
  readonly auditName: string;
  readonly audits: readonly string[];
  /**
   * Where a chosen audit goes. The address bar the console reads its view from
   * is owned above this header, so the header carries the choice rather than
   * acting on it.
   */
  readonly onAudit: (name: string) => void;
  /** A bulk ruling is working its way down the queue, which holds the switch. */
  readonly bulkRunning: boolean;
  /** Ruled plus denied, over every finding in the audit. */
  readonly decided: number;
  readonly total: number;
  /**
   * Findings on disk the format rejected, which no count above can include.
   * The banner that lists them is dismissible, so the figure they are missing
   * from is where the shortfall has to keep being said.
   */
  readonly unreadable: number;
  /** False once the audit can no longer be re-read, so the counts stop claiming to be current. */
  readonly live: boolean;
  readonly section: SectionId;
  readonly counts: Record<SectionId, number>;
  readonly onSection: (section: SectionId) => void;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly mode: ViewMode;
  readonly onMode: (mode: ViewMode) => void;
  /** Raises the shortcut legend, which the keyboard also does. */
  readonly onShortcuts: () => void;
}

const MODE_LABELS: Record<ViewMode, string> = { list: 'List', focus: 'Focus' };

/**
 * Which audit, how far through it, which theme, and where the shortcuts are:
 * everything the header carries that is not how the reader gets around the
 * audit. At the largest text tier on a phone-width viewport the whole header
 * took half the screen, and none of it can be scrolled away, so below the
 * shared mobile breakpoint this much of it folds behind one control and the
 * height goes back to the queue. The parts that stay are the section tabs,
 * the search, the view modes, and any warning that the counts are stale.
 */
function toolsLabel(open: boolean): string {
  return open ? 'Hide tools' : 'Tools';
}

/**
 * How far through the audit the reader is, and the shortfall that qualifies it.
 *
 * The sentence is the console's own text rather than the meter's label: that
 * label refuses to wrap, so a viewport with room for the count and not for the
 * qualifier cut the qualifier off with nowhere to scroll to it, leaving the
 * count standing without the correction it depends on. The qualifier is one
 * element so it moves as a whole, and the bar beside it is decorative.
 */
function DecidedCount({
  decided,
  total,
  unreadable,
}: Readonly<{ decided: number; total: number; unreadable: number }>): JSX.Element {
  return (
    <>
      <Meter
        aria-hidden="true"
        className="min-w-24 flex-1"
        value={decided}
        // An audit with no findings would otherwise divide by zero.
        max={Math.max(total, 1)}
        formatLabel={() => ''}
      />
      <p className="text-muted-foreground min-w-0 text-sm">
        {`${String(decided)} of ${String(total)} decided`}
        {unreadable > 0 && <span>{`, ${String(unreadable)} unreadable`}</span>}
      </p>
    </>
  );
}

export function ConsoleHeader({
  auditTitle,
  auditName,
  audits,
  onAudit,
  bulkRunning,
  decided,
  total,
  unreadable,
  live,
  section,
  counts,
  onSection,
  query,
  onQuery,
  mode,
  onMode,
  onShortcuts,
}: ConsoleHeaderProps): JSX.Element {
  const narrow = useFormFactor().band === 'phone';
  const [open, setOpen] = useState(false);
  const tools = !narrow || open;

  return (
    <header
      data-chrome=""
      className="border-border flex shrink-0 flex-col gap-2 border-b px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
        {/* The one part of this row that can give up width. Everything beside
            it is a control, and at a scaled root font the row wraps without
            this — a line of chrome the reader cannot scroll past costs more
            than the tail of a title the switcher beside it also names. */}
        {/* Sized from zero rather than from the title while the row is folded:
            a wrapping flex line is packed by what each item wants, so a title
            that would rather be 400px wide takes the line to itself and puts
            the control beside it on one of its own. */}
        <h1 className={cn('min-w-0 truncate text-lg font-semibold', narrow && 'flex-1 basis-0')}>
          {auditTitle}
        </h1>
        {tools && (
          <>
            <AuditSwitcher
              name={auditName}
              audits={audits}
              onSwitch={onAudit}
              bulkRunning={bulkRunning}
            />
            <DecidedCount decided={decided} total={total} unreadable={unreadable} />
          </>
        )}
        {/* Beside the meter it qualifies: the counts are the freshness claim,
            and the region is always mounted so the reader is told the moment
            the console stops being able to check them. */}
        <p role="status" className="text-muted-foreground text-sm empty:hidden">
          {live
            ? ''
            : 'Not live. The console lost the audit server, so what is on screen may be out of date.'}
        </p>
        {tools && <ThemeToggle />}
        {narrow && (
          <Button
            variant={open ? 'outline' : 'default'}
            className="ml-auto"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {toolsLabel(open)}
          </Button>
        )}
      </div>
      {/* Wrapping is right where there is no room to scroll instead, and wrong
          here above it: the tabs already scroll on their own axis, and every
          line this row gains is taken off a reading area the header cannot be
          scrolled out of. Below the breakpoint it wraps, because there the
          alternative is a row of controls squeezed to nothing. */}
      <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
        <SectionNav active={section} counts={counts} onSelect={onSection} />
        <ConsoleInput
          type="search"
          data-testid={TEST_IDS.searchInput}
          aria-label="Search findings"
          placeholder="Search id, title or body"
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
          }}
          className={cn('w-72 min-w-0 shrink', narrow && 'flex-1 basis-0')}
        />
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {/* The console's keyboard says so on screen. Behind a keystroke alone
              it is only findable by a reader who already knows it is there,
              which is every reader except a first one. */}
          {tools && (
            <button
              type="button"
              onClick={onShortcuts}
              aria-keyshortcuts={formatHotkey(SHORTCUTS_COMBO, { apple: false })}
              className="focus-visible:ring-ring text-muted-foreground hover:bg-muted hover:text-foreground flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-1.5 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2"
            >
              Keyboard shortcuts
              <Kbd combo={SHORTCUTS_COMBO} />
            </button>
          )}
          <div className="flex items-center gap-1">
            {VIEW_MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={candidate === mode}
                onClick={() => {
                  onMode(candidate);
                }}
                className={cn(
                  'focus-visible:ring-ring rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2',
                  candidate === mode
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                {MODE_LABELS[candidate]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
