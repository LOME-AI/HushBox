import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock } from '@hushbox/ui';
import { highlightLines, languageForPath } from '@hushbox/ui/code-highlight';
import { TEST_IDS } from '@/test-ids';
import { citationKey } from './citation-target';
import { linesInView } from './visible-lines';
import type { Citation } from './citation-target';
import type { PeekOutcome } from './source-window';
import type { SourceWindow } from '@hushbox/docket';
import type { CodeToken } from '@hushbox/ui/code-highlight';
import type { JSX } from 'react';

interface PeekContentProps {
  readonly citation: Citation;
  /** `null` while the window is still being read. */
  readonly outcome: PeekOutcome | null;
}

const STALE_NOTICE =
  'This file changed after the audit was written, so the cited line may have drifted.';
const MISSING_NOTICE = 'This file is no longer in the working tree.';

/**
 * The peek paints this many lines and no more, whatever the citation names: a
 * citation may cover a whole block, and a box taller than the viewport hides
 * its own tail with nothing a reader can scroll, because the layer carries no
 * pointer events. Sized to the context the server reads either side of a
 * citation, so an ordinary one-line citation is never cut.
 */
export const PEEK_MAX_LINES = 13;

/**
 * Context kept above the cited line when the citation is longer than the box.
 * The server reads six lines either side, which is right for the one-line
 * citation it is sized for; spending six of thirteen on the run-up to a
 * seventy-line citation gives the reader less than half a box of what they
 * pointed at.
 */
const MIN_LEAD_LINES = 2;

/**
 * A drifted or deleted file is a notice rather than an error: the audit
 * document tells readers to re-confirm citations, and seeing the drift is the
 * point of peeking at all. A refusal is the same shape, so one line carries all
 * three.
 */
function noticeFor(outcome: PeekOutcome | null): string | null {
  if (outcome === null) return null;
  if (!outcome.ok) return outcome.message;
  if (!outcome.window.exists) return MISSING_NOTICE;
  return outcome.window.stale ? STALE_NOTICE : null;
}

/** The window there is code to paint from, which a gone or refused file has not. */
function windowOf(outcome: PeekOutcome | null): SourceWindow | null {
  return outcome?.ok === true && outcome.window.exists ? outcome.window : null;
}

interface PeekView {
  /** The window whose code is painted, or `null` when there is none to paint. */
  readonly window: SourceWindow | null;
  readonly lines: readonly { n: number; text: string | readonly CodeToken[] }[];
  readonly notice: string | null;
}

/**
 * How much of the run-up the box gives back to the citation. Nothing moves
 * while the cited range fits, and the drop never reaches past the window's own
 * tail, so a citation the file ended before still paints the lines that exist.
 */
function leadingLinesToSkip(window: SourceWindow): number {
  const lead = Math.max(0, window.requestedStart - window.start);
  const cited = window.requestedEnd - window.requestedStart + 1;
  const droppable = Math.min(lead - MIN_LEAD_LINES, lead + cited - PEEK_MAX_LINES);
  return Math.min(Math.max(0, droppable), Math.max(0, window.lines.length - PEEK_MAX_LINES));
}

/**
 * What the reader is looking at, said in the numbers they can check against
 * the range the citation names. The count is the lines still on screen after
 * the box was cut, not the lines that were painted into it: a notice naming a
 * line the reader cannot see is worse than no notice at all.
 */
function rangeNotice(
  window: SourceWindow,
  painted: number,
  lines: readonly { n: number }[]
): string | null {
  if (painted === 0) return null;
  const names = `the citation names ${String(window.requestedStart)} to ${String(window.requestedEnd)}`;
  const first = lines[0];
  const last = lines.at(-1);
  if (first === undefined || last === undefined)
    return `There is no room to show it here; ${names}.`;
  if (last.n >= window.requestedEnd) return null;
  const shown =
    first.n === last.n
      ? `Showing line ${String(first.n)}`
      : `Showing lines ${String(first.n)} to ${String(last.n)}`;
  return `${shown}; ${names}.`;
}

/**
 * The lines a peek paints, and everything it has to say above them. A range
 * the cap or the box cut short is said out loud: the reader gets the head of
 * the citation and the line numbers to open the file at, rather than a box
 * that quietly stops.
 */
