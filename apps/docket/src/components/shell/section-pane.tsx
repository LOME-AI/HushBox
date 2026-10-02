import { useDeferredValue, useRef } from 'react';
import { Button, EmptyState } from '@hushbox/ui';
import { PromptDraftScope } from '@/components/finding/prompt-form';
import { TEST_IDS } from '@/test-ids';
import { FindingRow } from './finding-row';
import { FocusedFinding } from './focused-finding';
import { currentIn } from './logic/queue-step';
import { useReachSentinel } from './hooks/use-reach-sentinel';
import { useScrollIntoView } from './hooks/use-scroll-into-view';
import { useStackWindow } from './hooks/use-stack-window';
import { useVisibleFinding } from './hooks/use-visible-finding';
import type { SectionSpec } from './logic/sections';
import type { ViewMode } from './logic/view-mode';
import type { FindingJson } from '@hushbox/docket';
import type { RefObject } from 'react';
import type { JSX } from 'react';

export interface SectionPaneProps {
  readonly section: SectionSpec;
  /** Already narrowed to this section and to the active filters. */
  readonly findings: readonly FindingJson[];
  readonly focus: string | null;
  /** Opens the finding a reader picked off the queue, which is a different act from stepping to it. */
  readonly onOpen: (id: string) => void;
  /**
   * The reader scrolled a different finding to the top of the stack. It moves
   * where the keyboard aims and nothing else: a scroll is not a step, so it
   * neither announces itself nor spends a history entry.
   */
  readonly onSee?: (id: string) => void;
  readonly mode: ViewMode;
  readonly filtering: boolean;
  readonly onClearFilters: () => void;
  /**
   * How a finding in the stack is rendered; the identity block when nothing
   * else is supplied. `active` is the one the reader is on, handed down rather
   * than compared against `focus` by the caller: the pane falls back to the
   * head of its queue when the focused finding is not in this section, so the
   * reader's card is not always the one `focus` names.
   */
  readonly renderDetail?: (finding: FindingJson, active: boolean) => JSX.Element;
  /** Replaces the queue entirely, for a section that is not a list of findings. */
  readonly renderBody?: (findings: readonly FindingJson[]) => JSX.Element;
  /** Pane-level work above the queue, for a section that is still a ruling queue underneath. */
  readonly renderLead?: (findings: readonly FindingJson[]) => JSX.Element | null;
  /**
   * Replaces the row list in list mode only. Focus mode keeps the card, because
   * that is where a write's outcome is reported and a section without one has
   * nowhere to show a refusal.
   *
   * The focused finding is handed down rather than read: the shell holds the
   * url's single writer, so a pane calling `useSearchState` would be a second
   * one and lose updates against it, and reading `location.search` lags a
   * commit because the shell writes it from an effect.
   */
  readonly renderList?: (findings: readonly FindingJson[], focus: string | null) => JSX.Element;
}

/**
 * What the reader is on, per mode. Only one of the two is on screen at a time,
 * so the other's anchor is null and its ref holds nothing to scroll. The
 * section is part of the anchor because the same finding in a different section
 * is a different row in a different list, and a link that resolves its section
 * after mount would otherwise never scroll to it.
 *
 * `row` is the focused id only once the list holds it: the scroll fires once
 * per anchor, so aiming it at a row the list has not caught up to would spend
 * it on nothing and never come back to it.
 */
function anchors(
  section: SectionSpec,
  mode: ViewMode,
  row: string | null,
  detail: FindingJson | undefined
): { readonly row: string | null; readonly detail: string | null } {
  const at = (id: string | null): string | null => (id === null ? null : `${section.id}|${id}`);
  return mode === 'list'
    ? { row: at(row), detail: null }
    : { row: null, detail: at(detail?.id ?? null) };
}

/** A pane whose caller does not care where the reader scrolled to. */
function noop(): void {
  return undefined;
}

/**
 * Which queue the stack belongs to. A section, a filter, or a write that moves
 * a finding out of the section all hand over a different queue, and what the
 * reader grew the stack to on the one before it is not theirs. The ends are in
 * it because two different filters can leave the same number of findings.
 */
function queueKey(section: SectionSpec, findings: readonly FindingJson[]): string {
  const ends = `${findings[0]?.id ?? ''}|${findings.at(-1)?.id ?? ''}`;
  return `${section.id}|${String(findings.length)}|${ends}`;
}

/**
 * The queue on screen. It reads by scrolling rather than paging: the findings
 * either side of the reader's are already mounted, and reaching the bottom
 * mounts more of the queue until there is none left. `j` and `k` and the
 * reader's own scrolling both move which card the keyboard answers.
 */
