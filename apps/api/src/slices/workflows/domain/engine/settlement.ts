import {
  runSettlement,
  runSettlementSavepoint,
  succeedKeyRow,
} from '../../../../lib/idempotency/index.js';
import { chargeWithinTx } from '../../../billing/index.js';
import { AbsorbedSettlementRefusal, SettlementConflictError } from './failures.js';
import type { SettlementCharge, SettlementHook, SettlementRequest } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { KeyRowFence, SettlementTx } from '../../../../lib/idempotency/index.js';
import type { BillingStores, ChargeInput, ChargeSender } from '../../../billing/index.js';

/**
 * The settlement-hook plumbing: the generic fenced runner every definition's
 * settlement policy plugs into. Nothing commits mid-run; the
 * whole settlement — content persistence, every node's charge, and the
 * key-row flip — commits in ONE `runSettlement` transaction, fenced by the
 * idempotency-key row. A run that lost its claim (a zombie or a superseding
 * retry) flips nothing and rolls the transaction back, so charges are
 * exactly-once by construction (billed ⟺ key flipped, atomically). A settled
 * run is also saved; a refused one is billed and saves nothing (see
 * {@link createFencedSettlementHook}). The content+charge writer and the run's
 * charge inputs are the settling slice's, injected here.
 */

/** The run lost its key-row claim at settlement; nothing committed. */
export class SettlementFenceLost extends Error {
  constructor() {
    super('settlement lost its idempotency-key claim');
    this.name = 'SettlementFenceLost';
  }
}

/** The key-row store was unavailable at settlement; the transaction rolls back. */
export class SettlementCompletionError extends Error {
  constructor(cause: unknown) {
    super('settlement key-row completion failed', { cause });
    this.name = 'SettlementCompletionError';
  }
}

/** Persists content + charges within the settlement transaction. */
export type SettlementCommit = (tx: SettlementTx, request: SettlementRequest) => Promise<void>;

/** The fenced `claimed → succeeded` flip; production wires `keyRowCompletion`. */
export type KeyRowCompletion = (
  tx: SettlementTx,
  fence: KeyRowFence
) => Promise<'flipped' | 'lost'>;

/** What a refusal commit did with a refused run's charges. */
type RefusalDisposition = 'billed' | 'absorbed';

/**
 * Bills a refused run inside the settlement transaction, after its commit's
 * savepoint rolled back: `'billed'` when the charges landed, `'absorbed'` when
 * nobody was left to pay and nothing was written.
 */
export type SettlementRefusalCommit = (
  tx: SettlementTx,
  request: SettlementRequest
) => Promise<RefusalDisposition>;

interface FencedSettlementDeps {
  readonly db: Database;
  readonly fence: KeyRowFence;
  readonly complete: KeyRowCompletion;
  readonly commit: SettlementCommit;
  /**
   * Bills a run whose {@link commit} refused. Absent for a definition whose
   * settlement bills nothing, where a refusal rolls the whole settlement back.
   */
  readonly refusalCommit?: SettlementRefusalCommit;
}

/**
 * The one seam every settlement refusal passes through. For a definition that
 * supplies a refusal commit, the definition's commit runs inside a savepoint,
 * and a {@link SettlementConflictError} from it rolls back to that savepoint and
 * runs the refusal commit instead: the run's answer already reached the client,
 * so its charges are billed although nothing is saved, or absorbed when nobody
 * is left to pay. The key row flips in the same transaction, so a same-key retry
 * replays rather than billing again, and the refusal is rethrown only after that
 * transaction commits, so the engine still reports its code. Any other throw
 * rolls the whole settlement back, unbilled. A definition with no refusal commit
 * runs its commit directly, and a refusal rolls the whole settlement back.
 */
export function createFencedSettlementHook(deps: FencedSettlementDeps): SettlementHook {
  return async (request) => {
    const refused = await runSettlement(deps.db, async (tx) => {
      const refusal = await commitOrBillRefusal(tx, request, deps);
      const outcome = await deps.complete(tx, deps.fence);
      if (outcome === 'lost') throw new SettlementFenceLost();
      return refusal;
    });
    if (refused !== undefined) throw refused;
  };
}

/** Runs the commit, or bills its refusal; yields the refusal, marked absorbed when nobody paid. */
async function commitOrBillRefusal(
  tx: SettlementTx,
  request: SettlementRequest,
  deps: FencedSettlementDeps
): Promise<SettlementConflictError | undefined> {
  const { refusalCommit } = deps;
  if (refusalCommit === undefined) {
    await deps.commit(tx, request);
    return undefined;
  }
  try {
    await runSettlementSavepoint(tx, (savepoint) => deps.commit(savepoint, request));
    return undefined;
  } catch (error) {
    if (!(error instanceof SettlementConflictError)) throw error;
    const disposition = await refusalCommit(tx, request);
    return disposition === 'absorbed' ? new AbsorbedSettlementRefusal(error) : error;
  }
}

