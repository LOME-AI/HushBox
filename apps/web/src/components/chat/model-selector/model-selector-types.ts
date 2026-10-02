import type { AddAvailability, Availability, RefusalCode } from '@hushbox/shared';

/** Shared props for premium/auth gating across model selector components. */
export interface ModelSelectorGatingProps {
  /** Set of premium model IDs */
  premiumIds?: Set<string> | undefined;
  /** Whether the user is authenticated (defaults to true) */
  isAuthenticated?: boolean | undefined;
  /** Whether the user is a link guest (suppresses premium overlay) */
  isLinkGuest?: boolean | undefined;
  /**
   * Called when the user clicks a row they cannot use. Carries WHY the row was
   * refused as well as which row it was: the session picks which door opens,
   * but only the reason can make what that door says true of this row.
   */
  onPremiumClick?: ((modelId: string, reason: RefusalCode) => void) | undefined;
}

/**
 * The conversation the picker was opened from. It NAMES THE PAYER: an
 * owner-funded group turn is priced from the owner's wallet, so the producer
 * needs the conversation to ask for the right one.
 */
export interface PickerConversationContext {
  readonly conversationId: string;
}

/**
 * What one picker row is greyed, gated and worded by. It is whichever activation
 * arm the picker's current mode activates, so it is an {@link AddAvailability}
 * where the click adds — carrying WHOSE problem the refusal is — and a plain
 * {@link Availability} where the click replaces, and for a pinned row and the
 * smart slot, neither of which is activated into a new role.
 *
 * The attribution is read, never derived: only a refusal the producer marked as
 * the selection's doing words itself that way, and a verdict that carries no
 * mark is the model's own.
 */
export type RowVerdict = Availability | AddAvailability;
