import * as React from 'react';
import {
  formatNanoUsdCost,
  NanoUSD,
  nanoUSD,
  serializeNanoUSD,
  TEST_ID_BUILDERS,
  TEST_IDS,
} from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { CircleAlert, Icon, Lock } from '@hushbox/ui/icons';
import { Swatch } from '@hushbox/ui/marks';
import { nameplateFor } from '@/components/chat/message/model-nameplate';
import { DottedLine, type MetaItem } from '@/components/chat/message/dotted-line';
import { TrustLine } from '@/components/shared/trust-line';
import { formatReplyDate } from '@/lib/chat/reply-date';
import { askedModelId } from '@/lib/chat/regeneration';
import { isStoredRow } from '@/lib/chat/stored-row';
import { assignModelSwatches } from '@/lib/utils/model-color';
import { useModelStore, type SelectedModelEntry } from '@/stores/model';
import type { Message } from '@/lib/api/api';
import type { ComparePresentation } from '@/components/chat/message/ai-message-block';
import type { Model } from '@hushbox/shared';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

/**
 * One reply of a compare turn: the message its tab describes, and the row drawn for it as
 * the group asks.
 */
interface CompareReply {
  message: Message;
  render: (compare: ComparePresentation) => React.ReactNode;
}

interface CompareGroupProps {
  /** One turn's replies, in the order the turn asked its models. */
  replies: readonly CompareReply[];
  models: readonly Model[];
  /** Whether the viewer may send to the conversation, which Continue and its summary line need. */
  canSend: boolean;
}

/** A reply drops the chat column's gutters: the group's own stand around its replies. */
const COLUMN_SIDE_PADDING = 'px-0';

/** Where the group shows columns, each answer is set a step below the thread's size. */
const COLUMN_TEXT_SCALE = '@cmp-columns/cmp:text-body-sub';

/** The presentation the group holds for the reply at `index`; it holds one for every reply. */
function presentationAt(
  presentations: readonly ComparePresentation[],
  index: number
): ComparePresentation {
  const presentation = presentations[index];
  /* v8 ignore next -- the presentations are built from the replies themselves, one apiece. */
  if (presentation === undefined) throw new Error('compare group: no presentation for a reply');
  return presentation;
}

/** Four replies sit two by two at three-across widths, so each pair keeps a full row. */
const TWO_BY_TWO = 4;

/** The model id a reply's swatch and name are keyed by, as its nameplate keys them. */
function modelIdOf(reply: Message): string {
  return reply.modelName ?? 'AI';
}

/** A reply's own cost, as the figure its tab shows; nothing while it has none to show. */
function costFigure(cost: string | undefined): string | undefined {
  if (cost === undefined || !NanoUSD.safeParse(cost).success) return undefined;
  return formatNanoUsdCost(cost);
}

/** The sum of the replies' own costs, as the summary shows it; nothing while none has one. */
function turnTotal(replies: readonly CompareReply[]): string | undefined {
  let total: bigint | undefined;
  for (const { message } of replies) {
    const cost = NanoUSD.safeParse(message.cost);
    if (cost.success) total = (total ?? 0n) + cost.data;
  }
  return total === undefined ? undefined : formatNanoUsdCost(serializeNanoUSD(nanoUSD(total)));
}

/** Makes `model` the composer's one selection, in the model's own modality, and shows it. */
function continueWith(model: Model): void {
  const { setSelectedModels, setActiveModality } = useModelStore.getState();
  setSelectedModels(model.modality, [{ id: model.id, name: model.name }]);
  setActiveModality(model.modality);
}

/** Continue with this model, offered only to a viewer who can send. */
function ContinueControl({ model }: Readonly<{ model: Model }>): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={TEST_IDS.continueWithModel}
      className="text-ui-sm text-foreground grow px-2.5"
      onClick={() => {
        continueWith(model);
      }}
    >
      Continue with this model
    </Button>
  );
}

