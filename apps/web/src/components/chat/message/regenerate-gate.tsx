import { useLayoutEffect, useMemo, useRef } from 'react';
import { historyCharacterCount, stripReplayHistory } from '@hushbox/shared';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { regenerateRefusalOf, type RerunGateScope } from '@/lib/chat/message-actions';
import type { NoticeReason } from '@hushbox/shared';
import type { Message } from '@/lib/api/api';

interface RegenerateGateProps {
  readonly messages: readonly Message[];
  readonly scope: RerunGateScope;
  /**
   * Told the refusal each time it changes from the last one reported, starting from none, and told
   * `undefined` when the gate unmounts; `undefined` means a re-run may run.
   */
  readonly onRefusal: (refusal: NoticeReason | undefined) => void;
}

/**
 * The send gate's verdict on re-running a turn, read ONCE for the whole list — never once per
 * row, which would put the gate's query stack inside a virtualised item that re-renders on every
 * streaming token. It draws nothing. The list mounts it only for a row that grants a re-run, so
 * a viewer who may not re-run never reads funding or budgets at all.
 *
 * The refusal is reported in a layout effect, so the list redraws with it before the browser
 * paints. Mounting the list's rows inside this component instead would remount the thread each
 * time the row's grant changed, as it does when a write link's privilege arrives after load.
 */
export function RegenerateGate({ messages, scope, onRefusal }: RegenerateGateProps): null {
  // `value: ''` is the point: a re-run sends the history, not the draft in the composer, so the
  // draft's length must not enter its verdict. Counted over the trimmed replay: the re-run sends
  // assistant answers with their embedded reasoning stripped, so pricing the untrimmed rows would
  // gate the button on bytes no send ever carries. A turn-notice row is display only: no re-run
  // carries it.
  const historyCharacters = useMemo(
    () =>
      historyCharacterCount(stripReplayHistory(messages.filter((m) => m.turnNotice === undefined))),
    [messages]
  );
  const gate = usePromptBudget({ value: '', historyCharacters, ...scope });
  // Money in full, entitlement exempt: a re-run does not re-buy premium access.
  const refusal = regenerateRefusalOf(gate);
  // Reporting only a change keeps an unchanged verdict from costing the list a render.
  const reported = useRef<NoticeReason | undefined>(undefined);
  useLayoutEffect(() => {
    if (refusal === reported.current) return;
    reported.current = refusal;
    onRefusal(refusal);
  }, [onRefusal, refusal]);
  useLayoutEffect(
    () => () => {
      reported.current = undefined;
      onRefusal(reported.current);
    },
    [onRefusal]
  );
  return null;
}
