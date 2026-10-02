import { evictPrincipals } from '../domain/index.js';
import type { Context } from 'hono';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationEventNotification, broadcastForkCreated } from '../domain/index.js';
import type { ConversationsRouteDeps } from './deps.js';

/**
 * Fires the membership notification after the mutation has committed, as a
 * registered side-band so it survives the response and keeps the request pool
 * open for its membership reads. Best-effort by construction: the
 * capability reports its own failures, and building it inside the promise
 * chain means even a synchronous throw from a misconfigured push sender becomes
 * a caught rejection instead of reaching the request path.
 *
 * The routes hold no presence snapshot (only the room does), so the empty
 * snapshot suppresses nobody — a member watching live already received the
 * membership broadcast frame, so the cost is at most one redundant nudge.
 */
export function notifyMembershipEvent(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  notification: Omit<ConversationEventNotification, 'presentUserIds'>
): void {
  const factory = deps.notifyConversationEvent;
  if (factory === undefined) return;
  const task = async (): Promise<void> => {
    try {
      await factory(c.env, c.var.db, c.var.logger)({ ...notification, presentUserIds: [] });
      // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort registered side-band: the failure is logged and deliberately not rethrown, so it can never reach the request path.
    } catch {
      c.var.logger.warn('membership notification failed', {
        conversationId: notification.conversationId,
      });
    }
  };
  c.var.sideBand(task());
}

/**
 * Post-commit realtime-event broadcast; best-effort. A failed fan-out is
 * logged, never unwound — the mutation already committed and a client resync
 * recovers.
 */
export async function broadcastAfterCommit(
  c: Context<AppEnv>,
  conversationId: string,
  run: () => ReturnType<typeof broadcastForkCreated>
): Promise<void> {
  const broadcast = await run();
  if (broadcast.isErr()) {
    c.var.logger.warn('realtime event broadcast failed', {
      conversationId,
      errorCode: broadcast.error.code,
    });
  }
}

/** Post-commit eviction; failures are logged, never unwound (cache TTL recovers). */
export async function evictAfterCommit(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  principalIds: readonly string[]
): Promise<void> {
  const evicted = await evictPrincipals(
    { revoker: deps.revoker(c.var.redis), realtime: deps.realtime(c.env) },
    conversationId,
    principalIds
  );
  if (evicted.isErr()) {
    c.var.logger.warn('conversation eviction incomplete', {
      conversationId,
      errorCode: evicted.error.code,
    });
  }
}
