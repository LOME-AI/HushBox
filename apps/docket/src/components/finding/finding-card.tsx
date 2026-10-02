import { useCallback, useState } from 'react';
import { Button, cn } from '@hushbox/ui';
import { AlertTriangle } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { FocusedFinding } from '@/components/shell/focused-finding';
import { decisionResetsProgress, isDecided } from '@/components/decided-work';
import { TEST_IDS } from '@/test-ids';
import { BlockedReport } from './blocked-report';
import { DecisionFields } from './decision-fields';
import { DecisionSummary, FREE_TEXT_OPTION, chosenOption } from './decision-summary';
import { FindingBanners } from './finding-banners';
import { FindingHtml } from './finding-html';
import { OptionList } from './option-list';
import { QuestionBox } from './question-box';
import { UnblockBox } from './unblock-box';
import { DiscardPrompt } from './discard-prompt';
import { useFindingHotkeys } from './hooks/use-finding-hotkeys';
import { useRulingActions } from './hooks/use-ruling-actions';
import type { DecisionField } from './decision-fields';
import type { PendingDecision } from './discard-prompt';
import type { ApiDeps } from '@/api/finding-writes';
import type { RulingActions, WriteStore } from './hooks/use-ruling-actions';
import type { UndoNotifier } from './logic/undo-toast';
import type { FindingJson, FindingState } from '@hushbox/docket';
import type { JSX } from 'react';

export interface FindingCardProps {
  readonly finding: FindingJson;
  /** The whole audit: chips and the palette reach outside the current pane. */
  readonly findings: readonly FindingJson[];
  /** The pane's findings in reading order, already filtered. */
  readonly queue: readonly FindingJson[];
  /**
   * This is the card the reader is on. The pane stacks the queue, so the cards
   * either side of it are mounted too and are read rather than acted on: only
   * this one answers a keystroke or offers its keys to the legend.
   */
  readonly active: boolean;
  readonly sectionState: FindingState;
  readonly put: (finding: FindingJson) => void;
  readonly onFocus: (id: string) => void;
  readonly onJump: (id: string) => void;
  /** Lands on the finding the ruling loop hands back, wherever it now belongs. */
  readonly onLand: (finding: FindingJson) => void;
  readonly api?: ApiDeps;
  readonly notify?: UndoNotifier;
  /** Defaults to the console's own, which is what lets a write outlive this card. */
  readonly writeStore?: WriteStore;
}

/**
 * One name space for every box on the card, shared by the two things that have
 * to talk about a box without holding a reference to it: which one the keyboard
 * has been asked to put the caret in, and which ones are carrying words nobody
 * has sent.
 */
const NOTE = 'note:';

/**
 * Which box the caret was asked for, and which request asked. The number rises
 * with every request so that asking twice for the same box moves the caret
 * twice: a reader who presses a shortcut, clicks away, and presses it again is
 * asking for the same thing, and a request that only records the box would look
 * unchanged and go inert.
 */
interface Caret {
  readonly box: string;
  readonly at: number;
}

function decisionCaret(caret: Caret | null): { field: DecisionField; at: number } | null {
  if (caret === null || (caret.box !== 'rule' && caret.box !== 'deny')) return null;
  return { field: caret.box, at: caret.at };
}

/** The request that sent the caret to one named box, where that is where it went. */
function caretIn(caret: Caret | null, box: string): number | null {
  return caret?.box === box ? caret.at : null;
}

function noteCaret(caret: Caret | null): { option: string; at: number } | null {
  if (!caret?.box.startsWith(NOTE)) return null;
  return { option: caret.box.slice(NOTE.length), at: caret.at };
}

/**
 * What the card says about its own writes. A refusal outlives the mount that
 * started it, and a write that is waiting on another writer is otherwise a
 * silence the reader has no way to read.
 */