const COUNT_WORDS: ReadonlyMap<number, string> = new Map([
  [3, 'three'],
  [4, 'four'],
  [5, 'five'],
]);

/** Where the next message goes while the composer holds a turn's `count` models. */
function nextMessageLine(count: number): string {
  if (count === 2) return 'Your next message goes to both';
  return `Your next message goes to all ${COUNT_WORDS.get(count) ?? String(count)}`;
}

/** Whether the selection holds exactly the turn's models, in whatever order. */
function selectionIsTurn(
  selection: readonly SelectedModelEntry[],
  turnIds: ReadonlySet<string>
): boolean {
  return selection.length === turnIds.size && selection.every(({ id }) => turnIds.has(id));
}

/** What the summary states about the turn as a whole: its total, its storage and its date. */
function summaryFacts(replies: readonly CompareReply[]): MetaItem[] {
  const facts: MetaItem[] = [];
  const total = turnTotal(replies);
  if (total !== undefined) {
    facts.push({
      key: 'total',
      node: (
        <span>
          <span className="text-foreground font-mono tabular-nums">{total}</span> for this question
        </span>
      ),
    });
  }
  const first = replies[0]?.message;
  if (first !== undefined && replies.every(({ message }) => isStoredRow(message))) {
    facts.push(
      { key: 'saved', node: <TrustLine icon={Lock}>Saved encrypted</TrustLine> },
      {
        key: 'date',
        node: (
          <time dateTime={first.createdAt}>{formatReplyDate(first.createdAt, new Date())}</time>
        ),
      }
    );
  }
  return facts;
}

/**
 * Whether the composer still holds the turn: its modality is the turn's and its selection is
 * the turn's models, in whatever order.
 */
function useComposerHoldsTurn(turnModels: readonly Model[], turnIds: ReadonlySet<string>): boolean {
  const modality = turnModels[0]?.modality;
  const activeModality = useModelStore((state) => state.activeModality);
  const selection = useModelStore((state) =>
    modality === undefined ? undefined : state.selections[modality]
  );
  return (
    activeModality === modality && selection !== undefined && selectionIsTurn(selection, turnIds)
  );
}

interface TurnSummaryProps {
  replies: readonly CompareReply[];
  /** The turn's models as the catalog offers them; a model it does not offer is left out. */
  turnModels: readonly Model[];
  /** Whether the viewer may send, without which the composer holds nothing to describe. */
  canSend: boolean;
}

/**
 * The line under a turn's replies: its total, its storage state and its date once for the
 * whole turn, and where the next message goes while the composer still holds the turn.
 */
function TurnSummary({
  replies,
  turnModels,
  canSend,
}: Readonly<TurnSummaryProps>): React.JSX.Element | null {
  const turnIds = new Set(replies.flatMap(({ message }) => askedModelId(message) ?? []));
  const holdsTurn = useComposerHoldsTurn(turnModels, turnIds);
  const facts = summaryFacts(replies);
  const next = canSend && holdsTurn;
  if (facts.length === 0 && !next) return null;
  return (
    <div
      data-chrome=""
      className="text-caption text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1"
    >
      {facts.length > 0 && <DottedLine items={facts} />}
      {next && <span>{nextMessageLine(turnIds.size)}</span>}
    </div>
  );
}

const TAB_CLASS =
  'flex min-h-11 min-w-0 items-start gap-[0.4375rem] rounded-md border border-border-control bg-transparent px-2.5 py-1.5 text-start text-ui-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent aria-selected:border-foreground aria-selected:bg-accent aria-selected:font-semibold aria-selected:text-foreground';

