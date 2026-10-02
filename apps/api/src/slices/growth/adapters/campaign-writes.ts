import { and, eq, sql } from 'drizzle-orm';
import { campaigns } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { CampaignRow } from './reads.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** The columns every campaign statement answers with — the row's uuid stays behind, exactly as the list read leaves it. */
const CAMPAIGN_COLUMNS = {
  tag: campaigns.tag,
  label: campaigns.label,
  status: campaigns.status,
  createdAt: campaigns.createdAt,
};

/** One mapper for campaign statement rejections: infra failures become `unavailable`. */
function writeFailure(cause: unknown): DomainError {
  return unavailableError('growth campaign write failed', cause);
}

/**
 * Land the campaign on the caller's transaction, so the effect commits with
 * whatever else that transaction writes and rolls back with it. Nothing here
 * opens a transaction of its own.
 *
 * One conditional upsert rather than a read followed by a write: the conflict
 * clause fires only for a row this operation may legally move — an archived
 * one, which it returns to active (the archive statement's exact reversal, so
 * the two are mutual inverses and neither destroys state), or an active one
 * already carrying this label, which makes a replay a no-op. An active row
 * under a different label matches neither, so the statement leaves it
 * untouched and answers `null`: the caller decides what a taken tag means
 * without ever having tested for it first.
 */
export function insertOrReactivateCampaignWithinTx(
  tx: SettlementTx,
  campaign: { readonly tag: string; readonly label: string }
): ResultAsync<CampaignRow | null, DomainError> {
  return fromPromise(
    tx
      .insert(campaigns)
      .values({ tag: campaign.tag, label: campaign.label, status: 'active' })
      .onConflictDoUpdate({
        target: campaigns.tag,
        set: { status: 'active', label: campaign.label },
        // `excluded` is the row the insert proposed; the bare column
        // references are the row already stored.
        setWhere: sql`${campaigns.status} = 'archived' or ${campaigns.label} = excluded.label`,
      })
      .returning(CAMPAIGN_COLUMNS),
    writeFailure
  ).map((rows) => rows[0] ?? null);
}

/**
 * Retire the campaign on the caller's transaction. The status predicate is in
 * the statement, so nothing reads the row and then decides: an already-retired
 * or absent tag matches no row and answers `null`, which the caller resolves
 * against the actual state.
 */
export function archiveActiveCampaignWithinTx(
  tx: SettlementTx,
  tag: string
): ResultAsync<CampaignRow | null, DomainError> {
  return fromPromise(
    tx
      .update(campaigns)
      .set({ status: 'archived' })
      .where(and(eq(campaigns.tag, tag), eq(campaigns.status, 'active')))
      .returning(CAMPAIGN_COLUMNS),
    writeFailure
  ).map((rows) => rows[0] ?? null);
}

/** The campaign a tag currently names, read on the caller's transaction so it reflects that transaction's own writes. */
export function readCampaignWithinTx(
  tx: SettlementTx,
  tag: string
): ResultAsync<CampaignRow | null, DomainError> {
  return fromPromise(
    tx.select(CAMPAIGN_COLUMNS).from(campaigns).where(eq(campaigns.tag, tag)).limit(1),
    writeFailure
  ).map((rows) => rows[0] ?? null);
}
