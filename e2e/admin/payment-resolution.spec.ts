import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { fetchMoneyPanel, walletOf } from './helpers/customer-360.js';
import {
  clickUndo,
  executeAndAwaitResult,
  executeButton,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  opFieldInput,
  previewOpApi,
  readAuditId,
  recordedReason,
  submitOpForm,
} from './helpers/op-modal.js';
import { catalogInverseCell, openOpsCatalog, runOpFromCatalog } from './helpers/ops-catalog.js';
import { mintAwaitingWebhookPayment } from './helpers/targets.js';
import type { AdminAuditRowWire } from '@hushbox/shared';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/** One justification per direction, so the audit trail proves each row kept
 * the words typed into its own form rather than inheriting the other's. */
const EXPIRE_REASON = 'e2e resolve: the provider denies both handles for this capture';
const RESTORE_REASON = 'e2e resolve: the capture surfaced in the provider dashboard after all';
const CREDIT_REASON = 'e2e resolve: capture confirmed by hand, credit the wallet';
const CLAWBACK_REASON = 'e2e resolve: the confirmed capture was a different customer';
const RECREDIT_REASON = 'e2e resolve: re-checked, the capture is this customer after all';

/** The audit row a journey committed, by its id. */
function rowById(rows: readonly AdminAuditRowWire[], id: string): AdminAuditRowWire {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no audit row ${id} on the payment's trail`);
  return row;
}

/**
 * The operator's repair path for a captured-but-uncredited payment, driven
 * through the surface production actually has: the ops catalog, the generic
 * op form, preview, execute, and Undo running the registered inverse. The
 * four payment ops reach that catalog with no UI work of their own, so this
 * is the only proof that a human can reach and drive them at all.
 */
