import * as React from 'react';
import { useState, useMemo, useRef } from 'react';
import { ModalOverlay, ModalActions, Input } from '@hushbox/ui';
import { displayUsername } from '@hushbox/shared';
import {
  useConversationBudgets,
  useUpdateMemberBudget,
  useUpdateConversationBudget,
} from '../../hooks/use-conversation-budgets.js';
import { useFormEnterNav } from '../../hooks/use-form-enter-nav.js';

interface MemberInfo {
  id: string;
  userId: string | null;
  linkId?: string | null;
  username: string | null;
  privilege: string;
}

interface MemberBudget {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  privilege: string;
  /** '0.00' when no member_budgets row exists. */
  budget: string;
  spent: string;
}

interface BudgetData {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: MemberBudget[];
}

interface BudgetSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  members: readonly MemberInfo[];
  currentUserPrivilege: string;
}

interface BudgetRowProps {
  label: string;
  budgetValue: string;
  spentValue: string;
  isEditable?: boolean;
  isSummary?: boolean;
  onChange?: (value: string) => void;
  inputTestId?: string;
  spentTestId?: string;
  rowTestId?: string;
}

function dollarsToCents(dollars: string): number {
  return Math.round(Number.parseFloat(dollars) * 100);
}

function formatDollars(dollarString: string): string {
  return Number.parseFloat(dollarString).toFixed(2);
}

function BudgetRow({
  label,
  budgetValue,
  spentValue,
  isEditable,
  isSummary,
  onChange,
  inputTestId,
  spentTestId,
  rowTestId,
}: Readonly<BudgetRowProps>): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1.5" data-testid={rowTestId}>
      <div className={`min-w-[80px] flex-1 text-sm${isSummary ? 'font-medium' : ''}`}>{label}</div>
      <div className="w-28 text-right">
        {isEditable ? (
          <div className="flex items-center justify-end gap-1">
            <span className="text-muted-foreground text-sm">$</span>
            <Input
              data-testid={inputTestId}
              type="text"
              value={budgetValue}
              onChange={(e) => {
                onChange?.(e.target.value);
              }}
              className="h-8 w-24 text-right"
            />
          </div>
        ) : (
          <span data-testid={inputTestId} className="text-sm font-medium">
            ${budgetValue}
          </span>
        )}
      </div>
      <div className="w-24 text-right">
        <span data-testid={spentTestId} className="text-muted-foreground text-xs">
          ${spentValue} spent
        </span>
      </div>
    </div>
  );
}

interface BudgetContentProps {
  formRef?: React.RefObject<HTMLFormElement | null>;
  onSubmit?: () => void;
  children: React.ReactNode;
}

function BudgetContent({
  formRef,
  onSubmit,
  children,
}: Readonly<BudgetContentProps>): React.JSX.Element {
  if (formRef && onSubmit) {
    return (
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    );
  }
  return <>{children}</>;
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
  allocatedCents: number;
}

function useBudgetFormState(budgetData: BudgetData | undefined): BudgetFormState {
  const initialConvBudget = useMemo(() => {
    if (!budgetData) return '';
    return formatDollars(budgetData.conversationBudget);
  }, [budgetData]);

  const [editedConvBudget, setEditedConvBudget] = useState<string | null>(null);

  const currentConvBudget = editedConvBudget ?? initialConvBudget;

  const initialValues = useMemo(() => {
    if (!budgetData) return {};
    const map: Record<string, string> = {};
    for (const mb of budgetData.memberBudgets) {
      map[mb.memberId] = formatDollars(mb.budget);
    }
    return map;
  }, [budgetData]);

  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const currentValues = useMemo(() => {
    return { ...initialValues, ...editedValues };
  }, [initialValues, editedValues]);

  const convBudgetChanged = editedConvBudget !== null && editedConvBudget !== initialConvBudget;

  const memberBudgetChanged = useMemo(() => {
    for (const [memberId, value] of Object.entries(editedValues)) {
      if (initialValues[memberId] !== value) return true;
    }
    return false;
  }, [editedValues, initialValues]);

  const hasChanges = convBudgetChanged || memberBudgetChanged;

  const totalMemberBudgetCents = useMemo(() => {
    if (!budgetData) return 0;
    let sum = 0;
    for (const mb of budgetData.memberBudgets) {
      const value = currentValues[mb.memberId] ?? formatDollars(mb.budget);
      sum += dollarsToCents(value);
    }
    return sum;
  }, [budgetData, currentValues]);

  const allocatedCents = useMemo(() => {
    const convCents = currentConvBudget === '' ? 0 : dollarsToCents(currentConvBudget);
    if (convCents > 0) {
      return Math.min(convCents, totalMemberBudgetCents);
    }
    return totalMemberBudgetCents;
  }, [currentConvBudget, totalMemberBudgetCents]);

  return {
    currentConvBudget,
    setEditedConvBudget,
    currentValues,
    editedValues,
    setEditedValues,
    hasChanges,
    convBudgetChanged,
    initialValues,
    allocatedCents,
  };
}