function viewOf(
  outcome: PeekOutcome | null,
  room: number,
  colored: readonly (readonly CodeToken[])[] | null
): PeekView {
  const window = windowOf(outcome);
  if (window === null) return { window, lines: [], notice: noticeFor(outcome) };

  const skipped = leadingLinesToSkip(window);
  const painted = window.lines.slice(skipped, skipped + PEEK_MAX_LINES).map((text, offset) => ({
    n: window.start + skipped + offset,
    text: colored?.[skipped + offset] ?? text,
  }));
  const lines = painted.slice(0, room);
  const cutShort = rangeNotice(window, painted.length, lines);
  const notice = [noticeFor(outcome), cutShort].filter((line) => line !== null).join(' ');
  return { window, lines, notice: notice === '' ? null : notice };
}

/**
 * Every line the code block laid out, so the ones that fell past the foot of
 * the box can be counted. It is the block's own slot attribute rather than a
 * ref array: the lines are rendered by a shared primitive this layer only
 * hands data to.
 */
const LINE_SELECTOR = '[data-slot="code-block-line"]';

/** What one citation reads as in the working tree right now. */
export function PeekContent({ citation, outcome }: PeekContentProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ key: string; lines: number } | null>(null);
  const key = `${citationKey(citation)}:${outcome === null ? 'reading' : 'read'}`;
  /**
   * Colored from the whole window the server read rather than the lines that
   * survive the cap, so a string or comment that opened in the run-up is still
   * open on the first line painted. Highlighting is synchronous, so the peek
   * opens colored and has no in-between state to render.
   */
  const source = windowOf(outcome);
  const colored = useMemo(() => {
    const language = languageForPath(citation.path);
    return source === null || language === null ? null : highlightLines(source.lines, language);
  }, [source, citation.path]);
  const view = viewOf(outcome, fit?.key === key ? fit.lines : PEEK_MAX_LINES, colored);

  /**
   * The box is bounded by the room above the citation, which is settled by the
   * popover after this content first paints and moves again whenever the
   * reader scrolls or resizes, so the size the box lands on is read from the
   * box rather than predicted. Within one peek the count only ever falls:
   * fewer lines make a shorter box, and re-measuring upwards from that is the
   * oscillation this deliberately does not have.
   *
   * Two things move the code relative to the box, and both have to be watched.
   * The box is clipped by a `max-height`, so content growing past the fold
   * changes nothing about the box's own size — watching it alone leaves a peek
   * naming lines that are off screen. And the count feeds the notice, whose
   * height is part of the layout the next count is read from, so a measurement
   * has to be taken again against the layout it caused. Hence no dependency
   * list: this runs after every commit, and `getBoundingClientRect` flushes
   * pending layout, so what it reads is settled rather than in flight.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    // The popover content is what carries the height bound and hides the tail.
    const clip = root.parentElement ?? root;
    const measure = (): void => {
      const bottoms = [...root.querySelectorAll(LINE_SELECTOR)].map(
        (line) => line.getBoundingClientRect().bottom
      );
      const lines = linesInView(bottoms, clip.getBoundingClientRect().bottom);
      setFit((previous) =>
        previous !== null && previous.key === key && previous.lines <= lines
          ? previous
          : { key, lines }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  });

  // The peek's box draws a 1px border on each side around this root, so the
  // root is 2px short of the width the whole peek takes.
  return (
    <div
      ref={rootRef}
      data-testid={TEST_IDS.sourcePeek}
      className="flex w-[calc(min(46rem,90vw)-2px)] flex-col"
    >
      <p className="text-muted-foreground border-border truncate border-b px-3 py-1.5 font-mono text-xs">
        {citation.path}
      </p>
      {view.notice !== null && (
        <p
          data-testid={TEST_IDS.sourcePeekNotice}
          className="text-muted-foreground border-border border-b px-3 py-1.5 text-xs"
        >
          {view.notice}
        </p>
      )}
      {outcome === null && <p className="text-muted-foreground px-3 py-2 text-xs">Reading</p>}
      {view.window !== null && (
        // Code wraps here rather than scrolling sideways: the peek takes no
        // pointer events, so a horizontal scrollbar would hide the tail of a
        // long line with no way to reach it.
        <CodeBlock
          className="rounded-none border-0 [&_pre]:[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap"
          highlightLine={view.window.requestedStart}
          lines={view.lines}
        />
      )}
    </div>
  );
}
