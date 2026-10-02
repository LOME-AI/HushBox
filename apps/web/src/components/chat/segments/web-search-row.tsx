import * as React from 'react';
import { motion } from 'framer-motion';
import { Globe, Search } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { AnimatedHeight, cn, useReducedMotion } from '@hushbox/ui';
import { BlockToggle, LEAD_SLOT, ROW, RowLabel } from '@/components/chat/segments/block-chrome';
import { ExternalLinkDialog } from '@/components/chat/segments/external-link-dialog';
import { useSearchAnnouncement } from '@/components/chat/segments/use-search-announcement';
import { useFirstRenderStreaming } from '@/components/chat/segments/use-first-render-streaming';
import { useSegmentOpen } from '@/components/chat/segments/segment-view-state';
import {
  searchFootnotes,
  searchQueryStatus,
  searchRowLabel,
} from '@/components/chat/segments/web-search-labels';
import { monogramOf, topDomains } from '@/components/chat/segments/web-search-sources';
import type { SearchRowLabel } from '@/components/chat/segments/web-search-labels';
import type { AnnouncedRow } from '@/components/chat/segments/use-search-announcement';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { RowPages, SourceView } from '@/components/chat/segments/web-search-sources';
import type {
  WebSearchEntry,
  WebSearchRow as WebSearchRowValue,
  WebSearchSegment,
} from '@hushbox/shared';

/**
 * Fades the oldest live query line once more lines run than the window shows.
 * A mask gradient, not a blur, so the accessibility widget's contrast and
 * inversion overrides still reach the faded text.
 */
const GLAZE_MASK = 'linear-gradient(to bottom, transparent 0, black 1.5rem)';

/** Live query lines the window shows before the oldest starts to fade. */
const VISIBLE_LIVE_LINES = 3;

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

interface WebSearchRowProps {
  readonly node: WebSearchSegment;
  readonly nodeKey: string;
  readonly context: SegmentRenderContext;
  /** Inside another block's body: it neither pulses nor announces on its own. */
  readonly nested: boolean;
}

function QueryText({ entry }: Readonly<{ entry: WebSearchEntry }>): React.JSX.Element {
  return <span className="text-foreground min-w-0 truncate">{entry.query}</span>;
}

/** One running query: the magnifier, the query, and its status, rising in when it starts. */
function LiveQueryLine({
  entry,
  enter,
}: Readonly<{ entry: WebSearchEntry; enter: boolean }>): React.JSX.Element {
  return (
    <motion.div
      initial={enter ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE_OUT_EXPO }}
      className="text-muted-foreground flex min-h-6 max-w-xl min-w-0 items-center gap-1.5 font-sans text-xs"
    >
      <span className={LEAD_SLOT}>
        <Search aria-hidden="true" className="ml-px size-2.5" />
      </span>
      <QueryText entry={entry} />
      <span className="shrink-0">·</span>
      <span className="shrink-0 whitespace-nowrap">{searchQueryStatus(entry)}</span>
    </motion.div>
  );
}

/**
 * A root row's running queries: at most three lines in view, anchored to the
 * newest, the oldest faded once a fourth runs. Hidden from assistive tech; the
 * row's own status carries the milestones.
 */
function LiveQueries({
  row,
  enterFrom,
}: Readonly<{ row: WebSearchRowValue; enterFrom: number }>): React.JSX.Element {
  const reduced = useReducedMotion();
  const glaze = row.searches.length > VISIBLE_LIVE_LINES;
  return (
    <div
      data-testid={TEST_IDS.webSearchRowQueries}
      aria-hidden="true"
      className="mt-0.5 flex max-h-[4.5rem] flex-col justify-end overflow-hidden"
      style={glaze ? { maskImage: GLAZE_MASK, WebkitMaskImage: GLAZE_MASK } : undefined}
    >
      {row.searches.map((entry, index) => (
        <LiveQueryLine key={index} entry={entry} enter={!reduced && index >= enterFrom} />
      ))}
    </div>
  );
}