export function BudgetSettingsModal({
  open,
  onOpenChange,
  conversationId,
  members,
  currentUserPrivilege,
}: Readonly<BudgetSettingsModalProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const { data, isLoading } = useConversationBudgets(conversationId);
  const budgetData = data as BudgetData | undefined;
  const updateBudget = useUpdateMemberBudget();
  const mutateAsync = (
    updateBudget as {
      mutateAsync: (args: {
        conversationId: string;
        memberId: string;
        budgetCents: number;
      }) => Promise<unknown>;
      isPending: boolean;
    }
  ).mutateAsync;
  const isPending = (updateBudget as { isPending: boolean }).isPending;
  const updateConvBudget = useUpdateConversationBudget();
  const convBudgetMutateAsync = (
    updateConvBudget as {
      mutateAsync: (args: { conversationId: string; budgetCents: number }) => Promise<unknown>;
      isPending: boolean;
    }
  ).mutateAsync;
  const convBudgetIsPending = (updateConvBudget as { isPending: boolean }).isPending;

  const isOwner = currentUserPrivilege === 'owner';

  const {
    currentConvBudget,
    setEditedConvBudget,
    currentValues,
    editedValues,
    setEditedValues,
    hasChanges,
    convBudgetChanged,
    initialValues,
    allocatedCents,
  } = useBudgetFormState(budgetData);

  function getMemberName(mb: MemberBudget): string {
    const member = members.find((m) => m.id === mb.memberId);
    if (member?.username) return displayUsername(member.username);
    if (mb.linkId) return 'Guest Link';
    return 'Unknown';
  }

  function handleInputChange(memberId: string, value: string): void {
    setEditedValues((previous) => ({ ...previous, [memberId]: value }));
  }

  async function handleSave(): Promise<void> {
    if (convBudgetChanged) {
      const cents = currentConvBudget === '' ? 0 : dollarsToCents(currentConvBudget);
      await convBudgetMutateAsync({
        conversationId,
        budgetCents: cents,
      });
    }

    const changedEntries = Object.entries(editedValues).filter(
      ([memberId, value]) => initialValues[memberId] !== value
    );

    for (const [memberId, value] of changedEntries) {
      await mutateAsync({
        conversationId,
        memberId,
        budgetCents: dollarsToCents(value),
      });
    }

    setEditedConvBudget(null);
    setEditedValues({});
    onOpenChange(false);
  }

  function handleCancel(): void {
    setEditedConvBudget(null);
    setEditedValues({});
    onOpenChange(false);
  }

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Budget Settings">
      <div
        data-testid="budget-settings-modal"
        className="bg-background flex w-[90vw] max-w-lg flex-col rounded-lg border p-6 shadow-lg"
      >
        <h2 className="text-lg font-semibold">Budget Settings</h2>
        <p className="text-muted-foreground mb-4 text-xs">
          The owner can fund AI usage for members. When exhausted, members use their own balance.
        </p>

        {isLoading || !budgetData ? (
          <div
            data-testid="budget-loading"
            className="text-muted-foreground py-8 text-center text-sm"
          >
            Loading budgets...
          </div>
        ) : (
          <BudgetContent
            {...(isOwner && { formRef })}
            {...(isOwner && {
              onSubmit: () => {
                void handleSave();
              },
            })}
          >
            {/* Conversation */}
            <div
              data-testid="budget-conversation-section"
              className="mb-4 overflow-y-auto pr-2 [scrollbar-gutter:stable]"
            >
              <span className="text-muted-foreground mb-2 block text-xs font-medium tracking-wide uppercase">
                Conversation
              </span>
              <BudgetRow
                label="Funding limit"
                budgetValue={currentConvBudget}
                spentValue={formatDollars(budgetData.totalSpent)}
                isEditable={isOwner}
                onChange={(value) => {
                  setEditedConvBudget(value);
                }}
                inputTestId={isOwner ? 'budget-conversation-input' : 'budget-conversation-value'}
                spentTestId="budget-total-spent"
              />
            </div>

            {budgetData.memberBudgets.length > 0 && (
              <>
                {/* Members */}
                <div className="mb-4">
                  <span className="text-muted-foreground mb-2 block text-xs font-medium tracking-wide uppercase">
                    Members
                  </span>
                  <div
                    data-testid="budget-members-list"
                    className="max-h-60 space-y-1 overflow-y-auto pr-2 [scrollbar-gutter:stable]"
                  >
                    {budgetData.memberBudgets.map((mb) => (
                      <BudgetRow
                        key={mb.memberId}
                        label={getMemberName(mb)}
                        budgetValue={currentValues[mb.memberId] ?? formatDollars(mb.budget)}
                        spentValue={formatDollars(mb.spent)}
                        isEditable={isOwner}
                        onChange={(value) => {
                          handleInputChange(mb.memberId, value);
                        }}
                        inputTestId={
                          isOwner ? `budget-input-${mb.memberId}` : `budget-value-${mb.memberId}`
                        }
                        spentTestId="budget-spent"
                        rowTestId={`budget-member-${mb.memberId}`}
                      />
                    ))}
                  </div>
                </div>

                {/* Allocated */}
                <div className="border-border mb-6 overflow-y-auto border-t pt-3 pr-2 [scrollbar-gutter:stable]">
                  <BudgetRow
                    label="Allocated"
                    budgetValue={(allocatedCents / 100).toFixed(2)}
                    spentValue={formatDollars(budgetData.totalSpent)}
                    isSummary
                    rowTestId="budget-total-allocated"
                  />
                </div>
              </>
            )}

            {/* Action buttons */}
            {isOwner ? (
              <ModalActions
                cancel={{
                  label: 'Cancel',
                  onClick: handleCancel,
                  testId: 'budget-cancel-button',
                }}
                primary={{
                  label: 'Save Changes',
                  onClick: () => {
                    void handleSave();
                  },
                  disabled: !hasChanges || isPending || convBudgetIsPending,
                  testId: 'budget-save-button',
                }}
              />
            ) : (
              <ModalActions
                primary={{
                  label: 'Close',
                  variant: 'outline',
                  onClick: handleCancel,
                  testId: 'budget-cancel-button',
                }}
              />
            )}
          </BudgetContent>
        )}
      </div>
    </ModalOverlay>
  );
}
