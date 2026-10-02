import type { SettlementTx } from '../../../../lib/idempotency/index.js';
import type { BillingStores, WalletRecord } from '../../ports/index.js';

/**
 * The transaction id and the two leg keys one adjustment posts under — the
 * only thing that varies between the automatic path and the operator's.
 *
 * The automatic path keys per payment (`deposit:<paymentId>:user`); an admin
 * op keys per derived adjustment identity (`admin:<op>:<identity>:wallet`).
 * The two strategies must stay distinct: a claw back returns a row to
 * `awaiting_webhook`, where a real webhook may still land, and a redelivery
 * blocked by an admin run's leftover key would fail every time forever.
 */
export interface PaymentAdjustmentKeys {
  readonly transactionId: string;
  readonly wallet: string;
  readonly house: string;
}

interface PaymentAdjustment {
  readonly paymentId: string;
  readonly userId: string;
  readonly kind: 'deposit' | 'clawback';
  /** Signed wallet delta: positive credits the payer, negative claws back. */
  readonly deltaNanoUsd: bigint;
  readonly keys: PaymentAdjustmentKeys;
}

export interface PaymentAdjustmentPosting {
  readonly wallet: WalletRecord;
  readonly balanceAfterNanoUsd: bigint;
  readonly ledgerSeq: bigint;
  /** False when the keys were already claimed — already-done is a no-op. */
  readonly posted: boolean;
}

/**
 * What a payment's money move IS, in one place: the payer's `purchased`
 * wallet against the `payments-in` house account, both legs carrying the
 * payment id, summing to zero. Every writer of a `payments` row's money half
 * posts through here, so the ledger reads the same whoever settled the row and
 * a change to the account or the wallet type cannot reach one path without the
 * others.
 *
 * The insert is guarded rather than bare because the claim transition is not
 * the only writer of `payments.status`: the operator's resolve path returns a
 * credited row to `awaiting_webhook`, where a redelivery or a live verify
 * attempt re-claims it and arrives with this payment's keys already taken.
 * Already-done is a no-op (idempotency doctrine), never a unique violation
 * reported to the provider as a retryable failure. The balance move belongs
 * to the legs: skipping it on a duplicate is what keeps the wallet equal to
 * the sum of its legs.
 */
export async function postPaymentAdjustmentWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  adjustment: PaymentAdjustment
): Promise<PaymentAdjustmentPosting> {
  const walletRef = await stores.insertWalletIfAbsentWithinTx(tx, adjustment.userId, 'purchased');
  const wallet = await stores.lockWalletWithinTx(tx, walletRef.id);
  const balanceAfterNanoUsd = wallet.balanceNanoUsd + adjustment.deltaNanoUsd;
  const ledgerSeq = wallet.ledgerSeq + 1n;
  const posted = await stores.insertLedgerLegsIfAbsentWithinTx(tx, [
    {
      transactionId: adjustment.keys.transactionId,
      kind: adjustment.kind,
      amountNanoUsd: adjustment.deltaNanoUsd,
      balanceAfterNanoUsd,
      walletId: wallet.id,
      paymentId: adjustment.paymentId,
      idempotencyKey: adjustment.keys.wallet,
    },
    {
      transactionId: adjustment.keys.transactionId,
      kind: adjustment.kind,
      amountNanoUsd: -adjustment.deltaNanoUsd,
      houseAccount: 'payments-in',
      paymentId: adjustment.paymentId,
      idempotencyKey: adjustment.keys.house,
    },
  ]);
  if (posted) {
    // Unguarded by design: a negative balance is a legal state (settlement is
    // never balance-guarded — billing doctrine).
    await stores.updateWalletBalanceWithinTx(tx, wallet.id, balanceAfterNanoUsd, ledgerSeq);
  }
  return { wallet, balanceAfterNanoUsd, ledgerSeq, posted };
}
