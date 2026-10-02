import * as React from 'react';
import { REASONING_EFFORT_LABELS, TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { answerSubject, thinkingLabel } from '@/components/chat/indicators/thinking-label';
import {
  BlockToggle,
  LEAD_SLOT,
  READING,
  ROW,
  RowLabel,
} from '@/components/chat/segments/block-chrome';
import { summarizeChildren } from '@/components/chat/segments/segment-summaries';
import { useSegmentOpen } from '@/components/chat/segments/segment-view-state';
import { useSearchAnnouncement } from '@/components/chat/segments/use-search-announcement';
import { useFirstRenderStreaming } from '@/components/chat/segments/use-first-render-streaming';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { AnnouncedRow } from '@/components/chat/segments/use-search-announcement';
import type { ReasoningSegment } from '@hushbox/shared';

interface ThinkingDisclosureProps {
  readonly node: ReasoningSegment;
  readonly nodeKey: string;
  readonly context: SegmentRenderContext;
  /** The span's children, already rendered through the segment dispatcher. */
  readonly children: React.ReactNode;
}

function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** The surface's outer slot, identical in every state so the row never shifts. */
function Surface({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div data-testid={TEST_IDS.thinkingDisclosure}>{children}</div>;
}

/**
 * What live reasoning says: the model's deepest live activity, or that it is
 * thinking plus what its settled children already found.
 */
function liveLabel(
  modelName: string | undefined,
  activity: string | undefined,
  fragments: readonly string[]
): string {
  if (activity !== undefined) return `${answerSubject(modelName)} is ${activity}`;
  return [thinkingLabel(modelName), ...fragments].join(' · ');
}

/**
 * The one line live reasoning shows. It is what a sighted reader sees and
 * changes as the model works; a screen reader hears the span's hidden status
 * instead, which says only milestones.
 */
function LiveLine({ label }: Readonly<{ label: string }>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.thinkingDisclosureStatus} aria-hidden="true" className={ROW}>
      <span className={LEAD_SLOT} />
      <RowLabel text={label} pulse />
    </div>
  );
}

/** The span's latest search row, the one its status speaks for. */
function latestRow(
  node: ReasoningSegment,
  context: SegmentRenderContext
): AnnouncedRow | undefined {
  const row = node.children.findLast((child) => child.kind === 'webSearch');
  if (row === undefined) return undefined;
  const key = context.keyOf(row);
  return { key, row: row.row, pages: context.rowPages(key) };
}

/**
 * The quiet line for a model that bills reasoning and emits none. Plain text
 * rather than a control, because there is nothing behind it to open; the count
 * stays here because the reader is billed for it and no other row accounts for
 * it once the effort rung takes the label.
 */
export function ReasoningNotShared({
  tokenCount,
}: Readonly<{ tokenCount: number }>): React.JSX.Element {
  return (
    <Surface>
      <p data-testid={TEST_IDS.reasoningNotShared} className={ROW}>
        <span className={LEAD_SLOT} aria-hidden="true" />
        <span>{`Reasoning not shared · ${formatTokenCount(tokenCount)} tokens`}</span>
      </p>
    </Surface>
  );
}

/** What follows "Reasoning" on a settled label, before the children's fragments. */
function disclosureDetail(nodeKey: string, context: SegmentRenderContext): string | undefined {
  // Effort is one setting per message, so only the first span names it.
  if (nodeKey !== context.firstReasoningKey) return undefined;
  // A turn can stream reasoning and never reach an answer — the hard stop cutting
  // the stream mid-reasoning is one way — which leaves a trace with no answer
  // after it.
  if (!context.hasAnswer && !context.isStreaming) return 'stopped before an answer';
  if (context.reasoningEffort === undefined) return undefined;
  return `${REASONING_EFFORT_LABELS[context.reasoningEffort]} effort`;
}

/** What the span's hidden status says: the latest search's milestone, else that the model is thinking. */
function spanMilestone(live: boolean, searchNews: string | undefined, modelName?: string): string {
  if (!live) return searchNews ?? '';
  // '' is a search row first seen settled, which is history: the span's start stands.
  return searchNews === undefined || searchNews === '' ? thinkingLabel(modelName) : searchNews;
}

/** A settled span's disclosure button: "Reasoning", its detail, and its children's fragments. */
function SettledHeader({
  nodeKey,
  context,
  fragments,
  open,
  panelId,
  onToggle,
}: Readonly<{
  nodeKey: string;
  context: SegmentRenderContext;
  fragments: readonly string[];
  open: boolean;
  panelId: string;
  onToggle: () => void;
}>): React.JSX.Element {
  const detail = disclosureDetail(nodeKey, context);
  return (
    <BlockToggle
      open={open}
      panelId={panelId}
      parts={['Reasoning', ...(detail === undefined ? [] : [detail]), ...fragments]}
      testId={TEST_IDS.thinkingDisclosureToggle}
      onToggle={onToggle}
    />
  );
}

/**
 * A settled span's body. Mounted while collapsed so `aria-controls` always
 * resolves; it holds the children only once opened, so a resting row carries
 * no trace.
 */
function TracePanel({
  panelId,
  open,
  tokenCount,
  children,
}: Readonly<{
  panelId: string;
  open: boolean;
  tokenCount: number;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div id={panelId} hidden={!open}>
      {open ? (
        <>
          <div
            data-testid={TEST_IDS.thinkingDisclosureContent}
            className={cn(READING, 'mt-2 leading-[1.7] break-words')}
          >
            {children}
          </div>
          {tokenCount > 0 ? (
            <p className="text-muted-foreground pl-[1.125rem] font-sans text-xs">
              {`${formatTokenCount(tokenCount)} reasoning tokens`}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * One reasoning span: a single line of chrome that is a live status while the
 * model works and a disclosure once it has finished, in the same place, with
 * the span's children hanging beneath it in the subordinate reading register.
 *
 * Live reasoning shows its one-liner and nothing else: no thoughts and no
 * nested blocks until it settles, so nothing inside it can take focus or be
 * announced token by token. Its hidden status carries the milestones of the
 * searches inside it; a nested block never announces itself.
 */
export function ThinkingDisclosure({
  node,
  nodeKey,
  context,
  children,
}: ThinkingDisclosureProps): React.JSX.Element {
  const [open, toggle] = useSegmentOpen(context.messageId, nodeKey);
  const panelId = React.useId();
  const summary = summarizeChildren(node.children, context);
  const live = context.liveReasoningKey === nodeKey;
  const speaks = useFirstRenderStreaming(context.isStreaming);
  // Once a search has spoken, its result stays the status while the model
  // thinks on, so "is thinking" is announced once and never repeated.
  const searchNews = useSearchAnnouncement(latestRow(node, context), context.isStreaming);
  const tokenCount = nodeKey === context.firstReasoningKey ? (context.reasoningTokens ?? 0) : 0;

  return (
    <Surface>
      {live ? (
        <LiveLine label={liveLabel(context.modelName, summary.liveActivity, summary.fragments)} />
      ) : (
        <SettledHeader
          nodeKey={nodeKey}
          context={context}
          fragments={summary.fragments}
          open={open}
          panelId={panelId}
          onToggle={toggle}
        />
      )}
      {live ? null : (
        <TracePanel panelId={panelId} open={open} tokenCount={tokenCount}>
          {children}
        </TracePanel>
      )}
      {/* The same element whether live or settled, so a search that settles in
          the frame the answer starts still gets its result announced. */}
      {speaks ? (
        <div role="status" className="sr-only">
          {spanMilestone(live, searchNews, context.modelName)}
        </div>
      ) : null}
    </Surface>
  );
}
