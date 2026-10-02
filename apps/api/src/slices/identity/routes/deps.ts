import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type {
  GrowthStores,
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  BillingStores,
  EvictUserPort,
  IdentityStoresFactory,
  PasswordChangedEmailPort,
  PasswordResetEmailPort,
  RedisClient,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  TwoFactorLockedEmailPort,
  VerificationEmailPort,
  WelcomeEmailPort,
} from '../domain/index.js';

export interface IdentityRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: IdentityStoresFactory;
  /**
   * Verification-email sender, bound at the composition root to an adapter
   * over the notifications slice's template + EmailSender (see ports/email.ts).
   */
  readonly emailPort: VerificationEmailPort;
  /**
   * Password-changed security notification, bound the same way; dispatched
   * best-effort after either credential-rotation flow commits.
   */
  readonly passwordChangedEmailPort: PasswordChangedEmailPort;
  /**
   * Password-reset security notification, bound the same way; dispatched
   * best-effort after a recovery-phrase reset commits. Distinct from the
   * changed notice so a deliberate reset gets honest "reset" copy.
   */
  readonly passwordResetEmailPort: PasswordResetEmailPort;
  /**
   * Billing's single-writer stores, composed inside register-finish's
   * settlement to provision the new user's wallets + welcome credit atomically
   * with the account INSERT (billing's published within-tx surface).
   */
  readonly billingStores: BillingStores;
  /** Welcome-credit email, sent best-effort when registration grants the credit. */
  readonly welcomeEmailPort: WelcomeEmailPort;
  /** TOTP-enabled / -disabled security notifications, dispatched best-effort. */
  readonly twoFactorEnabledEmailPort: TwoFactorEnabledEmailPort;
  readonly twoFactorDisabledEmailPort: TwoFactorDisabledEmailPort;
  /** Login-lockout security notification, dispatched best-effort on the trip. */
  readonly accountLockedEmailPort: AccountLockedEmailPort;
  /** Login-2FA first-trip security notification, dispatched best-effort. */
  readonly twoFactorLockedEmailPort: TwoFactorLockedEmailPort;
  /**
   * Builds the session-revocation eviction port from request-scoped infra (the
   * Redis active-room reader + the ConversationRoom DO client). Threaded into
   * every session-revocation and credential-rotation flow so a revoked user's
   * live sockets are closed best-effort (ARCHITECTURE §Streaming & realtime).
   */
  readonly evictUser: (redis: RedisClient, env: AppEnv['Bindings']) => EvictUserPort;
  /**
   * Account-deleted confirmation, bound like the other email ports; sent
   * best-effort after the deletion transaction commits.
   */
  readonly accountDeletedEmailPort: AccountDeletedEmailPort;
  /**
   * The deletion executor's cross-slice purge surface (chat's content helpers
   * + the media-reclaim enqueue), bound at the composition root: identity may
   * not import the chat or media barrels — both already import identity, and
   * a barrel cycle is lint-banned. Built per request (the reclaim enqueue's
   * registry needs env + db).
   */
  readonly deletionPurge: (env: AppEnv['Bindings'], db: Database) => AccountDeletionPurge;
  /**
   * Growth's own read of its active campaign tags, bound at the composition
   * root. Registration counts its first funnel step through growth's published
   * door, and the tag a signup link carried has to be checked against live
   * campaigns before either the count or the account's own stamp uses it —
   * identity never reads growth's tables itself.
   */
  readonly growthStores: GrowthStores;
}