interface CompareTabProps {
  reply: Message;
  models: readonly Model[];
  swatch: ModelSwatch;
  selected: boolean;
  index: number;
  tabId: string;
  panelId: string;
  onSelect: (index: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => void;
  tabRef: (index: number, tab: HTMLButtonElement | null) => void;
}

/**
 * One reply's tab: its swatch, its model's short name, and its cost, or the error mark
 * where a failed model has no cost. The cost is the tab's own text, never the reply's cost
 * figure, which only the reply itself carries.
 */
const CompareTab = React.memo(function CompareTab({
  reply,
  models,
  swatch,
  selected,
  index,
  tabId,
  panelId,
  onSelect,
  onKeyDown,
  tabRef,
}: Readonly<CompareTabProps>): React.JSX.Element {
  const name = nameplateFor(reply, models).modelName;
  const failed = reply.errorCode !== undefined;
  const figure = failed ? undefined : costFigure(reply.cost);
  return (
    <button
      ref={(tab) => {
        tabRef(index, tab);
      }}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      data-testid={TEST_ID_BUILDERS.compareTab(index)}
      onClick={() => {
        onSelect(index);
      }}
      onKeyDown={(event) => {
        onKeyDown(event, index);
      }}
      className={TAB_CLASS}
    >
      <span className="mt-1.5 flex shrink-0">
        <Swatch swatch={swatch} />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate">{name}</span>
        {failed ? (
          <Icon icon={CircleAlert} size="sm" label="Failed" className="text-error my-px" />
        ) : null}
        {figure === undefined ? null : (
          <span className="text-caption text-muted-foreground font-mono tabular-nums">
            {figure}
          </span>
        )}
      </span>
    </button>
  );
});

/**
 * The column dividers. Two across, every second column draws one; three across, every
 * column but a row's first does, except four replies, which stay two by two.
 */
function dividerClass(index: number, count: number): string {
  return cn(
    index % 2 === 1 && '@cmp-columns/cmp:before:block',
    count !== TWO_BY_TWO &&
      (index % 3 === 0 ? '@cmp-grid/cmp:before:hidden' : '@cmp-grid/cmp:before:block')
  );
}

/**
 * Whether the tab strip's tabs are wider than the strip, so some scroll out of view. It
 * re-measures whenever the strip or a tab changes size: a narrower group shrinks the strip,
 * a larger text size widens the tabs inside a strip of the same width.
 */
function useOverflowing(element: HTMLElement | null, count: number): boolean {
  const [overflowing, setOverflowing] = React.useState(false);
  React.useLayoutEffect(() => {
    if (element === null) return;
    const measure = (): void => {
      setOverflowing(element.scrollWidth > element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const tab of element.children) observer.observe(tab);
    return (): void => {
      observer.disconnect();
    };
  }, [element, count]);
  return overflowing;
}

/**
 * The tab a key moves to from `index`, or none for a key that does not move between tabs.
 * The arrows wrap at either end.
 */
function tabAfterKey(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight': {
      return (index + 1) % count;
    }
    case 'ArrowLeft': {
      return (index - 1 + count) % count;
    }
    case 'Home': {
      return 0;
    }
    case 'End': {
      return count - 1;
    }
    default: {
      return undefined;
    }
  }
}

/**
 * A turn's replies from several models, laid out by the width this group is given rather
 * than the viewport's: below `cmp-columns` they are tabs showing one reply at a time; from
 * there they are columns, three across from `cmp-grid`. The group is wider than the chat
 * column, so a wide main area holds three readable columns.
 *
 * Each reply renders as the row the thread draws for a lone reply, so a reply in a compare
 * group carries every control and state a lone one does. The group tells each row how to
 * draw: the swatch its tab wears, no chat column gutters, and the column text size. The row
 * pads itself to the chat column's gutters; inside a column those gutters are the group's,
 * so a column takes them off.
 */
