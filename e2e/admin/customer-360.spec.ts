import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { c360Panel, openCustomer360, searchCustomer360 } from './helpers/customer-360.js';
import { grantedDailyFreeAllowance, grantedWelcomeCredit } from '../helpers/exact-money.js';
import { fetchAuditRows } from './helpers/op-modal.js';
import { mintLockedUser } from './helpers/targets.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/** Anything push-token-shaped: a long unbroken credential-ish run. The
 * devices panel renders platform tallies and counts only — no value this
 * shape may ever appear in it. */
const TOKEN_LIKE = /[\w+/=-]{30,}/;

/**
 * The Customer-360 screen through its four states — empty, invalid, miss,
 * hit — then the wire truth that the view itself was an audited read.
 *
 * READ BUDGET: the SPA actor spends 2 customer-360 reads of 120/hr (the
 * miss and the hit; the empty and invalid states never fire a request — the
 * query is disabled for non-lookup terms). The second dev actor spends 1
 * audit read of 240/hr.
 */
test.describe('Admin Customer 360', SPEC_MATRIX, () => {
  test('empty → invalid → miss → hit render their states, and the view is read-audited', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);

    // Empty: no query at all.
    await adminPage.goto('/customer-360');
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Empty)).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });

    // Invalid: neither an email nor a uuid — the screen teaches instead of
    // fetching (no read spent, no 4xx provoked).
    await searchCustomer360(adminPage, 'not-a-user-lookup');
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Invalid)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });

    // Miss: a valid but nonexistent email — a deliberate 404.
    expectApiErrors(adminPage, [/404 .*GET .*\/admin\/users\/overview/]);
    expectConsoleErrors(adminPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
    const missEmail = `miss-${crypto.randomUUID()}@hushbox.test`;
    await searchCustomer360(adminPage, missEmail);
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Miss)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Miss)).toContainText(missEmail);

    // Hit: header + panels render for the minted user.
    await openCustomer360(adminPage, target.email);
    // The panel locator resolves to exactly one panel before anything is read
    // inside it, so a locator that stops matching fails here under its own name.
    await expect(c360Panel(adminPage, 'Money')).toHaveCount(1);
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Header)).toContainText(target.email);

    // Money panel. Registration settles both wallets (`wallet_type` enum:
    // purchased + free), and the two derivable figures below come from
    // different places: the purchased wallet holds the welcome credit, while
    // the free wallet is created at ZERO — so the second amount matched here is
    // the day's allowance LIMIT, from the allowance tile, and not a wallet
    // balance at all. The panel titles every amount with its raw nano-USD wire
    // value, so both read what was served rather than a rounded rendering of
    // it — and this is the operator's own view of a customer's money, where a
    // number that is merely present is not evidence it is the right one.
    const money = c360Panel(adminPage, 'Money');
    await expect(money.getByText('purchased', { exact: true })).toBeVisible();
    await expect(money.getByText('free', { exact: true })).toBeVisible();
    // `.first()`: the purchased figure appears twice, in the summary tile and
    // in the wallet row beneath it.
    await expect(
      money.getByTitle(`${String(grantedWelcomeCredit())} nano-USD`).first()
    ).toBeVisible();
    await expect(
      money.getByTitle(`${String(grantedDailyFreeAllowance())} nano-USD`).first()
    ).toBeVisible();

    // Devices panel: renders (tallies or the no-devices message) and never
    // anything token-shaped — the wire carries platform-per-token only.
    const devices = c360Panel(adminPage, 'Devices');
    await expect(devices).toBeVisible();
    await expect(devices).not.toContainText(TOKEN_LIKE);

    // Wire truth via the second actor: the SPA's own view above was itself
    // an audited read targeting this user.
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const reads = await fetchAuditRows(api, {
      action: 'read.customer360',
      targetId: target.userId,
    });
    const spaRead = reads.find((row) => row.actor === DEV_ADMIN_ACTORS[0]);
    expect(spaRead).toBeDefined();
    expect(spaRead?.targetType).toBe('user');
  });
});
