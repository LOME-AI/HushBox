import {
  campaignTagSchema,
  GROWTH_DIRECT_CAMPAIGN,
  GROWTH_UNKNOWN_CAMPAIGN,
} from '@hushbox/shared';
import { conflictError, notFoundError, validationError } from '../../../lib/errors/index.js';
import { err, errAsync, ok, okAsync } from '../../../lib/result/index.js';
import {
  archiveActiveCampaignWithinTx,
  insertOrReactivateCampaignWithinTx,
  readCampaignWithinTx,
} from '../adapters/campaign-writes.js';
import type { CampaignRow } from '../adapters/reads.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

export type { CampaignRow } from '../adapters/reads.js';

/**
 * The two tags every beacon folds to. One means the visit named no campaign,
 * the other that it named one nobody is running, so a real campaign may claim
 * neither and neither may be retired — every growth row kept forever points at
 * one of them.
 */
const SEEDED_TAGS = new Set<string>([GROWTH_DIRECT_CAMPAIGN, GROWTH_UNKNOWN_CAMPAIGN]);

/**
 * The one per-person identifier shape the tag pattern admits, lowercase hex
 * being legal in it. A tag is a label every clicker shares, so an operator
 * pasting a value minted per person is refused rather than trusted; the
 * general label-versus-token property is the operator's to hold and the audit
 * row's to record, which is why this names one shape rather than guessing at
 * entropy.
 */
const IDENTIFIER_SHAPED_TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tag a campaign may be minted under, refused before any statement runs. */
function validTag(tag: string): Result<string, DomainError> {
  if (!campaignTagSchema.safeParse(tag).success) {
    return err(validationError('campaign tag is not a legal tag'));
  }
  if (SEEDED_TAGS.has(tag)) {
    return err(validationError('campaign tag is a seeded tag'));
  }
  if (IDENTIFIER_SHAPED_TAG.test(tag)) {
    return err(validationError('campaign tag is shaped like an identifier'));
  }
  return ok(tag);
}

/**
 * The label as it is stored. Blank is refused because the label is the only
 * thing that tells one campaign from another on the operator's screen; the
 * stored length is bounded by the column's own check.
 */
function validLabel(label: string): Result<string, DomainError> {
  const trimmed = label.trim();
  return trimmed.length === 0 ? err(validationError('campaign label is blank')) : ok(trimmed);
}

/**
 * Mint a campaign inside the caller's transaction — the growth slice's write
 * door for the admin plane, which owns the transaction that also carries the
 * operation's audit row.
 *
 * Creating a tag an archive retired returns that campaign to active, which is
 * what makes the create/archive pair mutual inverses: neither direction
 * destroys a row, and either can be undone by the other.
 */
export function createCampaignWithinTx(
  tx: SettlementTx,
  campaign: { readonly tag: string; readonly label: string }
): ResultAsync<CampaignRow, DomainError> {
  return validTag(campaign.tag)
    .andThen((tag) => validLabel(campaign.label).map((label) => ({ tag, label })))
    .asyncAndThen((valid) =>
      insertOrReactivateCampaignWithinTx(tx, valid).andThen((row) =>
        row === null
          ? errAsync<CampaignRow, DomainError>(
              conflictError('an active campaign already holds this tag')
            )
          : okAsync(row)
      )
    );
}

/**
 * Retire a campaign inside the caller's transaction. The row survives with its
 * status changed, so the counts that reference the tag still resolve and the
 * create restores it.
 */
export function archiveCampaignWithinTx(
  tx: SettlementTx,
  tag: string
): ResultAsync<CampaignRow, DomainError> {
  if (SEEDED_TAGS.has(tag)) {
    return errAsync(validationError('a seeded campaign tag cannot be retired'));
  }
  return archiveActiveCampaignWithinTx(tx, tag).andThen((row) =>
    row === null
      ? readCampaignWithinTx(tx, tag).andThen((standing) =>
          standing === null
            ? errAsync<CampaignRow, DomainError>(notFoundError('no campaign holds this tag'))
            : okAsync(standing)
        )
      : okAsync(row)
  );
}
