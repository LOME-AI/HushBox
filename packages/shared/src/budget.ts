/**
 * Budget calculation utilities for pre-send validation.
 *
 * Used by both frontend (real-time UI updates) and backend (validation before OpenRouter).
 * All cost calculations use prices with fees already applied.
 */

import {
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MINIMUM_OUTPUT_TOKENS,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  CAPACITY_RED_THRESHOLD,
  STORAGE_COST_PER_CHARACTER,
} from './constants.js';
import { effectiveOutputCostPerToken } from './pricing.js';
import type { UserTier } from './tiers.js';
import type { FundingSource, ResolveBillingResult, DenialReason } from './resolve-billing.js';

// ============================================================================
// Types
// ============================================================================

export interface NotificationInput {
  billingResult: ResolveBillingResult;
  capacityPercent: number;
  maxOutputTokens: number;
  privilege?: 'read' | 'write' | 'admin' | 'owner';
  hasDelegatedBudget?: boolean;
}

export interface BudgetCalculationInput {
  /** User's tier: 'trial', 'guest', 'free', or 'paid' */
  tier: UserTier;
  /** User's primary balance in cents */
  balanceCents: number;
  /** User's free daily allowance remaining in cents */
  freeAllowanceCents: number;
  /** Total character count: system prompt + history + user message */
  promptCharacterCount: number;
  /** Model's input price per token (with fees applied) */
  modelInputPricePerToken: number;
  /** Model's output price per token (with fees applied) */
  modelOutputPricePerToken: number;
  /** Model's maximum context length in tokens */
  modelContextLength: number;
}

export interface BudgetCalculationResult {
  /** Maximum output tokens based on personal budget (0 if personal balance insufficient) */
  maxOutputTokens: number;
  /** Estimated input tokens based on tier */
  estimatedInputTokens: number;
  /** Estimated input cost in dollars (model cost + storage cost) */
  estimatedInputCost: number;
  /** Estimated minimum total cost (input + min output) in dollars */
  estimatedMinimumCost: number;
  /** Effective balance including any cushion, in dollars */
  effectiveBalance: number;
  /** Effective cost per output token used by this calculation (model + storage).
   *  Downstream code MUST use this for worst-case cost to maintain the budget invariant. */
  outputCostPerToken: number;
  /** Current usage in tokens (input + min output) */
  currentUsage: number;
  /** Capacity percentage (currentUsage / modelContextLength * 100) */
  capacityPercent: number;
}

/**
 * A segment of a message, optionally with a link.
 */
export interface MessageSegment {
  /** The text content of this segment */
  text: string;
  /** Route path if this segment should be a clickable link */
  link?: string;
}

