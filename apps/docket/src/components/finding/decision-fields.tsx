import { useId } from 'react';
import { CheckField } from '@hushbox/ui/field';
import { TEST_IDS } from '@/test-ids';
import { PromptForm } from './prompt-form';
import type { JSX } from 'react';

/** The two decisions the card takes in words of the reader's own. */
export type DecisionField = 'rule' | 'deny';

export interface DecisionFieldsProps {
  /** False on a finding already denied, which withholds the control rather than repeating it. */
  readonly canDeny: boolean;
  /** The box the console's keyboard sent the reader to, and which request sent them. */
  readonly focused: { readonly field: DecisionField; readonly at: number } | null;
  /**
   * The mark the card is holding, which every control offering it reads. An
   * option's marker proposes the mark rather than making it, so a proposal
   * reads here and moves nothing until the reader takes it.
   */
  readonly dedicated: boolean;
  /** The mark the reader set, which is a write of its own and not part of a ruling. */
  readonly onDedicated: (dedicated: boolean) => void;
  readonly onRule: (text: string) => void;
  readonly onDeny: (reason: string | null) => void;
  readonly onDrafting: (field: DecisionField, drafting: boolean) => void;
}

/**
 * The card's own two decisions, each in a box that is simply there. The ruling
 * is unconditional: it is the only route on a finding whose options were never
 * minted, which on a real audit is most of them.
 */
export function DecisionFields({
  canDeny,
  focused,
  dedicated,
  onDedicated,
  onRule,
  onDeny,
  onDrafting,
}: DecisionFieldsProps): JSX.Element {
  const markId = useId();

  return (
    <>
      {/* Beside the decisions rather than inside one: the mark says who takes
          the work, so it is set on a finding nobody has ruled and cleared on
          one nobody is re-ruling. */}
      <CheckField
        id={markId}
        size="lg"
        testId={TEST_IDS.dedicatedToggle}
        checked={dedicated}
        onCheckedChange={onDedicated}
        label="Needs a session of its own"
      />
      <PromptForm
        title="Rule in your own words"
        placeholder="what was decided, and why"
        submitLabel="Rule"
        focus={focused?.field === 'rule' ? focused.at : null}
        onSubmit={onRule}
        onDrafting={(drafting) => {
          onDrafting('rule', drafting);
        }}
      />
      {canDeny && (
        <PromptForm
          title="Reason for denying"
          placeholder="why this finding is refused"
          submitLabel="Deny with this reason"
          focus={focused?.field === 'deny' ? focused.at : null}
          secondary={{
            label: 'Deny without a reason',
            onClick: () => {
              onDeny(null);
            },
          }}
          onSubmit={onDeny}
          onDrafting={(drafting) => {
            onDrafting('deny', drafting);
          }}
        />
      )}
    </>
  );
}