function Monogram({
  host,
  repeat,
}: Readonly<{ host: string; repeat: boolean }>): React.JSX.Element {
  const letter = repeat ? undefined : monogramOf(host);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'text-muted-foreground mt-px flex size-[1.125rem] shrink-0 items-center justify-center rounded-full border font-sans text-[0.625rem] font-semibold',
        repeat ? 'border-transparent' : 'bg-card'
      )}
    >
      {repeat ? null : (letter ?? <Globe className="size-[0.6875rem]" />)}
    </span>
  );
}

function SourceButton({
  source,
  repeat,
  onOpen,
}: Readonly<{
  source: SourceView;
  repeat: boolean;
  onOpen: (url: string) => void;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={TEST_IDS.webSearchSource}
      onClick={() => {
        onOpen(source.url);
      }}
      className="group text-foreground hover:bg-muted focus-visible:outline-ring flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left focus-visible:outline-2 pointer-coarse:min-h-11"
    >
      <Monogram host={source.host} repeat={repeat} />
      <span className="flex min-w-0 flex-col">
        <span className="decoration-border-strong line-clamp-2 font-sans text-[0.8125rem] leading-5 font-medium wrap-anywhere underline-offset-2 group-hover:underline">
          {source.title === '' ? source.host : source.title}
        </span>
        <span className="text-muted-foreground truncate font-sans text-xs">{source.host}</span>
      </span>
    </button>
  );
}

