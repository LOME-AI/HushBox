import { describe, expect, it } from 'vitest';
import { hashCanonicalJson, uuidFromHex } from '../../../../lib/idempotency/index.js';
import { deriveAdjustmentKeys } from './money-adjustment.js';
import type { AdminAdjustmentIdentity } from './money-adjustment.js';

// An opaque subject id: the derivation hashes it, and nothing here parses it.
const SUBJECT_ID = 'the-wallet-under-adjustment';

const FORWARD: AdminAdjustmentIdentity = {
  opName: 'wallet.credit',
  subject: { walletId: SUBJECT_ID },
  amountNanoUsd: '5000000000',
  reason: 'goodwill for a failed generation',
  undoes: undefined,
};

describe('deriveAdjustmentKeys', () => {
  it('keys both legs under the op name and the adjustment identity', async () => {
    const digest = await hashCanonicalJson({
      op: FORWARD.opName,
      walletId: SUBJECT_ID,
      amountNanoUsd: FORWARD.amountNanoUsd,
      reason: FORWARD.reason,
    });

    const keys = await deriveAdjustmentKeys(FORWARD);

    expect(keys).toEqual({
      transactionId: uuidFromHex(digest),
      wallet: `admin:${FORWARD.opName}:${digest}:wallet`,
      house: `admin:${FORWARD.opName}:${digest}:house`,
    });
  });

  it('separates an undo from the forward adjustment it reverses', async () => {
    const forward = await deriveAdjustmentKeys(FORWARD);

    const undo = await deriveAdjustmentKeys({ ...FORWARD, undoes: 'the audit row' });

    expect(undo.wallet).not.toBe(forward.wallet);
    expect(undo.house).not.toBe(forward.house);
    expect(undo.transactionId).not.toBe(forward.transactionId);
  });

  it('separates two subjects that differ only in what the adjustment is against', async () => {
    const walletKeys = await deriveAdjustmentKeys(FORWARD);

    const paymentKeys = await deriveAdjustmentKeys({
      ...FORWARD,
      subject: { paymentId: SUBJECT_ID },
    });

    expect(paymentKeys.wallet).not.toBe(walletKeys.wallet);
  });
});