test.describe('Admin payment resolution', SPEC_MATRIX, () => {
  test('force-expire and its undo move the row both ways and move no money', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintAwaitingWebhookPayment(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const before = await fetchMoneyPanel(api, { userId: target.userId });

    // The catalog is where a registered op becomes reachable: the row exists,
    // and it names the inverse that will undo it.
    await openOpsCatalog(adminPage);
    await expect(catalogInverseCell(adminPage, 'payment.forceExpire')).toHaveText(
      'payment.restoreAwaitingWebhook'
    );
    await runOpFromCatalog(adminPage, 'payment.forceExpire');

    await fillOpForm(adminPage, { paymentId: target.paymentId, reason: EXPIRE_REASON });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(
      /^Force-expire stuck payment \(\d+ changes?\)$/
    );
    await executeAndAwaitResult(adminPage);
    const expireAuditId = await readAuditId(adminPage);

    // Undo opens the inverse prefilled with the row it must put back, and a
    // blank reason — the justification for undoing is the operator's own.
    await clickUndo(adminPage);
    await expect(opFieldInput(adminPage, 'paymentId')).toHaveValue(target.paymentId);
    await expect(opFieldInput(adminPage, 'reason')).toHaveValue('');
    await fillOpForm(adminPage, { reason: RESTORE_REASON });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(
      /^Restore payment to awaiting webhook \(\d+ changes?\)$/
    );
    await executeAndAwaitResult(adminPage);
    const restoreAuditId = await readAuditId(adminPage);
    expect(restoreAuditId).not.toBe(expireAuditId);

    // API truth: this pair moves no money at all — the balance stands and the
    // ledger gained no leg in either direction.
    const after = await fetchMoneyPanel(api, { userId: target.userId });
    expect(walletOf(after, 'purchased').balanceNanoUsd).toBe(
      walletOf(before, 'purchased').balanceNanoUsd
    );
    expect(after.recentLedger).toHaveLength(before.recentLedger.length);

    // The trail carries both rows against the payment, doubly linked, each
    // recording the words typed into its own form.
    const trail = await fetchAuditRows(api, { targetId: target.paymentId, limit: 50 });
    const expireRow = rowById(trail, expireAuditId);
    const restoreRow = rowById(trail, restoreAuditId);
    expect(expireRow.action).toBe('payment.forceExpire');
    expect(restoreRow.action).toBe('payment.restoreAwaitingWebhook');
    expect(restoreRow.undoes).toBe(expireAuditId);
    expect(expireRow.undoneBy).toBe(restoreAuditId);
    expect(recordedReason(expireRow)).toBe(EXPIRE_REASON);
    expect(recordedReason(restoreRow)).toBe(RESTORE_REASON);

    // The row really is back where it started: force-expire only runs from
    // `awaiting_webhook`, and a preview is that same run rolled back.
    const reExpire = await previewOpApi(api, 'payment.forceExpire', {
      paymentId: target.paymentId,
      reason: EXPIRE_REASON,
    });
    expect(reExpire.status()).toBe(200);
  });

  test('force-complete credits exactly the row amount and its undo claws back exactly that', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintAwaitingWebhookPayment(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const before = await fetchMoneyPanel(api, { userId: target.userId });
    const openingBalance = BigInt(walletOf(before, 'purchased').balanceNanoUsd);
    // The one sanctioned source for the expected amount: what the running
    // system reported it seeded onto the row. The operator never types it —
    // these ops take a payment id, and the row's own captured total is the
    // whole of what they may move.
    const captured = BigInt(target.amountNanoUsd);

    await openOpsCatalog(adminPage);
    await expect(catalogInverseCell(adminPage, 'payment.forceCompleteAndCredit')).toHaveText(
      'payment.uncompleteAndClawback'
    );
    await runOpFromCatalog(adminPage, 'payment.forceCompleteAndCredit');

    await fillOpForm(adminPage, { paymentId: target.paymentId, reason: CREDIT_REASON });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(
      /^Force-complete payment and credit \(\d+ changes?\)$/
    );
    await executeAndAwaitResult(adminPage);
    const creditAuditId = await readAuditId(adminPage);

    // Exactly the row's captured amount, and exactly one deposit leg for it.
    const afterCredit = await fetchMoneyPanel(api, { userId: target.userId });
    expect(BigInt(walletOf(afterCredit, 'purchased').balanceNanoUsd)).toBe(
      openingBalance + captured
    );
    const deposits = afterCredit.recentLedger.filter((entry) => entry.kind === 'deposit');
    expect(deposits).toHaveLength(1);
    expect(BigInt(deposits[0]!.amountNanoUsd)).toBe(captured);

    await clickUndo(adminPage);
    await expect(opFieldInput(adminPage, 'paymentId')).toHaveValue(target.paymentId);
    await expect(opFieldInput(adminPage, 'reason')).toHaveValue('');
    await fillOpForm(adminPage, { reason: CLAWBACK_REASON });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(
      /^Un-complete payment and claw back \(\d+ changes?\)$/
    );
    await executeAndAwaitResult(adminPage);
    const clawbackAuditId = await readAuditId(adminPage);

    // The undo nets the wallet to exactly its opening balance, through one
    // clawback leg of exactly the same amount — never a rounded-off remainder.
    const afterUndo = await fetchMoneyPanel(api, { userId: target.userId });
    expect(BigInt(walletOf(afterUndo, 'purchased').balanceNanoUsd)).toBe(openingBalance);
    const clawbacks = afterUndo.recentLedger.filter((entry) => entry.kind === 'clawback');
    expect(clawbacks).toHaveLength(1);
    expect(BigInt(clawbacks[0]!.amountNanoUsd)).toBe(-captured);

    const trail = await fetchAuditRows(api, { targetId: target.paymentId, limit: 50 });
    const creditRow = rowById(trail, creditAuditId);
    const clawbackRow = rowById(trail, clawbackAuditId);
    expect(creditRow.action).toBe('payment.forceCompleteAndCredit');
    expect(clawbackRow.action).toBe('payment.uncompleteAndClawback');
    expect(clawbackRow.undoes).toBe(creditAuditId);
    expect(creditRow.undoneBy).toBe(clawbackAuditId);
    expect(recordedReason(creditRow)).toBe(CREDIT_REASON);
    expect(recordedReason(clawbackRow)).toBe(CLAWBACK_REASON);

    // A clawed-back row is left where a later delivery or a second verdict can
    // finish it, and the ledger's own fence decides which: re-posting the
    // IDENTICAL adjustment refuses, while a fresh verdict runs.
    const repost = await previewOpApi(api, 'payment.forceCompleteAndCredit', {
      paymentId: target.paymentId,
      reason: CREDIT_REASON,
    });
    expect(repost.status()).toBe(409);
    const freshVerdict = await previewOpApi(api, 'payment.forceCompleteAndCredit', {
      paymentId: target.paymentId,
      reason: RECREDIT_REASON,
    });
    expect(freshVerdict.status()).toBe(200);
  });
});
