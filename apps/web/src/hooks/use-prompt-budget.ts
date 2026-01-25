import * as React from 'react';
import {
  buildSystemPrompt,
  applyFees,
  type CapabilityId,
  type BudgetCalculationResult,
} from '@lome-chat/shared';
import { useBudgetCalculation } from '@/hooks/use-budget-calculation';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useSession } from '@/lib/auth';

interface ModelPricing {
  contextLength: number;
  inputPrice: number;
  outputPrice: number;
}

function getModelPricing(
  model:
    | { contextLength?: number; pricePerInputToken?: number; pricePerOutputToken?: number }
    | undefined
): ModelPricing {
  return {
    contextLength: model?.contextLength ?? 0,
    inputPrice: applyFees(model?.pricePerInputToken ?? 0),
    outputPrice: applyFees(model?.pricePerOutputToken ?? 0),
  };
}

interface PromptBudgetInput {
  value: string;
  historyCharacters: number;
  capabilities: CapabilityId[];
}

interface PromptBudgetResult {
  budgetResult: BudgetCalculationResult;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  hasContent: boolean;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
}

export function usePromptBudget(input: PromptBudgetInput): PromptBudgetResult {
  const { selectedModelId } = useModelStore();
  const { data: modelsData, isLoading: isModelsLoading } = useModels();
  const { data: session, isPending: isSessionPending } = useSession();

  const selectedModel = modelsData?.models.find((m) => m.id === selectedModelId);
  const {
    contextLength: modelContextLength,
    inputPrice,
    outputPrice,
  } = getModelPricing(selectedModel);
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const systemPrompt = React.useMemo(
    () => buildSystemPrompt(input.capabilities),
    [input.capabilities]
  );
  const promptCharacterCount = systemPrompt.length + input.historyCharacters + input.value.length;

  const budgetResult = useBudgetCalculation({
    promptCharacterCount,
    modelInputPricePerToken: inputPrice,
    modelOutputPricePerToken: outputPrice,
    modelContextLength,
    isAuthenticated,
    isModelsLoading,
  });

  const isOverCapacity = budgetResult.capacityPercent > 100;
  const hasBlockingError = budgetResult.errors.some((e) => e.type === 'error');
  const hasContent = input.value.trim().length > 0;

  const hasContext = modelContextLength > 0;
  const capacityCurrentUsage = hasContext ? budgetResult.currentUsage : 0;
  const capacityMaxCapacity = hasContext ? modelContextLength : 1;

  return {
    budgetResult,
    isOverCapacity,
    hasBlockingError,
    hasContent,
    capacityCurrentUsage,
    capacityMaxCapacity,
  };
}