export function CompareGroup({
  replies,
  models,
  canSend,
}: Readonly<CompareGroupProps>): React.JSX.Element {
  const baseId = React.useId();
  const [chosen, setChosen] = React.useState(0);
  const current = Math.min(chosen, replies.length - 1);
  const tabs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [strip, setStrip] = React.useState<HTMLDivElement | null>(null);
  const overflowing = useOverflowing(strip, replies.length);

  const modelKey = replies.map(({ message }) => modelIdOf(message)).join('\n');
  const swatches = React.useMemo(() => assignModelSwatches(modelKey.split('\n')), [modelKey]);
  // A reply's model as the catalog offers it; Continue needs the catalog's modality and name.
  const catalogModels = React.useMemo(
    () => modelKey.split('\n').map((modelId) => models.find((entry) => entry.id === modelId)),
    [modelKey, models]
  );
  // Held across renders while the turn's models stay the same, so a row's memo is not undone
  // by a fresh presentation on every streamed token.
  const presentations = React.useMemo(
    () =>
      modelKey.split('\n').map((modelId, index): ComparePresentation => {
        const model = catalogModels[index];
        return {
          /* v8 ignore next -- `assignModelSwatches` assigns every id it is given, so the fallback never runs. */
          swatch: swatches.get(modelId) ?? 1,
          sidePadding: COLUMN_SIDE_PADDING,
          textScale: COLUMN_TEXT_SCALE,
          leadingControl:
            canSend && model !== undefined ? <ContinueControl model={model} /> : undefined,
        };
      }),
    [modelKey, swatches, catalogModels, canSend]
  );
  const turnModels = catalogModels.filter((model) => model !== undefined);

  const tabRef = React.useCallback((index: number, tab: HTMLButtonElement | null): void => {
    tabs.current[index] = tab;
  }, []);

  const count = replies.length;
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
      const next = tabAfterKey(event.key, index, count);
      if (next === undefined) return;
      event.preventDefault();
      setChosen(next);
      tabs.current[next]?.focus();
    },
    [count]
  );

  const tabId = (index: number): string => `${baseId}-tab-${String(index)}`;
  const panelId = (index: number): string => `${baseId}-panel-${String(index)}`;

  return (
    <div
      data-testid={TEST_IDS.compareGroup}
      className="@container/cmp mx-auto box-content max-w-6xl px-4 pb-7.5 md:px-6"
    >
      <div className="flex flex-col gap-4">
        {/* While tabs scroll out of view the strip fades at its end, and its end padding lets
            the last tab scroll clear of the fade. */}
        <div
          ref={setStrip}
          role="tablist"
          aria-label="Replies"
          {...(overflowing && { 'data-many': 'true' })}
          className="@cmp-columns/cmp:hidden -m-1 grid [scrollbar-width:none] auto-cols-[minmax(6.5rem,1fr)] grid-flow-col gap-1.5 overflow-x-auto p-1 data-many:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] data-many:pe-8 [&::-webkit-scrollbar]:hidden"
        >
          {replies.map(({ message: reply }, index) => (
            <CompareTab
              key={reply.id}
              reply={reply}
              models={models}
              swatch={presentationAt(presentations, index).swatch}
              selected={index === current}
              index={index}
              tabId={tabId(index)}
              panelId={panelId(index)}
              onSelect={setChosen}
              onKeyDown={onKeyDown}
              tabRef={tabRef}
            />
          ))}
        </div>
        <div
          className={cn(
            '@cmp-columns/cmp:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] grid grid-cols-1 gap-x-8 gap-y-10',
            count === TWO_BY_TWO && '@cmp-grid/cmp:grid-cols-2'
          )}
        >
          {replies.map(({ message: reply, render }, index) => (
            <div
              key={reply.id}
              role="tabpanel"
              id={panelId(index)}
              aria-label={nameplateFor(reply, models).modelName}
              data-testid={TEST_ID_BUILDERS.compareColumn(index)}
              data-current={String(index === current)}
              className={cn(
                'relative flex min-w-0 flex-col',
                'before:border-border before:absolute before:inset-y-0 before:-start-4 before:hidden before:border-s',
                index !== current && '@max-cmp-columns/cmp:hidden',
                dividerClass(index, count)
              )}
            >
              {render(presentationAt(presentations, index))}
            </div>
          ))}
        </div>
        <TurnSummary replies={replies} turnModels={turnModels} canSend={canSend} />
      </div>
    </div>
  );
}
