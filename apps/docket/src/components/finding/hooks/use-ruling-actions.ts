import { useCallback, useSyncExternalStore } from 'react';
import { useAuditAddress } from '@/api/audit-address';
import { undoLastWrite, writeFinding } from '@/api/finding-writes';
import { showUndoToast } from '../logic/undo-toast';
import type { ApiDeps, FindingAction } from '@/api/finding-writes';
import type { UndoNotifier } from '../logic/undo-toast';
import type { FindingJson, FindingState } from '@hushbox/docket';

export interface RulingInput {
  readonly option: string;
  readonly text?: string;
  readonly note?: string;
  /** The mark this ruling would leave the finding carrying, where it decides one. */
  readonly dedicated?: boolean;
}

interface WriteFailure {
  readonly id: string;
  readonly message: string;
}

interface Undoable {
  readonly token: string;
  /**
   * The finding as the write left it. A refused undo changes nothing, so this
   * is still where that finding lives, and holding it here is what keeps the
   * failure branch from having to ask the store.
   */
  readonly finding: FindingJson;
}

interface WriteState {
  readonly failure: WriteFailure | null;
  readonly undoable: Undoable | null;
  /** The findings whose write is parked, waiting for the file to come free. */
  readonly waiting: readonly string[];
}

export interface WriteStore {
  readonly get: () => WriteState;
  readonly set: (next: WriteState) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const NOTHING_IN_FLIGHT: WriteState = { failure: null, undoable: null, waiting: [] };

/**
 * What a write leaves behind, held outside the card that started it. Ruling the
 * last finding of a pane empties the pane, so the card is unmounted before the
 * server answers: a refusal kept in the card's own state would arrive at a mount
 * that no longer exists, and the reader would be told nothing at all on the one
 * write most likely to be the last of their session. The state has to outlive
 * the card for the card that comes back to be able to report it.
 */
export function createWriteStore(): WriteStore {
  let state = NOTHING_IN_FLIGHT;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The console's ruling loop, one store per audit. Everything a write leaves
 * behind names a finding by id, and ids are chosen per audit — so a single
 * store would offer the reader an undo that reverts a file in an audit they are
 * no longer looking at, and report one audit's refusal on the other's card.
 *
 * Kept apart rather than emptied on the way out: the audit a reader leaves
 * mid-session is still where their last write is, and it is still there to be
 * taken back when they come back to it.
 */
const consoleWrites = new Map<string, WriteStore>();

function consoleWritesFor(audit: string): WriteStore {
  const held = consoleWrites.get(audit);
  if (held !== undefined) return held;
  const store = createWriteStore();
  consoleWrites.set(audit, store);
  return store;
}

export interface RulingActionsOptions {
  /** The pane's findings in reading order, already filtered. */
  readonly queue: readonly FindingJson[];
  /** The state this pane is a view of: an action that keeps the finding here does not advance. */
  readonly sectionState: FindingState;
  readonly put: (finding: FindingJson) => void;
  /** Moves within this pane; the finding must still be in it. */
  readonly onFocus: (id: string) => void;
  /** Lands on a finding the caller hands over, switching pane if it has left this one. */
  readonly onLand: (finding: FindingJson) => void;
  readonly api?: ApiDeps;
  readonly notify?: UndoNotifier;
  /** Defaults to the console's own for this audit; a caller supplies one to keep its writes apart. */
  readonly writeStore?: WriteStore;
}

export interface RulingActions {
  readonly rule: (finding: FindingJson, input: RulingInput) => void;
  readonly deny: (finding: FindingJson, reason: string | null) => void;
  readonly ask: (finding: FindingJson, text: string) => void;
  /** Answers the block an agent recorded, which puts the finding back in the handoff. */
  readonly unblock: (finding: FindingJson, note: string, dedicated?: boolean) => void;
  /** Sets or clears the mark on its own, rather than as a rider on a decision. */
  readonly dedicate: (finding: FindingJson, dedicated: boolean) => void;
  /** Takes the decision back and puts the finding in front of the audit again. */
  readonly reopen: (finding: FindingJson) => void;
  readonly undo: () => void;
  readonly canUndo: boolean;
  readonly errorFor: (id: string) => string | null;
  /** The findings the console is still trying to write, and cannot yet. */
  readonly waitingOn: readonly string[];
}

/**
 * A mark rides another write only where it changes the mark. Every write is
 * fenced over the fields it names, so naming this one on every ruling would
 * refuse a decision that raced a mark nobody was arguing about.
 */
function markChange(finding: FindingJson, dedicated: boolean | undefined): { dedicated?: boolean } {
  return dedicated === undefined || dedicated === finding.dedicated ? {} : { dedicated };
}

/**
 * Where the reader lands after a finding leaves the queue: the one below it, or
 * the one above when there is nothing below, so the last ruling of a session
 * does not drop them onto an empty pane.
 */
export function nextInQueue(queue: readonly FindingJson[], id: string): string | null {
  const index = queue.findIndex((finding) => finding.id === id);
  if (index === -1) return null;
  return queue[index + 1]?.id ?? queue[index - 1]?.id ?? null;
}

/**
 * Every write the ruling loop makes, and the one way back from it. The card
 * moves the moment the reader clicks and the server's answer replaces the
 * guess; a refusal puts the finding back exactly as it was and says why.
 */
export function useRulingActions({
  queue,
  sectionState,
  put,
  onFocus,
  onLand,
  api,
  notify = showUndoToast,
  writeStore,
}: RulingActionsOptions): RulingActions {
  const audit = useAuditAddress();
  const { get, set, subscribe } = writeStore ?? consoleWritesFor(audit);
  const state = useSyncExternalStore(subscribe, get);

  /**
   * Which findings the console is waiting on a file for. The server has already
   * waited out its own lock timeout by the time this is set, so a write that
   * reaches it is one the reader would otherwise watch in silence for as long
   * as the other writer keeps the file.
   */
  const waitFor = useCallback(
    (id: string, waiting: boolean): void => {
      const current = get();
      // Every attempt after the first reports the same wait, and every write
      // clears one it may never have set; neither is a change to redraw for.
      if (waiting === current.waiting.includes(id)) return;
      set({
        ...current,
        waiting: waiting ? [...current.waiting, id] : current.waiting.filter((held) => held !== id),
      });
    },
    [get, set]
  );

  /** The console's transport, told to report a wait it can do nothing about. */
  const through = useCallback(
    (id: string): ApiDeps => ({
      ...api,
      onWaiting: () => {
        waitFor(id, true);
      },
    }),
    [api, waitFor]
  );

  const revert = useCallback(
    (target: Undoable): void => {
      set({ ...get(), failure: null });
      void (async (): Promise<void> => {
        const outcome = await undoLastWrite(target.token, through(target.finding.id));
        waitFor(target.finding.id, false);
        if (!outcome.ok) {
          // Nothing changed, so the finding is still where the write left it,
          // and that is where the reader has to be for the message to be on a
          // card they can see.
          onLand(target.finding);
          set({ ...get(), failure: { id: target.finding.id, message: outcome.message } });
          return;
        }
        // The response carries the restored finding, so both the store and the
        // destination come from it. Neither reads the findings list, which is
        // why an undo taken at any later moment still lands correctly.
        put(outcome.value.finding);
        onLand(outcome.value.finding);
        // Taking an older toast leaves the newer write still undoable, so only
        // the write that was actually reverted stops being the latest one.
        const current = get();
        if (current.undoable?.token === target.token) set({ ...current, undoable: null });
      })();
    },
    [get, onLand, put, set, through, waitFor]
  );

  const undo = useCallback((): void => {
    // What the card's Undo button and `U` act on: the most recent write. Each
    // toast holds its own token instead of reading this, so a toast still on
    // screen from two findings ago cannot revert the wrong file.
    const pending = get().undoable;
    if (pending !== null) revert(pending);
  }, [get, revert]);

  const send = useCallback(
    (
      finding: FindingJson,
      write: {
        readonly action: FindingAction;
        readonly body: Readonly<Record<string, unknown>>;
        readonly nextState: FindingState;
        readonly message: string;
      }
    ): void => {
      const { action, body, nextState, message } = write;
      set({ ...get(), failure: null });
      put({ ...finding, state: nextState });
      if (nextState !== sectionState) {
        const target = nextInQueue(queue, finding.id);
        if (target !== null) onFocus(target);
      }
      void (async (): Promise<void> => {
        const outcome = await writeFinding(
          { audit: audit, finding: finding, action: action, body: body },
          through(finding.id)
        );
        waitFor(finding.id, false);
        if (!outcome.ok) {
          put(finding);
          onFocus(finding.id);
          set({ ...get(), failure: { id: finding.id, message: outcome.message } });
          return;
        }
        put(outcome.value.finding);
        const minted = { token: outcome.value.undoToken, finding: outcome.value.finding };
        set({ ...get(), undoable: minted });
        // Closed over the token this write minted, never over whatever is
        // latest when the reader finally reaches the button.
        notify(message, () => {
          revert(minted);
        });
      })();
    },
    [audit, get, notify, onFocus, put, queue, revert, sectionState, set, through, waitFor]
  );

  const rule = useCallback(
    (finding: FindingJson, input: RulingInput): void => {
      const body: Record<string, unknown> = { option: input.option };
      if (input.text !== undefined) body['text'] = input.text;
      if (input.note !== undefined) body['note'] = input.note;
      Object.assign(body, markChange(finding, input.dedicated));
      // Free text is its own decision, so naming the internal option id back at
      // the reader would report something they did not choose.
      const message =
        input.text === undefined ? `Ruled ${finding.id} as ${input.option}` : `Ruled ${finding.id}`;
      send(finding, { action: 'rule', body, nextState: 'ruled', message });
    },
    [send]
  );

  const deny = useCallback(
    (finding: FindingJson, reason: string | null): void => {
      send(finding, {
        action: 'deny',
        body: reason === null ? {} : { reason },
        nextState: 'denied',
        message: `Denied ${finding.id}`,
      });
    },
    [send]
  );

  const ask = useCallback(
    (finding: FindingJson, text: string): void => {
      // A question decides nothing, so the finding does not move: it stays in
      // whatever queue it was in and shows in Questions until an answer lands.
      send(finding, {
        action: 'ask',
        body: { text },
        nextState: finding.state,
        message: `Asked about ${finding.id}`,
      });
    },
    [send]
  );

  const unblock = useCallback(
    (finding: FindingJson, note: string, dedicated?: boolean): void => {
      // The ruling stands, so the state does not move: what moves is the
      // progress status, which is what takes the finding out of Blocked.
      send(finding, {
        action: 'unblock',
        body: { note, ...markChange(finding, dedicated) },
        nextState: finding.state,
        message: `Unblocked ${finding.id}`,
      });
    },
    [send]
  );

  const dedicate = useCallback(
    (finding: FindingJson, dedicated: boolean): void => {
      // A mark says who takes the work, never how far along it is, so the
      // finding does not move: it keeps its state, its ruling and its place.
      send(finding, {
        action: 'dedicate',
        body: { dedicated },
        nextState: finding.state,
        message: dedicated
          ? `Marked ${finding.id} for a session of its own`
          : `Cleared the mark on ${finding.id}`,
      });
    },
    [send]
  );

  const reopen = useCallback(
    (finding: FindingJson): void => {
      send(finding, {
        action: 'reopen',
        body: {},
        nextState: 'open',
        message: `Reopened ${finding.id}`,
      });
    },
    [send]
  );

  const errorFor = useCallback(
    (id: string): string | null => (state.failure?.id === id ? state.failure.message : null),
    [state]
  );

  return {
    rule,
    deny,
    ask,
    unblock,
    dedicate,
    reopen,
    undo,
    canUndo: state.undoable !== null,
    errorFor,
    waitingOn: state.waiting,
  };
}
