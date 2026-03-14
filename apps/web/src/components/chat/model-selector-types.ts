/** Shared props for premium/auth gating across model selector components. */
export interface ModelSelectorGatingProps {
  /** Set of premium model IDs */
  premiumIds?: Set<string> | undefined;
  /** Whether the user can access premium models (defaults to true) */
  canAccessPremium?: boolean | undefined;
  /** Whether the user is authenticated (defaults to true) */
  isAuthenticated?: boolean | undefined;
  /** Called when user clicks a premium model they cannot access */
  onPremiumClick?: ((modelId: string) => void) | undefined;
  /** Called when an unauthenticated user tries to select a second model */
  onMultiModelClick?: (() => void) | undefined;
}
