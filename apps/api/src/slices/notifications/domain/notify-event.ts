import { okAsync } from '../../../lib/result/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { selectNotifyRecipients } from './notify-decision.js';
import type { NotificationCategory } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  DeviceTokenStore,
  MembershipReader,
  NotificationPreferencesStore,
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushSender,
} from '../ports/index.js';

const NOTHING_DELIVERED: PushDelivery = { successCount: 0, failureCount: 0 };

/**
 * How many *retryable* rejections a wholly-failed send needs before it pages
 * rather than only logging. Independent per-target rejections rarely coincide,
 * while a revoked credential or a push-service outage rejects every target of
 * every send — so a whole fan-out failing is the outage signal, and a lone
 * target failing is indistinguishable from one flaky device, which push
 * tolerates by doctrine.
 */
const PAGE_MIN_RETRYABLE_REJECTIONS = 2;

export interface NotifyEventDeps {
  readonly membership: MembershipReader;
  readonly preferences: Pick<NotificationPreferencesStore, 'readForUsers'>;
  readonly deviceTokens: Pick<
    DeviceTokenStore,
    'listTokensForUsers' | 'deleteByToken' | 'touchLastSeen'
  >;
  readonly push: PushSender;
  readonly logger: Telemetry;
  /** Injected clock for the quiet-hours evaluation; defaults to wall time. */
  readonly now?: () => Date;
}

export interface NotifyEventInput {
  readonly category: NotificationCategory;
  readonly conversationId: string;
  /** The user who caused the event; the decision function drops them per category. */
  readonly actorUserId: string | null;
  /**
   * When present, narrows candidates to these users (still filtered by the
   * decision function) — e.g. a membership event targets the added member.
   * Absent means every active member is a candidate.
   */
  readonly recipientUserIds?: readonly string[];
  /** Users present at fire time (caller's snapshot); suppressed downstream. */
  readonly presentUserIds: readonly string[];
}

/**
 * Best-effort, channel-blind notification for one conversation event. Reads
 * the active members, narrows to the target set, applies the single decision
 * function (prefs, quiet hours, mute, presence, actor), fans out to the
 * survivors' devices, and prunes tokens the sender reports dead. The wire
 * payload is generic (`category` + `conversationId`) and is the only thing
 * sent: each transport looks the notification's words up from the category, so
 * this layer never handles text. The composite sender derives the alias. A failure
 * anywhere is logged with its code and returned as a Result — the caller
 * fires-and-forgets; nothing here can crash a request.
 */
export function notifyEvent(
  deps: NotifyEventDeps,
  input: NotifyEventInput
): ResultAsync<PushDelivery, DomainError> {
  const now = (deps.now ?? (() => new Date()))();
  return resolveRecipients(deps, input, now)
    .andThen((recipients) =>
      recipients.length === 0
        ? okAsync<PushDelivery, DomainError>(NOTHING_DELIVERED)
        : deliverToRecipients(deps, input, recipients)
    )
    .mapErr((error) => {
      deps.logger.warn('push.delivery.degraded', {
        errorCode: error.code,
        conversationId: input.conversationId,
      });
      return error;
    });
}

/**
 * Surfaces a push outage, which is otherwise indistinguishable from success:
 * the sender returns Ok with counts nobody reads, and the fire-and-forget
 * caller drops the result. Two shapes reach here, and they are separate
 * branches because the counts alone cannot tell them apart.
 *
 * The first is a target that got no verdict at all. Every transport returns
 * exactly one verdict per recipient it is handed, so fewer verdicts than
 * targets means a whole partition failed before any per-target result existed —
 * an errored partition folds to no delivery rather than failing the composite,
 * which is what turns a revoked service account into counts of zero. It is
 * never per-device flakiness, so it pages on sight, and it pages even when the
 * other partition delivered: half a fan-out silently going nowhere is the same
 * outage.
 *
 * The second is a send every target rejected. Here `failureCount` is not the
 * page-worthy number: both transports count a permanently-gone target in
 * `failureCount` AND list it in `deadTokens`, so the two overlap rather than
 * partition, and a send whose whole target set was merely stale would otherwise
 * page for what is routine drift that prunes itself. Subtracting the dead ones
 * leaves the retryable rejections the threshold rests on.
 */
