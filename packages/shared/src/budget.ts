/**
 * Budget calculation utilities for pre-send validation.
 *
 * Used by both frontend (real-time UI updates) and backend (validation before OpenRouter).
 * All cost calculations use prices with fees already applied.
 */

import {
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_GUEST_MESSAGE_COST_CENTS,
  MINIMUM_OUTPUT_TOKENS,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  CAPACITY_RED_THRESHOLD,
} from './constants.js';
import type { UserTier } from './tiers.js';

// ============================================================================
// Types
// ============================================================================

export interface BudgetCalculationInput {
  /** User's tier: 'guest', 'free', or 'paid' */
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
  /** Whether the user can afford to send this message */
  canAfford: boolean;
  /** Maximum output tokens based on budget (0 if cannot afford) */
  maxOutputTokens: number;
  /** Estimated input tokens based on tier */
  estimatedInputTokens: number;
  /** Estimated input cost in dollars */
  estimatedInputCost: number;
  /** Estimated minimum total cost (input + min output) in dollars */
  estimatedMinimumCost: number;
  /** Effective balance including any cushion, in dollars */
  effectiveBalance: number;
  /** Current usage in tokens (input + min output) */
  currentUsage: number;
  /** Capacity percentage (currentUsage / modelContextLength * 100) */
  capacityPercent: number;
  /** Array of error/warning/info messages to display */
  errors: BudgetError[];
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
 * Estimate token count based on user tier.
 * Uses conservative (2 chars/token) for free/guest users since we absorb overruns.
 * Uses standard (4 chars/token) for paid users.
 */
export function estimateTokensForTier(tier: UserTier, characterCount: number): number {
  if (characterCount === 0) return 0;

  const charsPerToken = tier === 'paid' ? CHARS_PER_TOKEN_STANDARD : CHARS_PER_TOKEN_CONSERVATIVE;
  return Math.ceil(characterCount / charsPerToken);
}

// ============================================================================
// Effective Balance
// ============================================================================

/**
 * Calculate effective balance based on tier.
 * - Guest: Fixed max cost per message ($0.01)
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
    case 'guest':
      return MAX_GUEST_MESSAGE_COST_CENTS / 100;
    case 'free':
      return freeAllowanceCents / 100;
    case 'paid':
      return (balanceCents + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) / 100;
  }
}

// ============================================================================
// Error Generation
// ============================================================================

/**
 * Generate appropriate error/warning/info messages based on budget result.
 */
export function generateBudgetErrors(
  tier: UserTier,
  result: Omit<BudgetCalculationResult, 'errors'>
): BudgetError[] {
  const errors: BudgetError[] = [];

  // Capacity exceeded error (blocks sending)
  const isOverCapacity = result.capacityPercent > 100;
  if (isOverCapacity) {
    errors.push({
      id: 'capacity_exceeded',
      type: 'error',
      message: 'Message exceeds model capacity. Shorten your message or start a new conversation.',
    });
  }

  // Insufficient balance errors (tier-specific, blocks sending)
  if (!result.canAfford) {
    switch (tier) {
      case 'paid':
        errors.push({
          id: 'insufficient_paid',
          type: 'error',
          message: 'Insufficient balance. Top up or try a more affordable model.',
          segments: [
            { text: 'Insufficient balance. ' },
            { text: 'Top up', link: '/billing' },
            { text: ' or try a more affordable model.' },
          ],
        });
        break;
      case 'free':
        errors.push({
          id: 'insufficient_free',
          type: 'error',
          message:
            "Your free daily usage can't cover this message. Try a shorter conversation or more affordable model.",
        });
        break;
      case 'guest':
        errors.push({
          id: 'insufficient_guest',
          type: 'error',
          message: 'This message exceeds guest limits. Sign up for more capacity.',
          segments: [
            { text: 'This message exceeds guest limits. ' },
            { text: 'Sign up', link: '/signup' },
            { text: ' for more capacity.' },
          ],
        });
        break;
    }
  }

  // Capacity warning (only when no blocking errors exist)
  const hasBlockingError = isOverCapacity || !result.canAfford;
  if (!hasBlockingError && result.capacityPercent >= CAPACITY_RED_THRESHOLD * 100) {
    errors.push({
      id: 'capacity_warning',
      type: 'warning',
      message: "Your conversation is near this model's memory limit. Responses may be cut short.",
    });
  }

  // Low balance warning (paid only, when can afford but limited)
  if (
    tier === 'paid' &&
    result.canAfford &&
    result.maxOutputTokens < LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD
  ) {
    errors.push({
      id: 'low_balance',
      type: 'warning',
      message: 'Low balance. Long responses may be shortened.',
    });
  }

  // Tier info notices (always shown for free/guest, positive framing)
  if (tier === 'free') {
    errors.push({
      id: 'free_tier_notice',
      type: 'info',
      message: 'Using free allowance. Top up for longer conversations.',
      segments: [
        { text: 'Using free allowance. ' },
        { text: 'Top up', link: '/billing' },
        { text: ' for longer conversations.' },
      ],
    });
  } else if (tier === 'guest') {
    errors.push({
      id: 'guest_notice',
      type: 'info',
      message: 'Free preview. Sign up for full access.',
      segments: [
        { text: 'Free preview. ' },
        { text: 'Sign up', link: '/signup' },
        { text: ' for full access.' },
      ],
    });
  }

  return errors;
}

// ============================================================================
// Main Calculation
// ============================================================================

/**
 * Calculate budget for a message.
 * Used by frontend for real-time UI and backend for pre-send validation.
 *
 * @param input - All inputs needed for budget calculation
 * @returns Complete budget result including affordability, limits, and errors
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

  // 2. Calculate costs
  const estimatedInputCost = estimatedInputTokens * modelInputPricePerToken;
  const minimumOutputCost = MINIMUM_OUTPUT_TOKENS * modelOutputPricePerToken;
  const estimatedMinimumCost = estimatedInputCost + minimumOutputCost;

  // 3. Determine effective balance
  const effectiveBalance = getEffectiveBalance(tier, balanceCents, freeAllowanceCents);

  // 4. Check affordability
  const canAfford = effectiveBalance >= estimatedMinimumCost;

  // 5. Calculate max output tokens (only meaningful if can afford)
  let maxOutputTokens = 0;
  if (canAfford) {
    const remainingBudget = effectiveBalance - estimatedInputCost;
    maxOutputTokens = Math.floor(remainingBudget / modelOutputPricePerToken);
  }

  // 6. Calculate capacity (always use standard 4 chars/token - model context is fixed regardless of tier)
  const capacityInputTokens = Math.ceil(promptCharacterCount / CHARS_PER_TOKEN_STANDARD);
  const currentUsage = capacityInputTokens + MINIMUM_OUTPUT_TOKENS;
  const capacityPercent = (currentUsage / modelContextLength) * 100;

  // Build result without errors first
  const resultWithoutErrors: Omit<BudgetCalculationResult, 'errors'> = {
    canAfford,
    maxOutputTokens,
    estimatedInputTokens,
    estimatedInputCost,
    estimatedMinimumCost,
    effectiveBalance,
    currentUsage,
    capacityPercent,
  };

  // 7. Generate errors
  const errors = generateBudgetErrors(tier, resultWithoutErrors);

  return {
    ...resultWithoutErrors,
    errors,
  };
}
