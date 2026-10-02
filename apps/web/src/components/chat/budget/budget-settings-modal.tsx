import * as React from 'react';
import { useState, useMemo, useRef } from 'react';
import { useAsyncAction } from '@hushbox/ui';
import { InlineInput } from '@hushbox/ui/field';
import { Info } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import {
  canSendMessages,
  dollarsToNanoUsd,
  MemberPrivilege,
  nanoUsdToCents,
  nanoUsdToDollarString,
  PRICEABLE_AMOUNT,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import {
  useConversationBudgets,
  useUpdateMemberBudget,
  useUpdateConversationBudget,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets.js';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import { useLinkGuestActive } from '@/lib/auth/link-guest-auth.js';
import { applyDollarSign, formatBalance } from '@/lib/billing/format.js';
import { budgetRowName } from '@/lib/chat/link-label.js';
import { useNamingReads } from '@/lib/chat/use-naming-reads.js';
import { privilegeWord } from '@/components/chat/member/member-row-parts.js';
import { ActionModal } from '@/components/shared/action-modal.js';

type MemberBudget = ConversationBudgetsResponse['members'][number];

interface BudgetSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  currentUserPrivilege: string;
}

const FORM_ID = 'budget-settings-form';

interface DialogCopy {
  description: string;
  conversationCaption: string;
  zeroNote: string;
}

// Only the owner funds members' replies, so everyone else reads who pays in the third person.
const OWNER_COPY: DialogCopy = {
  description:
    "You pay for members' replies up to these amounts. After that, each member pays from their own balance.",
  conversationCaption: 'The most you pay in total',
  zeroNote:
    "At $0.00 you pay for nothing here. Members pay from their own balance, and link guests can't send.",
};

const NON_OWNER_COPY: DialogCopy = {
  description:
    "The owner pays for members' replies up to these amounts. After that, each member pays from their own balance.",
  conversationCaption: 'The most the owner pays in total',
  zeroNote:
    "At $0.00 the owner pays for nothing here. Members pay from their own balance, and link guests can't send.",
};

// A wrapping row: the figures sit beside the name while both fit, and wrap beneath it when
// the text is scaled up, because the Who cell's basis is in em and grows with the text.
const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5';

const WHO_CELL = 'flex min-w-0 flex-[1_1_7em] flex-col';

// Below the budget-table width the spent figure moves under its field.
const FIGURES =
  'ml-auto flex items-center gap-x-3 gap-y-1 @max-budget-table/budget-table:flex-col @max-budget-table/budget-table:items-end';

const BUDGET_CELL = 'w-28';

const SPENT_CELL = 'min-w-18 text-right';

const WHO_LINE = 'wrap-break-word';

/** Nano-USD for comparison and aggregation, reading anything not yet a
 *  priceable amount as $0.00 — a field the user has cleared or has typed only a
 *  separator into names no money yet, and {@link isValidMoneyInput} admits both
 *  because a keystroke filter must let a value be typed. Every figure in this
 *  modal is compared and summed in this unit; cents appear only where the API
 *  asks for them. */
function moneyToNanoUsd(dollars: string): bigint {
  if (!PRICEABLE_AMOUNT.test(dollars)) return 0n;
  return BigInt(dollarsToNanoUsd(dollars));
}

/** The cap as the budget API takes it, from the one nano-USD figure above. */
function moneyToBudgetCents(dollars: string): number {
  return nanoUsdToCents(moneyToNanoUsd(dollars).toString());
}

/** Accepts the empty string and non-negative money with up to two decimals.
 *  Rejects letters, signs, and over-precise input before it reaches state, so
 *  NaN/negative cents can never be submitted to the API. */
function isValidMoneyInput(value: string): boolean {
  return value === '' || /^\d*(\.\d{0,2})?$/.test(value);
}

/** A Read member can never send, so it never spends and takes no row. */
function canSpend(row: MemberBudget): boolean {
  return canSendMessages(MemberPrivilege.parse(row.privilege));
}

function captionOf(row: MemberBudget): string {
  const word = privilegeWord(row.privilege);
  return row.userId === null ? `${word} · via a link` : word;
}

interface BudgetRowProps {
  name: string;
  caption: string;
  budget: string;
  spent: string;
  isEditable: boolean;
  onBudgetChange: (value: string) => void;
  inputTestId: string;
  spentTestId: string;
  rowTestId: string;
}

function BudgetRow({
  name,
  caption,
  budget,
  spent,
  isEditable,
  onBudgetChange,
  inputTestId,
  spentTestId,
  rowTestId,
}: Readonly<BudgetRowProps>): React.JSX.Element {
  return (
    <div className={ROW} data-testid={rowTestId}>
      <span className={WHO_CELL}>
        <span className={`${WHO_LINE} text-sm font-semibold`}>{name}</span>
        <span className={`${WHO_LINE} text-muted-foreground text-xs`}>{caption}</span>
      </span>
      <span className={FIGURES}>
        {isEditable ? (
          <span className={`${BUDGET_CELL} relative flex items-center`}>
            <span
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute left-2.5 text-sm"
            >
              $
            </span>
            <InlineInput
              data-testid={inputTestId}
              aria-label={`Budget for ${name}, in dollars`}
              type="text"
              inputMode="decimal"
              value={budget}
              onChange={(e) => {
                if (isValidMoneyInput(e.target.value)) onBudgetChange(e.target.value);
              }}
              className="pl-6 text-right font-mono tabular-nums"
            />
          </span>
        ) : (
          <span className={`${BUDGET_CELL} text-right font-mono text-sm tabular-nums`}>
            <span className="sr-only">Budget </span>
            <span data-testid={inputTestId}>{applyDollarSign(budget)}</span>
          </span>
        )}
        <span
          className={`${SPENT_CELL} text-num @max-budget-table/budget-table:text-xs font-mono tabular-nums`}
        >
          <span className="text-muted-foreground @max-budget-table/budget-table:not-sr-only sr-only font-sans">
            Spent{' '}
          </span>
          <span data-testid={spentTestId}>{spent}</span>
        </span>
      </span>
    </div>
  );
}

interface BudgetFormState {
  currentConvBudget: string;
  setEditedConvBudget: React.Dispatch<React.SetStateAction<string | null>>;
  currentValues: Record<string, string>;
  editedValues: Record<string, string>;
  setEditedValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  hasChanges: boolean;
  convBudgetChanged: boolean;
  initialValues: Record<string, string>;
}

function useBudgetFormState(budgetData: ConversationBudgetsResponse | undefined): BudgetFormState {
  const initialConvBudget = useMemo(() => {
    if (!budgetData) return '';
    return nanoUsdToDollarString(budgetData.conversationCapNanoUsd);
  }, [budgetData]);

  const [editedConvBudget, setEditedConvBudget] = useState<string | null>(null);

  const currentConvBudget = editedConvBudget ?? initialConvBudget;

  const initialValues = useMemo(() => {
    if (!budgetData) return {};
    const map: Record<string, string> = {};
    for (const mb of budgetData.members) {
      map[mb.memberId] = nanoUsdToDollarString(mb.capNanoUsd);
    }
    return map;
  }, [budgetData]);

  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const currentValues = useMemo(() => {
    return { ...initialValues, ...editedValues };
  }, [initialValues, editedValues]);

  // Compare on the amount, not the raw string, so re-typing the same money in
  // a different shape ('25' vs '25.00') is a no-op rather than a phantom change.
  const convBudgetChanged =
    editedConvBudget !== null &&
    moneyToNanoUsd(editedConvBudget) !== moneyToNanoUsd(initialConvBudget);

  const memberBudgetChanged = useMemo(() => {
    for (const [memberId, value] of Object.entries(editedValues)) {
      /* v8 ignore next -- editedValues keys are always members present in initialValues; the ?? '' only satisfies noUncheckedIndexedAccess */
      if (moneyToNanoUsd(initialValues[memberId] ?? '') !== moneyToNanoUsd(value)) return true;
    }
    return false;
  }, [editedValues, initialValues]);

  return {
    currentConvBudget,
    setEditedConvBudget,
    currentValues,
    editedValues,
    setEditedValues,
    hasChanges: convBudgetChanged || memberBudgetChanged,
    convBudgetChanged,
    initialValues,
  };
}

/**
 * The conversation whose budgets this modal reads, or null for a link guest.
 *
 * The modal mounts with the group chat rather than when it opens, so the read
 * fires for whoever is viewing; the budgets route is session-classed and
 * refuses a link guest outright, and a null conversation is how
 * {@link useConversationBudgets} is told not to ask.
 */
function budgetReadScope(conversationId: string, isLinkGuest: boolean): string | null {
  return isLinkGuest ? null : conversationId;
}

/**
 * What the dialog allocates: the members' total, bounded by the overall budget. Both are
 * exact nano-USD integers, so the smaller of the two is exact, and a $0.00 overall budget
 * allocates $0.00 because the server funds nothing past it.
 */
function allocatedNanoUsd(overallNanoUsd: bigint, membersNanoUsd: bigint): bigint {
  return overallNanoUsd < membersNanoUsd ? overallNanoUsd : membersNanoUsd;
}

interface BudgetFieldIds {
  conversation: string;
  member: (memberId: string) => string;
}

/** The owner edits each budget in a field; anyone else reads it as text. */
function budgetFieldIds(isOwner: boolean): BudgetFieldIds {
  return isOwner
    ? { conversation: TEST_IDS.budgetConversationInput, member: TEST_ID_BUILDERS.budgetInput }
    : { conversation: TEST_IDS.budgetConversationValue, member: TEST_ID_BUILDERS.budgetValue };
}

type DialogActions = Pick<React.ComponentProps<typeof ActionModal>, 'primary' | 'cancel'>;

function dialogActions(
  isOwner: boolean,
  owner: { save: () => Promise<void>; hasChanges: boolean; discard: () => void }
): DialogActions {
  if (!isOwner) {
    return {
      primary: {
        label: 'Close',
        variant: 'outline',
        onSubmit: () => Promise.resolve(),
        testId: TEST_IDS.budgetCancelButton,
      },
    };
  }
  return {
    primary: {
      label: 'Save budgets',
      loadingLabel: 'Saving…',
      onSubmit: owner.save,
      disabled: !owner.hasChanges,
      testId: TEST_IDS.budgetSaveButton,
      type: 'submit',
      form: FORM_ID,
    },
    cancel: { label: 'Cancel', onClick: owner.discard, testId: TEST_IDS.budgetCancelButton },
  };
}

export function BudgetSettingsModal({
  open,
  onOpenChange,
  conversationId,
  currentUserPrivilege,
}: Readonly<BudgetSettingsModalProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const isLinkGuest = useLinkGuestActive();
  const scope = budgetReadScope(conversationId, isLinkGuest);
  const { data: budgetData, isLoading } = useConversationBudgets(scope);
  const namingReads = useNamingReads(scope);
  const { mutateAsync } = useUpdateMemberBudget();
  const { mutateAsync: convBudgetMutateAsync } = useUpdateConversationBudget();
  const asyncAction = useAsyncAction();

  const isOwner = currentUserPrivilege === 'owner';
  const fieldIds = budgetFieldIds(isOwner);
  const copy = isOwner ? OWNER_COPY : NON_OWNER_COPY;

  const {
    currentConvBudget,
    setEditedConvBudget,
    currentValues,
    editedValues,
    setEditedValues,
    hasChanges,
    convBudgetChanged,
    initialValues,
  } = useBudgetFormState(budgetData);

  const spendingRows = useMemo(
    () => budgetData?.members.filter((row) => canSpend(row)) ?? [],
    [budgetData]
  );

  /* v8 ignore next -- currentValues always holds every served member's id; the ?? '' only satisfies noUncheckedIndexedAccess */
  const budgetOf = (memberId: string): string => currentValues[memberId] ?? '';

  const overallNanoUsd = moneyToNanoUsd(currentConvBudget);
  let membersNanoUsd = 0n;
  for (const row of spendingRows) membersNanoUsd += moneyToNanoUsd(budgetOf(row.memberId));

  function resetEdits(): void {
    setEditedConvBudget(null);
    setEditedValues({});
  }

  async function save(): Promise<void> {
    if (convBudgetChanged) {
      await convBudgetMutateAsync({
        conversationId,
        budgetCents: moneyToBudgetCents(currentConvBudget),
      });
    }

    const changedEntries = Object.entries(editedValues).filter(
      /* v8 ignore next -- editedValues keys are always members present in initialValues; the ?? '' only satisfies noUncheckedIndexedAccess */
      ([memberId, value]) => moneyToNanoUsd(initialValues[memberId] ?? '') !== moneyToNanoUsd(value)
    );

    for (const [memberId, value] of changedEntries) {
      await mutateAsync({
        conversationId,
        memberId,
        budgetCents: moneyToBudgetCents(value),
      });
    }

    resetEdits();
  }

  const table = budgetData && (
    <>
      <div
        role="group"
        aria-label="Budgets"
        className="bg-background divide-border @container/budget-table divide-y overflow-hidden rounded-lg border"
      >
        <div
          aria-hidden="true"
          className={`${ROW} bg-muted text-muted-foreground py-2 font-semibold`}
        >
          <span className={WHO_CELL}>
            <span className="text-xs">Who</span>
          </span>
          <span className={`${FIGURES} text-xs`}>
            <span className={`${BUDGET_CELL} text-right`}>Budget</span>
            <span className={`${SPENT_CELL} @max-budget-table/budget-table:hidden`}>Spent</span>
          </span>
        </div>
        <BudgetRow
          name="This conversation"
          caption={copy.conversationCaption}
          budget={currentConvBudget}
          spent={formatBalance(budgetData.conversationSpentNanoUsd)}
          isEditable={isOwner}
          onBudgetChange={(value) => {
            setEditedConvBudget(value);
          }}
          inputTestId={fieldIds.conversation}
          spentTestId={TEST_IDS.budgetTotalSpent}
          rowTestId={TEST_IDS.budgetConversationSection}
        />
        {spendingRows.map((row) => (
          <BudgetRow
            key={row.memberId}
            name={budgetRowName(row, namingReads.roster, namingReads.links)}
            caption={captionOf(row)}
            budget={budgetOf(row.memberId)}
            spent={formatBalance(row.spentNanoUsd)}
            isEditable={isOwner}
            onBudgetChange={(value) => {
              setEditedValues((previous) => ({ ...previous, [row.memberId]: value }));
            }}
            inputTestId={fieldIds.member(row.memberId)}
            spentTestId={TEST_IDS.budgetSpent}
            rowTestId={TEST_ID_BUILDERS.budgetMember(row.memberId)}
          />
        ))}
      </div>

      {overallNanoUsd === 0n && (
        <Notice tone="neutral" icon={Info} emphasis="subtle" data-testid={TEST_IDS.budgetZeroNote}>
          {copy.zeroNote}
        </Notice>
      )}

      {/* A non-owner is served only their own row, so a members total would understate the allocation. */}
      {isOwner && spendingRows.length > 0 && (
        <p
          data-testid={TEST_IDS.budgetTotalAllocated}
          className="flex flex-wrap justify-between gap-x-4 text-sm"
        >
          <span>Allocated to members</span>
          <span className="font-mono whitespace-nowrap tabular-nums">
            {`${formatBalance(allocatedNanoUsd(overallNanoUsd, membersNanoUsd).toString())} of ${formatBalance(overallNanoUsd.toString())}`}
          </span>
        </p>
      )}

      <p className="text-muted-foreground text-xs leading-[1.35]">
        Budgets are totals for the life of this conversation, not monthly. A read-only link never
        spends.
      </p>
    </>
  );

  const body =
    isLoading || !budgetData ? (
      <div
        data-testid={TEST_IDS.budgetLoading}
        className="text-muted-foreground py-8 text-center text-sm"
      >
        Loading budgets...
      </div>
    ) : (
      table
    );

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Budgets"
      description={copy.description}
      asyncAction={asyncAction}
      testId={TEST_IDS.budgetSettingsModal}
      size="lg"
      {...dialogActions(isOwner, { save, hasChanges, discard: resetEdits })}
    >
      {isOwner ? (
        <form
          id={FORM_ID}
          ref={formRef}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            // Enter and the Save button both reach ActionModal's primary handler through the
            // button's submit linkage; this only stops the native navigation.
            e.preventDefault();
          }}
        >
          {body}
        </form>
      ) : (
        <div className="flex flex-col gap-4">{body}</div>
      )}
    </ActionModal>
  );
}