/** The open row: every query with its status and the pages it found first, then the footnotes. */
function SearchPanel({
  row,
  pages,
  onOpen,
}: Readonly<{
  row: WebSearchRowValue;
  pages: RowPages;
  onOpen: (url: string) => void;
}>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.webSearchRowPanel} className="pt-1 pb-2">
      <ul className="m-0 max-w-xl list-none p-0">
        {pages.entries.map((entryPages, index) => {
          const { entry } = entryPages;
          return (
            <li key={index} className={index > 0 ? 'mt-2' : undefined}>
              <div className="text-muted-foreground flex items-start gap-1.5 py-1 font-sans text-xs">
                <span className={cn(LEAD_SLOT, 'h-4')}>
                  <Search aria-hidden="true" className="ml-px size-2.5" />
                </span>
                <span className="min-w-0 text-pretty wrap-anywhere">
                  <span className="sr-only">Searched for </span>
                  <span className="text-foreground">{entry.query}</span>{' '}
                  <span aria-hidden="true">·</span> <span>{searchQueryStatus(entry)}</span>
                </span>
              </div>
              {entryPages.firstFound.length > 0 ? (
                <ul className="m-0 mt-0.5 list-none py-0 pr-0 pl-3">
                  {entryPages.firstFound.map((source, sourceIndex) => (
                    <li key={source.url}>
                      <SourceButton
                        source={source}
                        repeat={entryPages.firstFound[sourceIndex - 1]?.host === source.host}
                        onOpen={onOpen}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {entryPages.foundEarlier > 0 ? (
                <p className="text-muted-foreground m-0 pt-0.5 pl-11 font-sans text-xs">
                  {`+${String(entryPages.foundEarlier)} found by an earlier search`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {searchFootnotes(row).map((note) => (
        <p
          key={note}
          className="text-muted-foreground mt-2 mb-0 max-w-xl pl-[1.125rem] font-sans text-xs text-pretty"
        >
          {note}
        </p>
      ))}
    </div>
  );
}

function moreSites(more: number): { visible: string; spoken: string } {
  if (more === 0) return { visible: '', spoken: '' };
  const sites = more === 1 ? 'site' : 'sites';
  return { visible: ` +${String(more)} more`, spoken: ` and ${String(more)} more ${sites}` };
}

/** "from" the row's top domains, as shown and as spoken; absent when it found no new page. */
function tailFor(pages: RowPages): { visible: string; spoken: string } | undefined {
  const { top, more } = topDomains(pages);
  if (top.length === 0) return undefined;
  const named = top.join(', ');
  const extra = moreSites(more);
  return { visible: `from ${named}${extra.visible}`, spoken: `from ${named}${extra.spoken}` };
}

/** The row's one line: a live status the reader cannot open yet, or the disclosure. */
function RowHeader({
  label,
  open,
  pulse,
  panelId,
  tail,
  onToggle,
}: Readonly<{
  label: SearchRowLabel;
  open: boolean;
  pulse: boolean;
  panelId: string;
  tail: { visible: string; spoken: string } | undefined;
  onToggle: () => void;
}>): React.JSX.Element {
  if (label.live && !open) {
    return (
      <div aria-hidden="true" className={cn(ROW, 'self-start')}>
        <span className={LEAD_SLOT} />
        <RowLabel text={label.parts.join(' · ')} pulse={pulse} />
      </div>
    );
  }
  return (
    <div className="self-start">
      <BlockToggle
        open={open}
        panelId={panelId}
        parts={label.parts}
        ariaSuffix={tail?.spoken}
        testId={TEST_IDS.webSearchRowToggle}
        onToggle={onToggle}
        pulse={pulse}
      >
        {tail !== undefined && !open ? (
          <span className="min-w-0 truncate font-normal @max-[26rem]:hidden">{tail.visible}</span>
        ) : null}
      </BlockToggle>
    </div>
  );
}

/**
 * A root row's hidden status, the only line a screen reader hears from it. It
 * exists when the row was first drawn while its message streamed, so a row
 * read from history adds no live region.
 */
function RowStatus({
  target,
  streaming,
}: Readonly<{ target: AnnouncedRow; streaming: boolean }>): React.JSX.Element | null {
  const announcement = useSearchAnnouncement(target, streaming);
  const speaks = useFirstRenderStreaming(streaming);
  if (!speaks) return null;
  return (
    <div role="status" className="sr-only">
      {announcement}
    </div>
  );
}

/**
 * One search row: a maximal run of searches with nothing written between them,
 * wherever it happened, inside reasoning or inline in the answer. Live, a root
 * row shows its running queries under a status line; settled, it is a
 * disclosure over the queries and the pages each found first in the message.
 */
export function WebSearchRow({
  node,
  nodeKey,
  context,
  nested,
}: WebSearchRowProps): React.JSX.Element {
  const [open, toggle] = useSegmentOpen(context.messageId, nodeKey);
  const panelId = React.useId();
  const [linkUrl, setLinkUrl] = React.useState<string | null>(null);
  const pages = context.rowPages(nodeKey);
  const label = searchRowLabel(node.row, pages);
  // Lines present when the row first renders are history and never animate in.
  const [enterFrom] = React.useState(node.row.searches.length);
  const showLive = label.live && !open;

  return (
    <div
      data-testid={TEST_IDS.webSearchRow}
      data-state={label.live ? 'live' : 'settled'}
      // A container, so the domain tail drops at phone width rather than
      // squeezing the label.
      className="@container flex flex-col items-stretch"
    >
      <RowHeader
        label={label}
        open={open}
        pulse={label.live && !nested}
        panelId={panelId}
        tail={label.live ? undefined : tailFor(pages)}
        onToggle={toggle}
      />
      {nested ? null : (
        <AnimatedHeight>
          {showLive ? <LiveQueries row={node.row} enterFrom={enterFrom} /> : null}
        </AnimatedHeight>
      )}
      {showLive ? null : (
        <div id={panelId} hidden={!open}>
          {open ? <SearchPanel row={node.row} pages={pages} onOpen={setLinkUrl} /> : null}
        </div>
      )}
      {/* A nested row never speaks: its live parent's status carries its milestones. */}
      {nested ? null : (
        <RowStatus
          target={{ key: nodeKey, row: node.row, pages }}
          streaming={context.isStreaming}
        />
      )}
      <ExternalLinkDialog
        url={linkUrl}
        onClose={() => {
          setLinkUrl(null);
        }}
      />
    </div>
  );
}