function reportUndelivered(
  deps: Pick<NotifyEventDeps, 'logger'>,
  input: NotifyEventInput,
  dispatched: number,
  delivery: PushDelivery
): PushDelivery {
  if (delivery.successCount + delivery.failureCount < dispatched) {
    deps.logger.error('push delivery dispatched targets the transport returned no verdict for', {
      conversationId: input.conversationId,
      successCount: delivery.successCount,
      failureCount: delivery.failureCount,
      errorCode: FINGERPRINT_CODES.pushDeliveryTotalFailure,
    });
    deps.logger.captureError(
      new Error('push delivery dispatched targets the transport returned no verdict for'),
      FINGERPRINT_CODES.pushDeliveryTotalFailure
    );
    return delivery;
  }
  if (delivery.successCount > 0 || delivery.failureCount === 0) {
    return delivery;
  }
  deps.logger.error('push delivery reached no target of a send', {
    conversationId: input.conversationId,
    successCount: delivery.successCount,
    failureCount: delivery.failureCount,
    errorCode: FINGERPRINT_CODES.pushDeliveryTotalFailure,
  });
  const retryableRejections = delivery.failureCount - (delivery.deadTokens?.length ?? 0);
  if (retryableRejections >= PAGE_MIN_RETRYABLE_REJECTIONS) {
    deps.logger.captureError(
      new Error('push delivery reached no target of a send'),
      FINGERPRINT_CODES.pushDeliveryTotalFailure
    );
  }
  return delivery;
}

/** Reads members, narrows to the target set, and applies the decision function. */
function resolveRecipients(
  deps: Pick<NotifyEventDeps, 'membership' | 'preferences'>,
  input: NotifyEventInput,
  now: Date
): ResultAsync<readonly string[], DomainError> {
  return deps.membership.listActiveUserMembers(input.conversationId).andThen((members) => {
    const targeted = input.recipientUserIds;
    const candidates =
      targeted === undefined
        ? members
        : members.filter((member) => targeted.includes(member.userId));
    return deps.preferences
      .readForUsers(candidates.map((member) => member.userId))
      .map((prefsByUser) =>
        selectNotifyRecipients({
          members: candidates,
          category: input.category,
          prefsByUser,
          presentUserIds: input.presentUserIds,
          actorUserId: input.actorUserId,
          now,
        })
      );
  });
}

/** Fans the generic payload out to the survivors' devices and prunes dead ones. */
function deliverToRecipients(
  deps: Pick<NotifyEventDeps, 'deviceTokens' | 'push' | 'logger'>,
  input: NotifyEventInput,
  recipients: readonly string[]
): ResultAsync<PushDelivery, DomainError> {
  return deps.deviceTokens.listTokensForUsers(recipients).andThen((tokens) => {
    if (tokens.length === 0) {
      return okAsync<PushDelivery, DomainError>(NOTHING_DELIVERED);
    }
    const message: PushMessage = {
      recipients: tokens,
      payload: { category: input.category, conversationId: input.conversationId },
    };
    return deps.push
      .send(message)
      .map((delivery) => reportUndelivered(deps, input, tokens.length, delivery))
      .andThen((delivery) => pruneDeadTokens(deps, delivery))
      .andThen((delivery) => touchDeliveredTokens(deps, delivery));
  });
}

/**
 * Refreshes `lastSeenAt` on every target the push service accepted. A device
 * that receives notifications is alive, and `lastSeenAt` is the only signal
 * the retention delete reads — without this touch an actively-notified device
 * that never re-registers would be deleted as stale.
 */
function touchDeliveredTokens(
  deps: Pick<NotifyEventDeps, 'deviceTokens'>,
  delivery: PushDelivery
): ResultAsync<PushDelivery, DomainError> {
  const delivered: readonly PushDeviceRef[] = delivery.deliveredTokens ?? [];
  if (delivered.length === 0) {
    return okAsync(delivery);
  }
  return deps.deviceTokens.touchLastSeen(delivered).map(() => delivery);
}

/**
 * Prunes every target the sender reported permanently gone, each with the
 * user-scoped `deleteByToken`. Without this, `device_tokens` grows
 * monotonically with uninstalled devices and revoked subscriptions.
 */
function pruneDeadTokens(
  deps: Pick<NotifyEventDeps, 'deviceTokens'>,
  delivery: PushDelivery
): ResultAsync<PushDelivery, DomainError> {
  const dead: readonly PushDeviceRef[] = delivery.deadTokens ?? [];
  // One delete at a time: the request's database is serial and refuses a
  // delete issued while another is in flight.
  let pruned = okAsync<PushDelivery, DomainError>(delivery);
  for (const ref of dead) {
    pruned = pruned.andThen(() =>
      deps.deviceTokens.deleteByToken(ref.userId, ref.token).map(() => delivery)
    );
  }
  return pruned;
}