function WriteNotices({
  failure,
  waitingOn,
}: Readonly<{ failure: string | null; waitingOn: string | null }>): JSX.Element {
  return (
    <>
      {failure !== null && (
        <Notice tone="error" icon={AlertTriangle} destructive data-testid={TEST_IDS.writeError}>
          {failure}
        </Notice>
      )}
      {waitingOn !== null && (
        <p role="status" className="text-muted-foreground text-sm">
          Still saving {waitingOn}: another writer holds the file.
        </p>
      )}
    </>
  );
}

/**
 * What tells a stack of cards apart. Only the reader's answers a keystroke, so
 * it says so: the leading rule is the one the queue rows already use for the
 * same question, and every card reserves its width or becoming the reader's
 * would shift the prose sideways.
 *
 * `tabIndex` is on all of them because the pane hands the keyboard to whichever
 * card a step lands on, and a browser refuses focus to an element that cannot
 * hold it.
 */
function readerMark(active: boolean): {
  readonly 'aria-current'?: 'true';
  readonly tabIndex: number;
  readonly className: string;
} {
  return {
    ...(active ? { 'aria-current': 'true' as const } : {}),
    tabIndex: -1,
    className: cn(
      'flex flex-col border-l-4 border-l-transparent pb-4',
      active && 'border-l-primary'
    ),
  };
}

/** A handler for the keyboard only where the card puts the matching control on screen. */
function offeredWhen(available: boolean, act: () => void): (() => void) | null {
  return available ? act : null;
}

/**
 * Taking a decision back, where the reader took it. Focus mode is where a queue
 * is worked one finding at a time, so sending the reader to another view to
 * undo a decision costs more than the decision did.
 */
function ReopenAction({
  decided,
  onReopen,
}: Readonly<{ decided: boolean; onReopen: () => void }>): JSX.Element | null {
  if (!decided) return null;

  return (
    <Button variant="outline" data-testid={TEST_IDS.reopenFinding} onClick={onReopen}>
      Reopen
    </Button>
  );
}

/**
 * The mark the ruling screen opens on: the one the finding carries, or the one
 * its chosen option calls for. The marker informs the screen and moves nothing
 * on its own, so a proposal shows here and stays a proposal until it is taken.
 */
function markProposedFor(finding: FindingJson): boolean {
  const chosen = chosenOption(finding);
  return (
    finding.dedicated || finding.options.some((option) => option.id === chosen && option.dedicated)
  );
}

/**
 * What choosing an option says about the mark. An option carrying the marker
 * makes the finding dedicated as it is chosen, so the two land in one write;
 * an unmarked option proposes nothing and so never clears a mark.
 */
function markChosenWith(finding: FindingJson, optionId: string): { dedicated?: true } {
  return finding.options.some((option) => option.id === optionId && option.dedicated)
    ? { dedicated: true }
    : {};
}

/** The write a decision stands for, once nothing is left to ask the reader. */
function takeDecision(
  actions: RulingActions,
  finding: FindingJson,
  decision: PendingDecision
): void {
  if (decision.kind === 'rule') actions.rule(finding, decision.input);
  else if (decision.kind === 'deny') actions.deny(finding, decision.reason);
  else actions.reopen(finding);
}

/**
 * One finding and every decision that can be taken on it. This is the surface a
 * long ruling session is spent inside, so the whole of it is reachable from the
 * keyboard and every write has a way back.
 *
 * The finding reads down the left and is acted on down the right, because the
 * reader is doing both at once: an option list under a body long enough to
 * scroll is an option list the reader has to leave the words to reach.
 */
