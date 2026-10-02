import { useId } from 'react';
import { CheckField } from '@hushbox/ui/field';
import { isBlocked } from '@/components/decided-work';
import { TEST_IDS } from '@/test-ids';
import { PromptForm } from './prompt-form';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface UnblockBoxProps {
  readonly finding: FindingJson;
  /**
   * The request that sent the caret here. A box that reports drafting has to
   * take the caret back too: Escape hands it to the first box holding unsent
   * words, so one that never consumes the request would swallow it from every
   * box behind it.
   */
  readonly focused: number | null;
  /**
   * The mark the card is holding, which every control offering it reads. Held
   * above rather than here: two boxes each keeping their own copy would drift
   * the moment one of them wrote, and the answer sent from this one would put
   * the reader's own mark back the way it was.
   */
  readonly dedicated: boolean;
  readonly onDedicated: (dedicated: boolean) => void;
  /** The answer that returns the finding to the handoff, leaving the ruling standing. */
  readonly onUnblock: (note: string) => void;
  /** An answer written and not yet sent, which the console's keyboard stays out of. */
  readonly onDrafting: (drafting: boolean) => void;
}

/**
 * The answer to a block, beside the decisions that are the other way to give
 * one: a reader who cannot resolve the question the agent stopped on can rule
 * the finding again instead, and both belong on the screen the reason is on.
 *
 * Offered on the same predicate the Blocked queue collects by, so the control
 * cannot appear on a finding the store would refuse to unblock.
 *
 * The mark rides the answer rather than following it. "This is bigger than the
 * task" is the block an agent raises most often, and the reader answering it is
 * deciding both things at once: two writes would leave the finding back in the
 * handoff and unmarked in between.
 */
export function UnblockBox({
  finding,
  focused,
  dedicated,
  onDedicated,
  onUnblock,
  onDrafting,
}: UnblockBoxProps): JSX.Element | null {
  const markId = useId();

  if (!isBlocked(finding)) return null;

  return (
    <div className="flex flex-col gap-2">
      <PromptForm
        title="Answer the block"
        placeholder="what the agent needs to carry the ruling out"
        submitLabel="Answer and unblock"
        focus={focused}
        onSubmit={onUnblock}
        onDrafting={onDrafting}
      />
      <CheckField
        id={markId}
        size="lg"
        testId={TEST_IDS.unblockDedicated}
        checked={dedicated}
        onCheckedChange={onDedicated}
        label="Needs a session of its own"
      />
    </div>
  );
}
