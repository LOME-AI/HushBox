import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type {
  BudgetBilling,
  ConversationsStoresFactory,
  DbWriter,
  ForkMessageDeleter,
  LinkResolutionPort,
  MembershipRevoker,
  NotifyConversationEventFactory,
  RealtimeBroadcast,
} from '../domain/index.js';

/** The pipeline's Redis client type, named without importing the infra module. */
type RequestRedis = AppEnv['Variables']['redis'];

export interface ConversationsRouteDeps {
  /** Bound per call site to the pipeline's `c.var.db` or a byKey transaction. */
  readonly stores: ConversationsStoresFactory;
  /**
   * Billing's published reads/writes composed by the owner-facing budget
   * surface: the per-member cap write (billing single-writes `member_budgets`)
   * plus the reads the display needs (member caps + spend, conversation spend,
   * owner wallet balance). Wired at app assembly; a port double in tests.
   */
  readonly billing: BudgetBilling;
  /** Membership-cache invalidation over the pipeline's `c.var.redis`. */
  readonly revoker: (redis: RequestRedis) => MembershipRevoker;
  /** ConversationRoom DO client; a port double in tests (infra edge). */
  readonly realtime: (env: AppEnv['Bindings']) => RealtimeBroadcast;
  /**
   * Chat's `messages` deleter, bound to the fork-delete transaction. Composed
   * so a fork deletion removes its orphaned branch messages atomically with the
   * fork row — conversations decides which ids, chat (the single writer) deletes.
   */
  readonly deleteForkMessages: (db: DbWriter) => ForkMessageDeleter;
  /**
   * Identity's shared-link credential resolution, bound to the request db. The
   * guest-reachable reads and the socket-ticket mint are `public`-class (the HTTP matrix
   * admits no link-guest principal), so the handler resolves the
   * `LINK_CREDENTIAL_HEADER` credential itself. The composition root binds
   * `createLinkResolutionAdapter`.
   */
  readonly linkResolution: (db: DbWriter) => LinkResolutionPort;
  /**
   * The membership-event push capability, built per request at the composition
   * root (this slice may not import the notifications barrel). Optional: an
   * absent binding is a no-op, so a deployment without push still serves every
   * mutation unchanged.
   */
  readonly notifyConversationEvent?: NotifyConversationEventFactory;
}