export function FindingCard({
  finding,
  findings,
  queue,
  active,
  sectionState,
  put,
  onFocus,
  onJump,
  onLand,
  api,
  notify,
  writeStore,
}: FindingCardProps): JSX.Element {
  const [caret, setCaret] = useState<Caret | null>(null);
  const [drafting, setDrafting] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [shownId, setShownId] = useState(finding.id);

  /**
   * The reader's answer to the mark, held once for the whole card. Every
   * control offering it reads this and none keeps its own copy: the decisions
   * area sets the mark on its own write and the unblock box sends it with the
   * answer, so two copies would let the second control undo what the first
   * just did while the card went on showing the mark.
   *
   * The seed carries the finding as well as the mark, so it re-seeds both when
   * the reader moves to another finding and when the mark moves underneath
   * them — a ruling on an option carrying the marker moves it, and a control
   * still showing what it opened on would send that back.
   */
  const proposesMark = markProposedFor(finding);
  const markSeed = `${finding.id}|${String(proposesMark)}`;
  const [seededFrom, setSeededFrom] = useState(markSeed);
  const [marked, setMarked] = useState(proposesMark);
  if (seededFrom !== markSeed) {
    setSeededFrom(markSeed);
    setMarked(proposesMark);
  }

  // Moving to another finding must not carry a half-typed denial with it. The
  // card itself stays mounted so the undo of the write that moved us survives;
  // the boxes are keyed to the finding, so each one's words go with it.
  if (shownId !== finding.id) {
    setShownId(finding.id);
    setCaret(null);
    setDrafting([]);
    setPending(null);
  }

  const askFor = useCallback((box: string): void => {
    setCaret((previous) => ({ box, at: (previous?.at ?? 0) + 1 }));
  }, []);

  const markDrafting = useCallback((box: string, on: boolean): void => {
    setDrafting((held) => {
      if (held.includes(box) === on) return held;
      return on ? [...held, box] : held.filter((other) => other !== box);
    });
  }, []);

  const actions = useRulingActions({
    queue,
    sectionState,
    put,
    onFocus,
    onLand,
    ...(api === undefined ? {} : { api }),
    ...(notify === undefined ? {} : { notify }),
    ...(writeStore === undefined ? {} : { writeStore }),
  });

  const failure = actions.errorFor(finding.id);
  const canDeny = finding.state !== 'denied';
  const decided = isDecided(finding);

  function take(decision: PendingDecision): void {
    takeDecision(actions, finding, decision);
  }

  /**
   * Every decision the card can take goes through here, because ruling and
   * denying both archive whatever decision the finding carries now: neither
   * `ruleFinding` nor `denyFinding` has a state guard, and both call the same
   * `clearing()`. The guard is a decision to archive or progress to reset,
   * either on its own: a superseded ruling is somebody's judgement either way,
   * and one keystroke away from a card that reads the same whether or not it has
   * been ruled, while `clearing()` returns the status and the verification to
   * their defaults on a first decision as readily as on a replacement, so a
   * finding an agent had marked would otherwise lose that mark with nothing
   * asked and, there being no decision to archive, no history entry to find it
   * in. Notes are not part of the question: they survive either way, so asking
   * over them would be a warning about nothing.
   */
  function request(decision: PendingDecision): void {
    if (decided || decisionResetsProgress(finding)) {
      setPending(decision);
      return;
    }
    take(decision);
  }

  useFindingHotkeys({
    optionIds: finding.options.map((option) => option.id),
    recommendedId: finding.options.find((option) => option.recommended)?.id ?? null,
    editing: drafting.length > 0,
    active,
    onChooseOption: (optionId) => {
      request({ kind: 'rule', input: { option: optionId, ...markChosenWith(finding, optionId) } });
    },
    onNote: (optionId) => {
      askFor(`${NOTE}${optionId}`);
    },
    onRule: () => {
      askFor('rule');
    },
    onDeny: offeredWhen(canDeny, () => {
      askFor('deny');
    }),
    onAsk: () => {
      askFor('ask');
    },
    // Bound whether or not there is a write to take back, so the way out of a
    // mistake is in the legend before the mistake rather than after it. The
    // action bar has always shown its Undo the same way, disabled.
    onUndo: actions.undo,
    // Nothing on the card closes any more, so Escape hands the reader back to
    // whichever box is holding the console's keyboard. Its own Escape empties
    // it, so two presses is the whole way out and neither destroys words the
    // reader has not been shown first.
    onEscape: () => {
      const held = drafting[0];
      if (held !== undefined) askFor(held);
    },
  });

  return (
    <div data-testid={TEST_IDS.findingCard} {...readerMark(active)}>
      <div className="grid grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
        {/* `min-w-0` on both halves: a grid item sizes to its content by
            default, so one long unbreakable line of code in the prose would
            widen the column and put a scrollbar under the whole document. */}
        <div data-slot="finding-reading" className="flex min-w-0 flex-col gap-3">
          <FocusedFinding finding={finding} />
          <div className="px-4">
            <FindingHtml html={finding.bodyHtml} />
          </div>
          <BlockedReport finding={finding} />
        </div>

        <div data-slot="finding-deciding" className="flex min-w-0 flex-col gap-4 px-4 lg:pt-4">
          <FindingBanners finding={finding} findings={findings} onJump={onJump} />
          {/* Scoped to this finding the way `failure` already is: the store is
              shared across every mounted card, so an unscoped list would speak
              the same sentence from every card the reader has scrolled past. */}
          <WriteNotices
            failure={failure}
            waitingOn={actions.waitingOn.includes(finding.id) ? finding.id : null}
          />
          <DecisionSummary finding={finding} />
          {/* Above the decisions, because re-ruling is the other way to answer
              a block and the two belong in one place. */}
          <UnblockBox
            key={`unblock|${finding.id}`}
            finding={finding}
            focused={caretIn(caret, 'unblock')}
            dedicated={marked}
            onDedicated={setMarked}
            onUnblock={(note) => {
              actions.unblock(finding, note, marked);
            }}
            onDrafting={(on) => {
              markDrafting('unblock', on);
            }}
          />
          <OptionList
            key={`options|${finding.id}`}
            options={finding.options}
            needsOptions={finding.needsOptions}
            chosen={chosenOption(finding)}
            denied={finding.denial !== null}
            noteFocus={noteCaret(caret)}
            onChoose={(optionId) => {
              request({
                kind: 'rule',
                input: { option: optionId, ...markChosenWith(finding, optionId) },
              });
            }}
            onNote={(optionId, note) => {
              request({
                kind: 'rule',
                input: { option: optionId, note, ...markChosenWith(finding, optionId) },
              });
            }}
            onDrafting={(optionId, on) => {
              markDrafting(`${NOTE}${optionId}`, on);
            }}
          />
          <DecisionFields
            key={`decisions|${finding.id}`}
            canDeny={canDeny}
            focused={decisionCaret(caret)}
            dedicated={marked}
            onDedicated={(dedicated) => {
              setMarked(dedicated);
              // A proposal turned down writes nothing: the mark is already
              // where the reader just put it, and a write that changes no
              // field would still fence, mint an undo and speak a toast.
              if (dedicated !== finding.dedicated) actions.dedicate(finding, dedicated);
            }}
            onRule={(text) => {
              request({ kind: 'rule', input: { option: FREE_TEXT_OPTION, text } });
            }}
            onDeny={(reason) => {
              request({ kind: 'deny', reason });
            }}
            onDrafting={markDrafting}
          />
          <QuestionBox
            key={`questions|${finding.id}`}
            questions={finding.questions}
            focused={caretIn(caret, 'ask')}
            onAsk={(text) => {
              actions.ask(finding, text);
            }}
            onDrafting={(on) => {
              markDrafting('ask', on);
            }}
          />

          <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
            <ReopenAction
              decided={decided}
              onReopen={() => {
                request({ kind: 'reopen' });
              }}
            />
            <Button variant="ghost" disabled={!actions.canUndo} onClick={actions.undo}>
              Undo
            </Button>
          </div>
        </div>
      </div>

      <DiscardPrompt
        finding={finding}
        pending={pending}
        onConfirm={(decision) => {
          setPending(null);
          take(decision);
        }}
        onClose={() => {
          setPending(null);
        }}
      />
    </div>
  );
}
