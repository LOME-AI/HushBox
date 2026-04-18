import * as React from 'react';
import {
  buildSystemPrompt,
  applyFees,
  getModelPricing,
  generateNotifications,
  type CapabilityId,
  type BudgetError,
  type FundingSource,
  type MemberPrivilege,
} from '@hushbox/shared';
import { useBudgetCalculation } from '@/hooks/use-budget-calculation';
import { useConversationBudgets } from '@/hooks/use-conversation-budgets';
import { useResolveBilling } from '@/hooks/use-resolve-billing';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useSearchStore } from '@/stores/search';
import { useModels } from '@/hooks/models';
import { useSession, useAuthStore } from '@/lib/auth';

// ============================================================================
// Types
// ============================================================================

interface PromptBudgetInput {
  value: string;
  historyCharacters: number;
  capabilities: CapabilityId[];
  /** Conversation ID for group budget lookup. Omit or null for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
}

export interface PromptBudgetResult {
  fundingSource: FundingSource | 'denied';
  notifications: BudgetError[];
  capacityPercent: number;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
  estimatedCostCents: number;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  hasContent: boolean;
}

function resolveGroupBudgetArgument(
  isGroupMember: boolean,
  conversationId: string | null | undefined
): string | null {
  if (!isGroupMember) return null;
  return conversationId ?? '';
}

function resolveHasDelegatedBudget(
  isGroupMember: boolean,
  groupBudgetData: { memberBudgetDollars: number } | undefined
): boolean {
  return isGroupMember && groupBudgetData != null && groupBudgetData.memberBudgetDollars > 0;
}

function resolveWebSearchCost(
  webSearchEnabled: boolean,
  webSearchPrice: number | undefined
): number {
  if (webSearchEnabled && webSearchPrice != null && webSearchPrice > 0) {
    return applyFees(webSearchPrice);
  }
  return 0;
}

// ============================================================================
// Hook
// ============================================================================

interface PromptBudgetDisplayInputs {
  capacityPercent: number;
  isBalanceLoading: boolean;
  currentUsage: number;
  fundingSource: FundingSource | 'denied';
  isGroupMember: boolean;
  isGroupBudgetPending: boolean;
  modelContextLength: number;
  inputValue: string;
}

interface PromptBudgetDisplayResult {
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  hasContent: boolean;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
}

function computePromptBudgetDisplay(inputs: PromptBudgetDisplayInputs): PromptBudgetDisplayResult {
  const isOverCapacity = inputs.capacityPercent > 100;
  const isDenied = inputs.fundingSource === 'denied';
  const isBillingLoading =
    inputs.isBalanceLoading || (inputs.isGroupMember && inputs.isGroupBudgetPending);
  const hasBlockingError = isDenied || isOverCapacity || isBillingLoading;
  const hasContent = inputs.inputValue.trim().length > 0;

  const hasContext = inputs.modelContextLength > 0;
  const capacityCurrentUsage = hasContext ? inputs.currentUsage : 0;
  const capacityMaxCapacity = hasContext ? inputs.modelContextLength : 1;

  return {
    isOverCapacity,
    hasBlockingError,
    hasContent,
    capacityCurrentUsage,
    capacityMaxCapacity,
  };
}

export function usePromptBudget(input: PromptBudgetInput): PromptBudgetResult {
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const { webSearchEnabled } = useSearchStore();
  const { data: modelsData } = useModels();
  const { data: session, isPending: isSessionPending } = useSession();

  const modelsPricing = selectedModels.map((sm) => {
    const model = modelsData?.models.find((m) => m.id === sm.id);
    const pricing = getModelPricing(
      model?.pricePerInputToken ?? 0,
      model?.pricePerOutputToken ?? 0,
      model?.contextLength ?? 0
    );
    return {
      modelInputPricePerToken: pricing.inputPricePerToken,
      modelOutputPricePerToken: pricing.outputPricePerToken,
      contextLength: pricing.contextLength,
      webSearchPrice: model?.webSearchPrice,
    };
  });
  const modelContextLength = Math.min(...modelsPricing.map((m) => m.contextLength));
  const isAuthenticated = !isSessionPending && Boolean(session?.user);
  const customInstructions = useAuthStore((s) => s.customInstructions);
  const primaryModel = modelsData?.models.find((m) => m.id === getPrimaryModel(selectedModels).id);
  const webSearchCost = resolveWebSearchCost(webSearchEnabled, primaryModel?.webSearchPrice);

  // Group budget: only fetch for non-owner group members
  const isGroupMember =
    input.conversationId != null &&
    input.currentUserPrivilege != null &&
    input.currentUserPrivilege !== 'owner';

  const { data: groupBudgetData, isPending: isGroupBudgetPending } = useConversationBudgets(
    resolveGroupBudgetArgument(isGroupMember, input.conversationId)
  );

  const systemPrompt = React.useMemo(
    () => buildSystemPrompt(input.capabilities, customInstructions ?? undefined),
    [input.capabilities, customInstructions]
  );
  const promptCharacterCount = systemPrompt.length + input.historyCharacters + input.value.length;

  // 1. Math-only budget calculation
  const budgetResult = useBudgetCalculation({
    promptCharacterCount,
    models: modelsPricing.map((m) => ({
      modelInputPricePerToken: m.modelInputPricePerToken,
      modelOutputPricePerToken: m.modelOutputPricePerToken,
      contextLength: m.contextLength,
    })),
    isAuthenticated,
    webSearchCost,
  });

  // 2. Build group context for billing resolution
  const groupContext = React.useMemo(() => {
    if (!isGroupMember || !groupBudgetData) {
      return;
    }
    const data = groupBudgetData;
    return {
      effectiveCents: data.effectiveDollars * 100,
      ownerTier: data.ownerTier,
      ownerBalanceCents: data.ownerBalanceDollars * 100,
    };
  }, [isGroupMember, groupBudgetData]);

  // 3. Resolve billing: who pays or why denied
  const isPremiumModel = selectedModels.some((sm) => modelsData?.premiumIds.has(sm.id) ?? false);
  const estimatedCostCents = budgetResult.estimatedMinimumCost * 100;

  const billingResult = useResolveBilling({
    estimatedMinimumCostCents: estimatedCostCents,
    isPremiumModel,
    isAuthenticated,
    ...(groupContext !== undefined && { group: groupContext }),
  });

  // 4. Generate notifications
  const hasDelegatedBudget = resolveHasDelegatedBudget(isGroupMember, groupBudgetData);
  const notifications = React.useMemo(
    () =>
      generateNotifications({
        billingResult,
        capacityPercent: budgetResult.capacityPercent,
        maxOutputTokens: budgetResult.maxOutputTokens,
        ...(input.currentUserPrivilege !== undefined && { privilege: input.currentUserPrivilege }),
        ...(hasDelegatedBudget && { hasDelegatedBudget: true }),
      }),
    [
      billingResult,
      budgetResult.capacityPercent,
      budgetResult.maxOutputTokens,
      input.currentUserPrivilege,
      hasDelegatedBudget,
    ]
  );

  // 5. Derive display values
  const display = computePromptBudgetDisplay({
    capacityPercent: budgetResult.capacityPercent,
    isBalanceLoading: budgetResult.isBalanceLoading,
    currentUsage: budgetResult.currentUsage,
    fundingSource: billingResult.fundingSource,
    isGroupMember,
    isGroupBudgetPending,
    modelContextLength,
    inputValue: input.value,
  });

  const isReadOnly = input.currentUserPrivilege === 'read';

  return {
    fundingSource: isReadOnly ? 'denied' : billingResult.fundingSource,
    notifications,
    capacityPercent: budgetResult.capacityPercent,
    capacityCurrentUsage: display.capacityCurrentUsage,
    capacityMaxCapacity: display.capacityMaxCapacity,
    estimatedCostCents,
    isOverCapacity: display.isOverCapacity,
    hasBlockingError: display.hasBlockingError || isReadOnly,
    hasContent: display.hasContent,
  };
}
