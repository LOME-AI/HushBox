import {
  charStorageNanoUsd,
  inputTokensOf,
  modelPriceDisplay,
  nanoUsdToFullDollarString,
} from '@hushbox/shared';
import { priceSteps } from '@hushbox/shared/affordability/price/curve';
import { pricingFromWire, tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import type { Model } from '@hushbox/shared';
import type { TokenPricing } from '@hushbox/shared/affordability/price/schedule';

export const MESSAGES_PER_DAY = 50;
const DAYS_PER_MONTH = 30;

const SYSTEM_PROMPT_CHARS = 500;
const USER_MESSAGE_CHARS = 200;
const AI_RESPONSE_CHARS = 400;

interface MonthlyCostResult {
  monthlyCost: number;
  modelName: string;
  messagesPerDay: number;
  daysPerMonth: number;
}

interface PricedModel {
  readonly model: Model;
  readonly pricing: TokenPricing;
  /** The combined base rate the model is shown at, which ranks it. */
  readonly sortKeyNanoUsd: bigint;
}

/** A served row with a token price, or `undefined` for a media row or one the catalog cannot price. */
function pricedTextModel(model: Model): PricedModel | undefined {
  const sortKeyNanoUsd = modelPriceDisplay(model).sortKeyNanoUsd;
  const parsed = pricingFromWire(model);
  const pricing = parsed === undefined ? undefined : tokenPricingOf(parsed);
  if (pricing === undefined || sortKeyNanoUsd === undefined) return undefined;
  return { model, pricing, sortKeyNanoUsd };
}

export function calculateMonthlyCost(models: Model[]): MonthlyCostResult {
  const priced = models.flatMap((model) => pricedTextModel(model) ?? []);

  let cheapest = priced[0];
  if (cheapest === undefined) {
    return {
      monthlyCost: 0,
      modelName: '',
      messagesPerDay: MESSAGES_PER_DAY,
      daysPerMonth: DAYS_PER_MONTH,
    };
  }

  for (const entry of priced) {
    if (entry.sortKeyNanoUsd < cheapest.sortKeyNanoUsd) {
      cheapest = entry;
    }
  }

  const inputChars = SYSTEM_PROMPT_CHARS + USER_MESSAGE_CHARS;
  const outputChars = AI_RESPONSE_CHARS;

  // One conversion serves both legs: the price core's stored-output ratio sizes
  // a reply's storage, not the tokens that produced it.
  const inputTokens = inputTokensOf(inputChars);
  const outputTokens = inputTokensOf(outputChars);

  // All money math stays in integer nano-USD: the served rates are billable
  // (fees baked at catalog ingestion) and pass-through storage adds unmarked,
  // then the per-message total scales by the message count. The message is
  // priced as one step at the rates a user is shown, through the price core,
  // so a long-context model is charged at the tier its prompt reaches. The
  // float dollar figure is produced only at the very end for the marketing
  // chart.
  const tokenBillableNano = priceSteps(cheapest.pricing, 'display', [
    { inputTokens, outputTokens },
  ]).nanoUsd;
  // The storage term is the public illustration of a real charge rule: settlement's
  // withStorageFees prices the persisted prompt plus the response through this same
  // charStorageNanoUsd. Whoever changes that rule is changing what this chart claims.
  const storageNano = charStorageNanoUsd(inputChars + outputChars);
  const perMessageNano = tokenBillableNano + storageNano;
  const totalNano = perMessageNano * BigInt(MESSAGES_PER_DAY * DAYS_PER_MONTH);

  return {
    monthlyCost: Number.parseFloat(nanoUsdToFullDollarString(totalNano.toString())),
    modelName: cheapest.model.name,
    messagesPerDay: MESSAGES_PER_DAY,
    daysPerMonth: DAYS_PER_MONTH,
  };
}
