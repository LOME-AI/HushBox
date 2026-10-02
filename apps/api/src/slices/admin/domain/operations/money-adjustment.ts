import { hashCanonicalJson, uuidFromHex } from '../../../../lib/idempotency/index.js';
import { writeThroughSnapshot } from '../../../billing/index.js';
import type { WalletRecord } from '../../../billing/index.js';
import type { AdminOpContext, AdminOpEffect } from '../registry.js';

/**
 * The mechanics every admin money adjustment shares, whatever it adjusts:
 * the adjustment's derived identity and leg keys, and the post-commit wallet
 * snapshot. What differs — the house account, the wallet resolution, and
 * whether a payment id rides the legs — stays with the op that knows it.
 *
 * Sharing this is what keeps a fix to the identity derivation or the snapshot
 * write-through from landing on one admin money path and missing the other.
 */

/** The Redis handle `writeThroughSnapshot` accepts (billing does not barrel-export its `RedisClient` alias). */
export type WalletSnapshotRedis = Parameters<typeof writeThroughSnapshot>[0];

/** What the engine hands the snapshot effect once the transaction has committed. */
export interface AdminWalletSnapshotPostDeps {
  readonly redis: WalletSnapshotRedis;
}

/** The transaction id and the two leg keys one admin adjustment posts under. */
interface AdminAdjustmentKeys {
  readonly transactionId: string;
  readonly wallet: string;
  readonly house: string;
}

export interface AdminAdjustmentIdentity {
  readonly opName: string;
  /** What the adjustment is against: `{ walletId }` or `{ paymentId }`. */
  readonly subject: Readonly<Record<string, string>>;
  /** The amount as it goes on the wire — decimal nano-USD, never a number. */
  readonly amountNanoUsd: string;
  /** The operator's justification, part of the adjustment's logical identity. */
  readonly reason: string;
  /** The audit row an undo reverses; absent on a forward run. */
  readonly undoes: string | undefined;
}

/**
 * The adjustment's logical identity — op + subject + amount + reason, plus the
 * audit row an undo reverses — hashed into a transaction id and a leg-key
 * pair. No randomness: preview and execute must derive identical identities
 * from the same pre-state, and the derived leg-unique keys are the money-DB
 * backstop, so re-posting the same logical adjustment hits `ON CONFLICT DO
 * NOTHING` and refuses instead of double-applying. A deliberate second
 * identical adjustment needs a distinct reason, which admin ops require
 * anyway; an undo instead takes its uniqueness from the engine-owned target,
 * so two undos of two identical adjustments post even when the operator
 * justifies both with the same words. The undo term is spread in only when
 * present, so a forward run's identity is exactly what it has always been.
 */
export async function deriveAdjustmentKeys(
  identity: AdminAdjustmentIdentity
): Promise<AdminAdjustmentKeys> {
  const digest = await hashCanonicalJson({
    op: identity.opName,
    ...identity.subject,
    amountNanoUsd: identity.amountNanoUsd,
    reason: identity.reason,
    ...(identity.undoes === undefined ? {} : { undoes: identity.undoes }),
  });
  const base = `admin:${identity.opName}:${digest}`;
  return {
    transactionId: uuidFromHex(digest),
    wallet: `${base}:wallet`,
    house: `${base}:house`,
  };
}

/** A settled wallet move: where the balance landed and at which sequence. */
interface WalletMove {
  readonly wallet: WalletRecord;
  readonly balanceAfterNanoUsd: bigint;
  readonly ledgerSeq: bigint;
}

/**
 * The tail of every admin money adjustment: registers the post-commit
 * snapshot write-through and returns the balance line the preview diff
 * renders as wire strings.
 */
export function recordWalletMove<PostDeps extends AdminWalletSnapshotPostDeps>(
  ctx: AdminOpContext<unknown, PostDeps>,
  opName: string,
  move: WalletMove
): AdminOpEffect {
  ctx.registerEphemeral({
    name: `${opName}.snapshot`,
    run: async (post): Promise<void> => {
      // Post-commit best-effort: money commits in Postgres first; the CAS
      // write-through keeps the next admission from gating on a stale
      // balance. A lost CAS (newer snapshot) is ordinary; a Redis failure
      // throws so the engine's telemetry sees it — never failing the op.
      const written = await writeThroughSnapshot(post.redis, {
        walletId: move.wallet.id,
        balanceNanoUsd: move.balanceAfterNanoUsd,
        ledgerSeq: move.ledgerSeq,
        walletType: move.wallet.type,
      });
      if (written.isErr()) {
        throw new Error(`wallet snapshot write-through failed: ${written.error.code}`);
      }
    },
  });
  return {
    label: 'wallet.balanceNanoUsd',
    before: move.wallet.balanceNanoUsd.toString(10),
    after: move.balanceAfterNanoUsd.toString(10),
  };
}
