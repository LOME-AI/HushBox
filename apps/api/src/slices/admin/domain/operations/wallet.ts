import { ADMIN_OP_CONTRACTS, serializeNanoUSD } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { defineAdminOp } from '../registry.js';
import { deriveAdjustmentKeys, recordWalletMove } from './money-adjustment.js';
import type { z } from 'zod';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { BillingStores, WalletRecord } from '../../../billing/index.js';
import type { AdminOpContext, AdminOpOutcome } from '../registry.js';
import type { AdminWalletSnapshotPostDeps } from './money-adjustment.js';

/**
 * The money inverse pair — `wallet.credit` ↔ `wallet.clawback` — composed
 * entirely from billing's published surface on the engine-owned
 * `SettlementTx`. Both directions post a zero-sum leg pair against the
 * `promo` house account (a credit is admin goodwill, its clawback the exact
 * reversal), so a credit + clawback pair nets the house account — and the
 * wallet — to zero: the Iron Law's testable invariant.
 */

const creditContract = ADMIN_OP_CONTRACTS['wallet.credit'];
const clawbackContract = ADMIN_OP_CONTRACTS['wallet.clawback'];

type WalletAdjustmentInput = z.output<(typeof creditContract)['input']>;

export interface AdminWalletDeps {
  readonly billingStores: BillingStores;
}

/** What the engine hands the snapshot effect once the transaction has committed. */
export type AdminWalletPostDeps = AdminWalletSnapshotPostDeps;

interface WalletAdjustmentSpec {
  readonly opName: (typeof creditContract)['name'];
  readonly ledgerKind: 'promo' | 'clawback';
  /** +1n credits the wallet; -1n debits it (the house counter-leg mirrors). */
  readonly walletSign: 1n | -1n;
}

/** The billing adapter reports a missing lock target by this exact message. */
const WALLET_NOT_FOUND_MESSAGE = 'wallet to lock does not exist';

async function lockWallet(
  ctx: AdminOpContext<AdminWalletDeps>,
  walletId: string
): Promise<Result<WalletRecord, DomainError>> {
  try {
    return ok(await ctx.deps.billingStores.lockWalletWithinTx(ctx.tx, walletId));
  } catch (error) {
    // An admin-supplied wallet id is user input, so a missing row is a typed
    // refusal, not a defect; anything else (infra failure) stays a defect and
    // rethrows into the engine's 500 path.
    if (error instanceof Error && error.message.includes(WALLET_NOT_FOUND_MESSAGE)) {
      return err(notFoundError('wallet does not exist'));
    }
    throw error;
  }
}

async function adjustWallet(
  ctx: AdminOpContext<AdminWalletDeps, AdminWalletPostDeps>,
  input: WalletAdjustmentInput,
  spec: WalletAdjustmentSpec
): Promise<Result<AdminOpOutcome, DomainError>> {
  const locked = await lockWallet(ctx, input.walletId);
  if (locked.isErr()) return err(locked.error);
  const wallet = locked.value;

  const amountWire = serializeNanoUSD(input.amountNanoUsd);
  const keys = await deriveAdjustmentKeys({
    opName: spec.opName,
    subject: { walletId: wallet.id },
    amountNanoUsd: amountWire,
    reason: input.reason,
    undoes: ctx.undoes,
  });

  const delta = spec.walletSign * input.amountNanoUsd;
  const balanceAfterNanoUsd = wallet.balanceNanoUsd + delta;
  const ledgerSeq = wallet.ledgerSeq + 1n;
  // Admin goodwill and its reversal ride the `promo` house account, and carry
  // no payment id — this pair answers to no `payments` row.
  const posted = await ctx.deps.billingStores.insertLedgerLegsIfAbsentWithinTx(ctx.tx, [
    {
      transactionId: keys.transactionId,
      kind: spec.ledgerKind,
      amountNanoUsd: delta,
      balanceAfterNanoUsd,
      walletId: wallet.id,
      idempotencyKey: keys.wallet,
    },
    {
      transactionId: keys.transactionId,
      kind: spec.ledgerKind,
      amountNanoUsd: -delta,
      houseAccount: 'promo',
      idempotencyKey: keys.house,
    },
  ]);
  if (!posted) {
    return err(conflictError('this wallet adjustment already posted to the ledger'));
  }
  // Unguarded by design: a negative balance is a legal state (settlement is
  // never balance-guarded — billing doctrine).
  await ctx.deps.billingStores.updateWalletBalanceWithinTx(
    ctx.tx,
    wallet.id,
    balanceAfterNanoUsd,
    ledgerSeq
  );

  return ok({
    effects: [recordWalletMove(ctx, spec.opName, { wallet, balanceAfterNanoUsd, ledgerSeq })],
    target: { type: 'wallet', id: wallet.id },
    // Inverse snapshot semantics: the undo reverses exactly this amount. Its
    // justification is the operator's own, typed at undo time, so it is no
    // part of what the inverse must reproduce.
    inverseInput: {
      walletId: wallet.id,
      amountNanoUsd: amountWire,
    },
  });
}

export const walletCredit = defineAdminOp<
  AdminWalletDeps,
  (typeof creditContract)['input'],
  AdminWalletPostDeps
>(creditContract, {
  execute: (ctx, input) =>
    adjustWallet(ctx, input, {
      opName: creditContract.name,
      ledgerKind: 'promo',
      walletSign: 1n,
    }),
});

export const walletClawback = defineAdminOp<
  AdminWalletDeps,
  (typeof clawbackContract)['input'],
  AdminWalletPostDeps
>(clawbackContract, {
  execute: (ctx, input) =>
    adjustWallet(ctx, input, {
      opName: clawbackContract.name,
      ledgerKind: 'clawback',
      walletSign: -1n,
    }),
});