export interface BudgetError {
  /** Unique identifier for the error type */
  id: string;
  /** Severity: 'error' blocks send, 'warning' allows, 'info' is informational */
  type: 'warning' | 'error' | 'info';
  /** Human-readable message to display (plain text fallback) */
  message: string;
  /** Structured message with optional links for rendering */
  segments?: MessageSegment[];
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Characters-per-token ratio for a given tier.
 * Single source of truth for token↔character conversion.
 * Conservative (2) for free/trial/guest since we absorb overruns.
 * Standard (4) for paid users.
 */
export function charsPerTokenForTier(tier: UserTier): number {
  return tier === 'paid' ? CHARS_PER_TOKEN_STANDARD : CHARS_PER_TOKEN_CONSERVATIVE;
}

/**
 * Estimate token count based on user tier.
 * Uses conservative (2 chars/token) for free/trial users since we absorb overruns.
 * Uses standard (4 chars/token) for paid users.
 */
export function estimateTokensForTier(tier: UserTier, characterCount: number): number {
  if (characterCount === 0) return 0;
  return Math.ceil(characterCount / charsPerTokenForTier(tier));
}

// ============================================================================
// Effective Balance
// ============================================================================

/**
 * Negative-balance cushion by tier. Only paid users get the $0.50 cushion.
 * Single source of truth — used by getEffectiveBalance and race guards in chat.ts.
 */
export function getCushionCents(tier: UserTier): number {
  return tier === 'paid' ? MAX_ALLOWED_NEGATIVE_BALANCE_CENTS : 0;
}

/**
 * Calculate effective balance based on tier.
 * - Trial: Fixed max cost per message ($0.01)
 * - Guest: Fixed max cost per message ($0.01) — guests use delegated budget
 * - Free: Free allowance only, no cushion
 * - Paid: Balance + $0.50 cushion
 *
 * @returns Effective balance in dollars
 */
export function getEffectiveBalance(
  tier: UserTier,
  balanceCents: number,
  freeAllowanceCents: number
): number {
  switch (tier) {
    case 'trial':
    case 'guest': {
      return MAX_TRIAL_MESSAGE_COST_CENTS / 100;
    }
    case 'free': {
      return freeAllowanceCents / 100;
    }
    case 'paid': {
      return (balanceCents + getCushionCents('paid')) / 100;
    }
  }
}

// ============================================================================
// Notification Generation (new — driven by resolveBilling() result)
// ============================================================================

const DENIAL_NOTIFICATIONS: Record<DenialReason, BudgetError> = {
  premium_requires_balance: {
    id: 'premium_requires_balance',
    type: 'error',
    message: 'This model requires a paid account.',
    segments: [
      { text: 'This model requires a paid account. ' },
      { text: 'Top up', link: '/billing' },
      { text: ' to use premium models.' },
    ],
  },
  insufficient_balance: {
    id: 'insufficient_balance',
    type: 'error',
    message: 'Insufficient balance. Top up or try a more affordable model.',
    segments: [
      { text: 'Insufficient balance. ' },
      { text: 'Top up', link: '/billing' },
      { text: ' or try a more affordable model.' },
    ],
  },
  insufficient_free_allowance: {
    id: 'insufficient_free_allowance',
    type: 'error',
    message:
      "Your free daily usage can't cover this message. Top up or try a shorter conversation.",
    segments: [
      { text: "Your free daily usage can't cover this message. " },
      { text: 'Top up', link: '/billing' },
      { text: ' or try a shorter conversation.' },
    ],
  },
  guest_limit_exceeded: {
    id: 'guest_limit_exceeded',
    type: 'error',
    message: 'This message exceeds the usage limit.',
    segments: [
      { text: 'This message exceeds the usage limit. ' },
      { text: 'Sign up', link: '/signup' },
      { text: ' for more capacity.' },
    ],
  },
};

const FUNDING_SOURCE_NOTICES: Partial<Record<FundingSource, BudgetError>> = {
  free_allowance: {
    id: 'free_tier_notice',
    type: 'info',
    message: 'Using free allowance. Top up for longer conversations.',
    segments: [
      { text: 'Using free allowance. ' },
      { text: 'Top up', link: '/billing' },
      { text: ' for longer conversations.' },
    ],
  },
  guest_fixed: {
    id: 'trial_notice',
    type: 'info',
    message: 'Free preview. Sign up for full access.',
    segments: [
      { text: 'Free preview. ' },
      { text: 'Sign up', link: '/signup' },
      { text: ' for full access.' },
    ],
  },
};

const DELEGATED_BUDGET_ACTIVE: BudgetError = {
  id: 'delegated_budget_notice',
  type: 'info',
  message: "You won't be charged. The conversation owner has allocated budget for your messages.",
  segments: [
    {
      text: "You won't be charged. The conversation owner has allocated budget for your messages.",
    },
  ],
};

const DELEGATED_BUDGET_EXHAUSTED: BudgetError = {
  id: 'delegated_budget_exhausted',
  type: 'info',
  message: 'Allocated budget used up. Your personal balance will be used.',
  segments: [{ text: 'Allocated budget used up. Your personal balance will be used.' }],
};

/** Push non-blocking warning notifications (capacity + low balance). */
function pushWarningNotifications(
  notifications: BudgetError[],
  capacityPercent: number,
  fundingSource: FundingSource | 'denied',
  maxOutputTokens: number
): void {
  if (capacityPercent >= CAPACITY_RED_THRESHOLD * 100) {
    notifications.push({
      id: 'capacity_warning',
      type: 'warning',
      message: "Your conversation is near this model's memory limit. Responses may be cut short.",
    });
  }
  if (
    fundingSource === 'personal_balance' &&
    maxOutputTokens < LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD
  ) {
    notifications.push({
      id: 'low_balance',
      type: 'warning',
      message: 'Low balance. Long responses may be shortened.',
    });
  }
}

/** Push info-level notifications (funding source + delegated budget). */
function pushInfoNotifications(
  notifications: BudgetError[],
  fundingSource: FundingSource | 'denied',
  isDenied: boolean,
  hasDelegatedBudget: boolean | undefined
): void {
  if (!isDenied) {
    const notice = FUNDING_SOURCE_NOTICES[fundingSource as FundingSource];
    if (notice) notifications.push(notice);
  }
  if (hasDelegatedBudget === true) {
    notifications.push(
      fundingSource === 'owner_balance' ? DELEGATED_BUDGET_ACTIVE : DELEGATED_BUDGET_EXHAUSTED
    );
  }
}

/**
 * Generate notification messages based on a billing decision and context.
 *
 * Maps the output of `resolveBilling()` plus capacity/privilege context
 * into an array of user-facing notification messages.
 */
export function generateNotifications(input: NotificationInput): BudgetError[] {
  const { billingResult, capacityPercent, maxOutputTokens, privilege, hasDelegatedBudget } = input;

  // Read-only members can't send — only show privilege notice
  if (privilege === 'read') {
    return [
      {
        id: 'read_only_notice',
        type: 'info' as const,
        message: 'You have read-only access to this conversation.',
        segments: [{ text: 'You have read-only access to this conversation.' }],
      },
    ];
  }

  const notifications: BudgetError[] = [];
  const isDenied = billingResult.fundingSource === 'denied';
  const isOverCapacity = capacityPercent > 100;

  // 1. Blocking errors
  if (isOverCapacity) {
    notifications.push({
      id: 'capacity_exceeded',
      type: 'error',
      message: 'Message exceeds model capacity. Shorten your message or start a new conversation.',
    });
  }
  if (isDenied) {
    notifications.push(DENIAL_NOTIFICATIONS[billingResult.reason]);
  }

  // 2. Non-blocking warnings (only when no blocking errors)
  if (!isDenied && !isOverCapacity) {
    pushWarningNotifications(
      notifications,
      capacityPercent,
      billingResult.fundingSource,
      maxOutputTokens
    );
  }

  // 3. Info notices (always, even with blocking errors)
  pushInfoNotifications(notifications, billingResult.fundingSource, isDenied, hasDelegatedBudget);

  return notifications;
}

// ============================================================================
// Main Calculation
// ============================================================================

/**
 * Calculate budget math for a message.
 * Pure math only — no billing decisions or notifications.
 * Used by frontend for real-time UI and backend for cost estimation.
 *
 * Billing decisions (can you send? who pays?) are handled by `resolveBilling()`.
 * Notifications (what to show the user) are handled by `generateNotifications()`.
 *
 * @param input - All inputs needed for budget calculation
 * @returns Math results: tokens, costs, capacity, max output tokens
 */
export function calculateBudget(input: BudgetCalculationInput): BudgetCalculationResult {
  const {
    tier,
    balanceCents,
    freeAllowanceCents,
    promptCharacterCount,
    modelInputPricePerToken,
    modelOutputPricePerToken,
    modelContextLength,
  } = input;

  // 1. Estimate input tokens based on tier
  const estimatedInputTokens = estimateTokensForTier(tier, promptCharacterCount);

  // 2. Calculate costs (model + storage)
  const inputStorageCost = promptCharacterCount * STORAGE_COST_PER_CHARACTER;
  const estimatedInputCost = estimatedInputTokens * modelInputPricePerToken + inputStorageCost;
  const outputCostPerToken = effectiveOutputCostPerToken(modelOutputPricePerToken, tier);
  const minimumOutputCost = MINIMUM_OUTPUT_TOKENS * outputCostPerToken;
  const estimatedMinimumCost = estimatedInputCost + minimumOutputCost;

  // 3. Determine effective balance
  const effectiveBalance = getEffectiveBalance(tier, balanceCents, freeAllowanceCents);

  // 4. Calculate max output tokens from personal balance
  const personalCanAfford = effectiveBalance >= estimatedMinimumCost;
  let maxOutputTokens = 0;
  if (personalCanAfford) {
    const remainingBudget = effectiveBalance - estimatedInputCost;
    maxOutputTokens = Math.floor(remainingBudget / outputCostPerToken);
  }

  // 5. Calculate capacity (always use standard 4 chars/token - model context is fixed regardless of tier)
  const capacityInputTokens = Math.ceil(promptCharacterCount / CHARS_PER_TOKEN_STANDARD);
  const currentUsage = capacityInputTokens + MINIMUM_OUTPUT_TOKENS;
  const capacityPercent = modelContextLength > 0 ? (currentUsage / modelContextLength) * 100 : 0;

  return {
    maxOutputTokens,
    estimatedInputTokens,
    estimatedInputCost,
    estimatedMinimumCost,
    effectiveBalance,
    outputCostPerToken,
    currentUsage,
    capacityPercent,
  };
}

// ============================================================================
// Safe Max Tokens
// ============================================================================

/** 5% safety margin to account for token estimation inaccuracy */
const MAX_TOKENS_HEADROOM = 0.95;

export interface ComputeMaxTokensParams {
  /** Max output tokens based on user's budget */
  budgetMaxTokens: number;
  /** Model's maximum context length in tokens */
  modelContextLength: number;
  /** Estimated input tokens (system prompt + history + user message) */
  estimatedInputTokens: number;
}

/**
 * Compute safe max_tokens value for OpenRouter request.
 *
 * @returns undefined if budget exceeds remaining context (omit max_tokens, let model use default)
 * @returns budget * 0.95 if budget is the limiting factor (5% headroom for estimation error)
 */
export function computeSafeMaxTokens(params: ComputeMaxTokensParams): number | undefined {
  const remainingContext = params.modelContextLength - params.estimatedInputTokens;

  if (params.budgetMaxTokens >= remainingContext) {
    return undefined;
  }

  return Math.floor(params.budgetMaxTokens * MAX_TOKENS_HEADROOM);
}

// ============================================================================
// Effective Budget (multi-constraint)
// ============================================================================

export interface EffectiveBudgetParams {
  /** conversationBudget - conversationSpent - conversationReserved. */
  conversationRemainingCents: number;
  /** memberBudget - memberSpent - memberReserved. 0 when no member_budgets row exists. */
  memberRemainingCents: number;
  /** ownerBalance - ownerReserved. */
  ownerRemainingCents: number;
}

/**
 * Calculates the effective remaining budget a member can spend.
 * All inputs should be NET values (raw budget minus spent minus reserved).
 * Returns min of all constraints.
 */
export function effectiveBudgetCents(params: EffectiveBudgetParams): number {
  return Math.min(
    params.conversationRemainingCents,
    params.memberRemainingCents,
    params.ownerRemainingCents
  );
}