/**
 * Production wiring of the fence flip over the idempotency-key row: the
 * `succeedKeyRow` fenced transition stores the replayable response and yields
 * `'lost'` when a zombie claimant reaches the fence. An infra error throws
 * (rolling the settlement back), never resolves to a silent outcome.
 */
export function keyRowCompletion(response: unknown): KeyRowCompletion {
  return (tx, fence) =>
    succeedKeyRow(tx, fence, response).match(
      (outcome) => outcome,
      (error) => {
        throw new SettlementCompletionError(error);
      }
    );
}

/**
 * The run-scoped facts every charge of a run shares, closed over from the
 * `RunContext` the DO threads into the settlement hook: who pays
 * (`walletId`/`payerUserId`), who sent, the run grouping id, the settlement
 * timestamp, and the group spend the run accrues. A settled run and a refused
 * one bill under the same facts.
 */
export interface RunChargeContext {
  readonly walletId: string;
  /** The owner of `walletId` — the account every charge of this run bills. */
  readonly payerUserId: string;
  /**
   * The turn's SENDER principal, stamped on every charge of the run beside the
   * payer. The two diverge whenever the owner funds someone else's turn (a
   * member's or a guest's) and coincide on a self-funded one. `null` only on a
   * refused run whose sender's row was gone at settlement.
   */
  readonly sender: ChargeSender | null;
  readonly runId: string;
  readonly now: Date;
  /**
   * The group spend an owner-funded turn accrues, present only for one (sender ≠
   * owner) whose conversation still exists. Every charge accrues its marked-up
   * cost cumulatively to the conversation's durable spend row, and to the
   * sender's durable member row when `memberId` names one (both keyed by id, no
   * period); a sender no longer a member names none. The member row's owner-set
   * cap is never touched by a spend (the insert-path cap is the zero
   * insert-default `0`); the cap is configured out of band. Absent for a
   * solo/owner turn — the owner funds and is not member-capped, so no member or
   * conversation spend is written.
   */
  readonly groupSpend?: { readonly conversationId: string; readonly memberId?: string };
}

/**
 * A settled run's charge context: the run's facts, a sender that is always
 * present, and the persist-then-charge seam.
 *
 * `contentItemIdFor` is the documented handoff to the chat slice's persist
 * seam: a charge is anchored to the content persisted for its generation, and
 * that content item is minted inside this same settlement transaction, before
 * the charge. This generic commit knows nothing about content persistence — it
 * maps a charge's stable `key` to the content id the chat slice persisted for
 * it. Which key a charge resolves against is `anchorChargeKey`'s rule; a run
 * that persisted no content at all resolves none of them, so this commit bills
 * none.
 */
export interface ChargeContext extends RunChargeContext {
  readonly sender: ChargeSender;
  readonly contentItemIdFor: (key: string) => string | undefined;
}

interface ChargingCommitDeps {
  readonly stores: BillingStores;
  readonly context: ChargeContext;
}

interface RefusalChargingCommitDeps {
  readonly stores: BillingStores;
  readonly context: RunChargeContext;
}

/**
 * The charges of a refused run: every collected charge, through billing's
 * published `chargeWithinTx`, at its billable cost with no content item and no
 * storage fee, because the refusal stored nothing. Each charge keeps the
 * `(runId, key)` idempotency key a settled run's charge would carry, so one run
 * can land each generation's charge once, whichever way it ended.
 */
export function createRefusalChargingCommit(
  deps: RefusalChargingCommitDeps
): SettlementRefusalCommit {
  return async (tx, request) => {
    for (const charge of request.charges) {
      await chargeWithinTx(deps.stores, tx, {
        ...chargeInputFor(charge, null, deps.context),
        storageFeeNanoUsd: 0n,
      });
    }
    return 'billed';
  };
}

/**
 * A `SettlementCommit` that posts every collected per-generation charge through
 * billing's published `chargeWithinTx`, deriving each `ChargeInput` from the
 * generation's own facts (the `SettlementCharge` record) plus the run context.
 * Each charge is DB-idempotent on its unique key, so a replayed settlement
 * converges on the first execution's rows.
 */
export function createChargingCommit(deps: ChargingCommitDeps): SettlementCommit {
  return async (tx, request) => {
    const runChargeKeys = request.charges.map((charge) => charge.key);
    for (const charge of request.charges) {
      const contentItemId = anchorContentItemId(
        charge.key,
        deps.context.contentItemIdFor,
        runChargeKeys
      );
      if (contentItemId === undefined) continue;
      await chargeWithinTx(deps.stores, tx, chargeInputFor(charge, contentItemId, deps.context));
    }
  };
}

