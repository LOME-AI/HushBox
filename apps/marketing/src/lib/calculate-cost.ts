import { estimateTokenCount, STORAGE_COST_PER_CHARACTER } from '@hushbox/shared';
import type { Model } from '@hushbox/shared';

const MESSAGES_PER_DAY = 50;
const DAYS_PER_MONTH = 30;

const SYSTEM_PROMPT_CHARS = 500;
const USER_MESSAGE_CHARS = 200;
const AI_RESPONSE_CHARS = 400;

export interface MonthlyCostResult {
  monthlyCost: number;
  modelName: string;
  messagesPerDay: number;
  daysPerMonth: number;
}

export function calculateMonthlyCost(models: Model[]): MonthlyCostResult {
  const paidModels = models.filter((m) => m.pricePerInputToken > 0 || m.pricePerOutputToken > 0);

  if (paidModels.length === 0) {
    return {
      monthlyCost: 0,
      modelName: '',
      messagesPerDay: MESSAGES_PER_DAY,
      daysPerMonth: DAYS_PER_MONTH,
    };
  }

  let cheapest = paidModels[0];
  for (const m of paidModels) {
    if (
      m.pricePerInputToken + m.pricePerOutputToken <
      cheapest.pricePerInputToken + cheapest.pricePerOutputToken
    ) {
      cheapest = m;
    }
  }

  const inputChars = SYSTEM_PROMPT_CHARS + USER_MESSAGE_CHARS;
  const outputChars = AI_RESPONSE_CHARS;

  const inputTokens = estimateTokenCount(inputChars.toString().padEnd(inputChars, ' '));
  const outputTokens = estimateTokenCount(outputChars.toString().padEnd(outputChars, ' '));

  const tokenCost =
    inputTokens * cheapest.pricePerInputToken + outputTokens * cheapest.pricePerOutputToken;
  const storageCost = (inputChars + outputChars) * STORAGE_COST_PER_CHARACTER;
  const costPerMessage = tokenCost + storageCost;

  const totalMessages = MESSAGES_PER_DAY * DAYS_PER_MONTH;
  const monthlyCost = costPerMessage * totalMessages;

  return {
    monthlyCost,
    modelName: cheapest.name,
    messagesPerDay: MESSAGES_PER_DAY,
    daysPerMonth: DAYS_PER_MONTH,
  };
}
