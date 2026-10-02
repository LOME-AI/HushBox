import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { test, expect } from './fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { fetchJobRow, openJobsScreen, revealJobRow, selectJobsTab } from './helpers/jobs.js';
import {
  executeAndAwaitResult,
  executeButton,
  executeOpApi,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  opFieldInput,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';
import { mintAdminTargets } from './helpers/targets.js';
import type { APIRequestContext } from './fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/** A freshly minted dead job's id (targets.ts types the field optional). */
async function mintDeadJobId(request: APIRequestContext): Promise<string> {
  const minted = await mintAdminTargets(request, ['deadJob']);
  if (minted.deadJob === undefined) {
    throw new Error('mintAdminTargets returned 201 without a deadJob');
  }
  return minted.deadJob.jobId;
}

/**
 * The dead-jobs inbox: every dead row is redriven (after fixing the cause)
 * or discarded with a reason — both through the OpModal from the queue
 * screen. Row-state changes are asserted via the admin jobs API (rule 1.5).
 */
test.describe('Admin jobs management', SPEC_MATRIX, () => {
  test('a dead job redrives through the queue UI and runs to succeeded', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    // The UI journey plus the dispatcher poll below: the same budget the
    // newsletter dispatch spec takes for a job it drives to a terminal state.
    test.setTimeout(TIMEOUTS.XXLONG);
    const jobId = await mintDeadJobId(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);

    await openJobsScreen(adminPage, 'Dead');
    const row = await revealJobRow(adminPage, jobId);

    // Expansion shows the payload and the per-attempt error history.
    await row.getByTestId(TEST_IDS.adminJobExpand).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminJobDetail)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(adminPage.getByTestId(TEST_IDS.adminJobPayload)).toContainText('storageKeys');
    await expect(adminPage.getByTestId(TEST_IDS.adminJobErrors)).toContainText('seeded dead job');

    // Redrive via the OpModal, jobId prefilled from the row action.
    await row.getByTestId(TEST_IDS.adminJobRedrive).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await expect(opFieldInput(adminPage, 'jobId')).toHaveValue(jobId);
    await fillOpForm(adminPage, { reason: 'e2e redrive of a seeded dead job' });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Redrive dead job \(\d+ changes?\)$/);
    await executeAndAwaitResult(adminPage);

    // System-owned class (a redrive resumes at-least-once work the system
    // already owed): the result step offers no Undo.
    await expect(adminPage.getByTestId(TEST_IDS.adminOpUndo)).toHaveCount(0);

    // API truth: the REAL dispatcher claims the redriven row and runs it. The
    // seeded empty-key payload is the idempotent no-op, so `succeeded` is the
    // only terminal state open to it, while merely leaving the dead inbox is
    // also satisfied by a row that returned to pending and never ran.
    // Wide poll intervals: each poll spends one job-queue read of the acting
    // actor's hourly window (`helpers/jobs.ts` §READ BUDGET).
    await expect
      .poll(
        async () => {
          const row = await fetchJobRow(api, jobId);
          return row.status;
        },
        { timeout: TIMEOUTS.JOB_DISPATCH, intervals: [1000, 2000, 5000] }
      )
      .toBe('succeeded');
    const job = await fetchJobRow(api, jobId);
    expect(job.discarded).toBe(false);
  });

  test('discard shelves a dead job and restore returns it to dead without redriving', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const jobId = await mintDeadJobId(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);

    // Discard from the Dead tab.
    await openJobsScreen(adminPage, 'Dead');
    const deadRow = await revealJobRow(adminPage, jobId);
    await deadRow.getByTestId(TEST_IDS.adminJobDiscard).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await expect(opFieldInput(adminPage, 'jobId')).toHaveValue(jobId);
    await fillOpForm(adminPage, { reason: 'e2e discard of a superseded job' });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Discard dead job \(\d+ changes?\)$/);
    await executeAndAwaitResult(adminPage);
    const discardAuditId = await readAuditId(adminPage);

    // Durable pair: the discard result DOES offer Undo (inverse job.restore).
    await expect(adminPage.getByTestId(TEST_IDS.adminOpUndo)).toBeVisible();
    await adminPage.getByRole('button', { name: 'Done' }).click();

    // API truth: still dead, now carrying the restorable discard marker.
    const afterDiscard = await fetchJobRow(api, jobId);
    expect(afterDiscard.status).toBe('dead');
    expect(afterDiscard.discarded).toBe(true);

    // The row moved to the Discarded shelf; restore it from there.
    await selectJobsTab(adminPage, 'Discarded');
    const discardedRow = await revealJobRow(adminPage, jobId);
    await discardedRow.getByTestId(TEST_IDS.adminJobRestore).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await expect(opFieldInput(adminPage, 'jobId')).toHaveValue(jobId);
    await fillOpForm(adminPage, { reason: 'e2e restore back to the dead inbox' });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Restore discarded job \(\d+ changes?\)$/);
    await executeAndAwaitResult(adminPage);
    await adminPage.getByRole('button', { name: 'Done' }).click();

    // Restore never redrives: back to the dead inbox, not pending.
    const afterRestore = await fetchJobRow(api, jobId);
    expect(afterRestore.status).toBe('dead');
    expect(afterRestore.discarded).toBe(false);

    // Everything on the permanent record against the job, and nothing else:
    // both dispositions, plus the read row each one's preview left — this
    // journey drove the modal twice, and the modal previews before it executes.
    const trail = await fetchAuditRows(api, { targetId: jobId, limit: 20 });
    const actions = trail.map((auditRow) => auditRow.action).toSorted((a, b) => a.localeCompare(b));
    expect(actions).toEqual(['job.discard', 'job.restore', 'read.opPreview', 'read.opPreview']);
    expect(trail.some((auditRow) => auditRow.id === discardAuditId)).toBe(true);
  });

  test('restore refuses a never-discarded dead job and redrive refuses a discarded one', async ({
    adminApi,
    request,
  }) => {
    const minted = await mintAdminTargets(request, ['deadJob', 'discardedJob']);
    if (minted.deadJob === undefined || minted.discardedJob === undefined) {
      throw new Error('mintAdminTargets returned 201 without the requested jobs');
    }
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);

    // job.restore needs the discard marker; a plain dead row conflicts.
    const restore = await executeOpApi(
      api,
      'job.restore',
      { jobId: minted.deadJob.jobId, reason: 'e2e restore misfire' },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(restore.status()).toBe(409);
    const deadJob = await fetchJobRow(api, minted.deadJob.jobId);
    expect(deadJob.status).toBe('dead');
    expect(deadJob.discarded).toBe(false);

    // job.redrive refuses a discarded row: restore it to the inbox first.
    const redrive = await executeOpApi(
      api,
      'job.redrive',
      { jobId: minted.discardedJob.jobId, reason: 'e2e redrive misfire' },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(redrive.status()).toBe(409);
    const discardedJob = await fetchJobRow(api, minted.discardedJob.jobId);
    expect(discardedJob.status).toBe('dead');
    expect(discardedJob.discarded).toBe(true);
  });
});
