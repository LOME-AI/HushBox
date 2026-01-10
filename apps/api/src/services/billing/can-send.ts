import type { UserTierInfo } from '@lome-chat/shared';
import { canUseModel } from '@lome-chat/shared';

export interface CanSendResult {
  canSend: boolean;
  reason?: 'insufficient_balance' | 'premium_requires_balance';
}

/**
 * Check if a user can send a message to a specific model.
 *
 * @param tierInfo - User's tier info from getUserTierInfo
 * @param isPremiumModel - Whether the target model is premium
 * @returns Result with canSend boolean and optional denial reason
 */
export function canUserSendMessage(tierInfo: UserTierInfo, isPremiumModel: boolean): CanSendResult {
  if (!canUseModel(tierInfo, isPremiumModel)) {
    return {
      canSend: false,
      reason: 'premium_requires_balance',
    };
  }
  return { canSend: true };
}