/**
 * A charge's content anchor, resolved nearest-first over three rules:
 *
 * 1. the content persisted for the charge's OWN key;
 * 2. the content persisted for its base node — charge keys nest (a fanOut branch
 *    is `<node>#<index>`, and the interpreter suffixes an auxiliary generation
 *    once more), so this strips the LAST suffix segment only, never down to the
 *    bare node id;
 * 3. the RUN's own anchor: the first key in `runChargeKeys` that persisted
 *    content.
 *
 * Rule 3 is what keeps a charge whose generation persists nothing of its own
 * billed rather than absorbed — a turn-level classifier has no content and no
 * parent that does, and naming a sibling would not help, since that sibling may
 * be the one that failed. `runChargeKeys` is the run's charge keys in the order
 * the interpreter collected them, which is the definition's topological order,
 * so the anchor is the same content item on every replay of the same run.
 *
 * `undefined` means the RUN persisted nothing, and no charge of it lands through
 * this commit: a settled run bills only against content it persisted. A refused
 * run bills through {@link createRefusalChargingCommit} instead, with no anchor.
 *
 * Both the wallet debit and the displayed per-item cost anchor through this one
 * function, so a charge cannot be debited against one content item and
 * displayed on another.
 */
export function anchorChargeKey(
  key: string,
  persistedContentFor: (key: string) => boolean,
  runChargeKeys: readonly string[]
): string | undefined {
  if (persistedContentFor(key)) return key;
  const separator = key.lastIndexOf('#');
  if (separator !== -1) {
    const base = key.slice(0, separator);
    if (persistedContentFor(base)) return base;
  }
  return runChargeKeys.find((candidate) => persistedContentFor(candidate));
}

/** The content item a charge's anchor names, resolved through the one rule above. */
function anchorContentItemId(
  key: string,
  contentItemIdFor: ChargeContext['contentItemIdFor'],
  runChargeKeys: readonly string[]
): string | undefined {
  const anchor = anchorChargeKey(
    key,
    (candidate) => contentItemIdFor(candidate) !== undefined,
    runChargeKeys
  );
  return anchor === undefined ? undefined : contentItemIdFor(anchor);
}

/**
 * Builds the `ChargeInput` from a per-generation record and the run context:
 * the model facts and billable cost from the record, who-pays and the run
 * grouping from the context, and the DB-idempotency key derived from
 * `(runId, key)` — unique per generation per run. The cost is charged as-is —
 * fees were applied at the seams, never here or downstream.
 */
function chargeInputFor(
  charge: SettlementCharge,
  contentItemId: string | null,
  context: RunChargeContext
): ChargeInput {
  return {
    walletId: context.walletId,
    payerUserId: context.payerUserId,
    sender: context.sender,
    runId: context.runId,
    contentItemId,
    modelId: charge.modelId,
    providerName: charge.providerName,
    modality: charge.modality,
    ...(charge.generationId === undefined ? {} : { generationId: charge.generationId }),
    billableCostNanoUsd: charge.billableCostNanoUsd,
    storageFeeNanoUsd: charge.storageFeeNanoUsd ?? 0n,
    isEstimated: charge.isEstimated,
    ...(charge.tokens === undefined ? {} : { tokens: charge.tokens }),
    ...(charge.media === undefined ? {} : { media: charge.media }),
    ...(charge.reasoningEffort === undefined ? {} : { reasoningEffort: charge.reasoningEffort }),
    ...(charge.reasoningDurationMs === undefined
      ? {}
      : { reasoningDurationMs: charge.reasoningDurationMs }),
    idempotencyKey: `${context.runId}:${charge.key}`,
    now: context.now,
    ...groupSpendInput(context.groupSpend),
  };
}

/**
 * A group turn's cumulative spend: always the conversation's spend row, and the
 * sender's member row when the run still names one. The member insert-path cap
 * is the zero insert-default `0` (a correctly-gated turn already has an
 * owner-set row, so this only ever hits ON CONFLICT and preserves the configured
 * cap; the `0` is a should-never-insert fallback, never a permissive
 * conversation cap).
 */
function groupSpendInput(
  groupSpend: RunChargeContext['groupSpend']
): Pick<ChargeInput, 'memberBudget' | 'conversationId'> {
  if (groupSpend === undefined) return {};
  return {
    conversationId: groupSpend.conversationId,
    ...(groupSpend.memberId === undefined
      ? {}
      : { memberBudget: { memberId: groupSpend.memberId, budgetNanoUsd: 0n } }),
  };
}