function FindingStack({
  shown,
  more,
  activeId,
  stackRef,
  activeRef,
  endRef,
  renderDetail,
}: Readonly<{
  shown: readonly FindingJson[];
  more: boolean;
  activeId: string;
  stackRef: RefObject<HTMLDivElement | null>;
  activeRef: RefObject<HTMLDivElement | null>;
  endRef: RefObject<HTMLDivElement | null>;
  renderDetail: (finding: FindingJson, active: boolean) => JSX.Element;
}>): JSX.Element {
  return (
    <div ref={stackRef} className="flex flex-col">
      {shown.map((stacked) => (
        <div
          key={stacked.id}
          data-finding={stacked.id}
          {...(stacked.id === activeId ? { ref: activeRef } : {})}
          className="border-border border-b"
        >
          {/* The pane is what knows which finding the card is about, and an
              unsent draft has to be keyed to it or it would be given back on
              another. A card the stack lets go of keeps its words this way. */}
          <PromptDraftScope finding={stacked.id}>
            {renderDetail(stacked, stacked.id === activeId)}
          </PromptDraftScope>
        </div>
      ))}
      {/* What the reader scrolls into to ask for the next of the queue. It
          carries nothing to read, so it is hidden from anyone listening. */}
      {more && <div ref={endRef} data-slot="stack-end" aria-hidden className="h-px" />}
    </div>
  );
}

export function SectionPane({
  section,
  findings,
  focus,
  onOpen,
  onSee = noop,
  mode,
  filtering,
  onClearFilters,
  renderDetail = (finding) => <FocusedFinding finding={finding} />,
  renderBody,
  renderLead = () => null,
  renderList,
}: SectionPaneProps): JSX.Element {
  const rowRef = useRef<HTMLLIElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const current = currentIn(findings, focus);
  /**
   * Widening a filter mounts every row it brought back, and one keystroke that
   * deletes a search term can bring back the whole audit. Deferring the list
   * hands that mount to a pass React can interrupt, so the keystroke itself
   * stays cheap; narrowing costs nothing extra because the surviving rows are
   * already mounted. Only the list defers: the empty state and the focused
   * card answer the reader's own move and must not lag behind it.
   */
  const listed = useDeferredValue(findings);

  const at = findings.findIndex((finding) => finding.id === current?.id);
  const stack = useStackWindow(findings, at, queueKey(section, findings));

  const mounted = listed.some((finding) => finding.id === focus) ? focus : null;
  const anchor = anchors(section, mode, mounted, current);
  useScrollIntoView(rowRef, anchor.row, 'nearest');
  const arrived = useScrollIntoView(detailRef, anchor.detail, 'start');

  // The reader's own scrolling moves what they are on, so the finding it
  // reports is one they have already arrived at. Marking it keeps the scroller
  // off a move the reader made with their own hand; a step, a jump or a click
  // is a finding this never reported, so those still scroll.
  //
  // Marking is only sound because `onSee` really does move what the reader is
  // on: a caller that takes the default swallows the report, and the anchor
  // marked as arrived at never becomes one, so a later deliberate move to that
  // finding would find it already marked and skip its scroll.
  const seen = (id: string): void => {
    arrived(`${section.id}|${id}`);
    onSee(id);
  };
  useVisibleFinding(
    stackRef,
    stack.shown.map((finding) => finding.id),
    seen
  );
  useReachSentinel(endRef, stack.shown.length, stack.extend);

  if (current === undefined) {
    // A filtered-out section is not an empty section, and telling the reader the
    // audit is finished when a filter is hiding the work would be a lie.
    return filtering ? (
      <EmptyState
        title="No finding matches these filters"
        description="Widen the filters or clear them to see the rest of this section."
        action={
          <Button variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState title={section.emptyTitle} description={section.emptyDescription} />
    );
  }

  if (renderBody !== undefined) return renderBody(findings);

  const lead = renderLead(findings);

  if (mode === 'list') {
    return (
      <>
        {lead}
        {renderList === undefined ? (
          <ul data-testid={TEST_IDS.findingList} className="flex flex-col">
            {listed.map((finding) => (
              <FindingRow
                key={finding.id}
                {...(finding.id === focus ? { ref: rowRef } : {})}
                finding={finding}
                selected={finding.id === focus}
                onSelect={onOpen}
              />
            ))}
          </ul>
        ) : (
          renderList(listed, focus)
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col">
      {lead}
      <FindingStack
        shown={stack.shown}
        more={stack.more}
        activeId={current.id}
        stackRef={stackRef}
        activeRef={detailRef}
        endRef={endRef}
        renderDetail={renderDetail}
      />
      {/* Where the reader is, and nothing to click: the queue is stepped from
          the keyboard, so a paging control would only interrupt a reader
          already moving through it. */}
      <div className="border-border flex items-center gap-2 border-t px-4 py-2">
        <span className="text-muted-foreground text-sm">
          {at + 1} of {findings.length}
        </span>
      </div>
    </div>
  );
}
