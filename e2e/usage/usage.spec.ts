import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { UsagePage } from '../pages';
import { navigateToUsage } from '../helpers/auth.js';
import {
  expectBalanceDelta,
  readMoneyState,
  seedBackdatedUsage,
  seededUsageCharge,
  spendOf,
} from '../helpers/exact-money.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { personaEmail } from '../helpers/personas.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/** Milliseconds in a day, for dating a seeded row relative to the run. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the seeded charge is dated: outside the seven-day preset the
 * filter step narrows to, and inside the floor the page's own all-time range
 * starts at.
 */
const BACKDATED_AGE_DAYS = 30;

/**
 * The seeded charge, as the seed's own input. What the assertion compares is
 * never this string: the route reports what it applied and the expectation is
 * priced from that report, so the seed and the expectation cannot drift.
 */
const BACKDATED_COST_NANO_USD = '2500000000';

/**
 * The model and provider the seeded row is attributed to. Named for what the
 * row is rather than borrowed from the catalog: the page groups spend by the
 * model id, and a live id here would tie the seed to a catalog entry that can
 * retire. The provider name only fills the row's required column.
 */
const BACKDATED_MODEL_ID = 'seeded/backdated-history';
const BACKDATED_PROVIDER_NAME = 'seeded';

/** Token dimensions for the seeded row: the usage read counts only rows that carry one. */
const BACKDATED_TOKENS = { inputTokens: 1000, outputTokens: 1000 };

test.describe('Usage Analytics', SPEC_MATRIX, () => {
  test('usage page renders charts and filters work', async ({
    authenticatedPage,
    authenticatedRequest,
    chargedModels,
  }) => {
    const usagePage = new UsagePage(authenticatedPage);
    // One column per charted model, plus the period column the table leads
    // with. The seed is what puts more than one model there, so the count it
    // establishes is what the narrowing is measured against.
    const seededColumns = chargedModels.modelCount + 1;
    let seededRecords = 0;
    let outsideWindowBefore = 0;

    await test.step('navigate via sidebar menu', async () => {
      await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await navigateToUsage(authenticatedPage);
      await expect(usagePage.usageContent).toBeVisible();
    });

    await test.step('sample the history the seed will add to', async () => {
      // How much the narrowing already removes before this execution seeds
      // anything. Sampled rather than assumed empty: the seed is permanent and
      // the route mints each row's arbitration key itself, so a repeat of this
      // test against a database that has run it before finds every earlier
      // execution's row still dated outside the seven-day window. The
      // assertion below compares how far this figure MOVES, which is this
      // execution's seed whatever history the account already carried.
      await usagePage.selectDateRange('all');
      const allTime = await usagePage.readSummaryMessages();
      await usagePage.selectDateRange('7d');
      outsideWindowBefore = allTime - (await usagePage.readSummaryMessages());
    });

    await test.step('seed charged history dated outside the seven-day window', async () => {
      const ownerEmail = personaEmail('test-alice');
      const created = await idempotentPost(authenticatedRequest, '/dev/conversation', {
        data: { ownerEmail },
      });
      await expectOkResponse(created, 'dev conversation seed');
      const { conversationId } = (await created.json()) as { conversationId: string };

      const records = [
        {
          modelId: BACKDATED_MODEL_ID,
          providerName: BACKDATED_PROVIDER_NAME,
          costNanoUsd: BACKDATED_COST_NANO_USD,
          ...BACKDATED_TOKENS,
          createdAt: new Date(Date.now() - BACKDATED_AGE_DAYS * DAY_MS).toISOString(),
        },
      ];

      const before = await readMoneyState(authenticatedRequest);
      const seeded = await seedBackdatedUsage(
        authenticatedRequest,
        ownerEmail,
        conversationId,
        records
      );
      // The route writes the rows and debits the payer's wallet by the sum it
      // reports, in one transaction — so the wallet movement is what proves the
      // seed landed, where the per-conversation charge read cannot: it joins
      // content rows, which a seeded usage row has none of.
      await expectBalanceDelta(authenticatedRequest, before, {
        purchased: spendOf(seededUsageCharge(seeded)),
      });
      // A seed that reported inserting nothing would leave the difference below
      // expecting no movement, which is the one way it could pass while the
      // filter did nothing. Refused here rather than carried into it.
      expect(seeded.usageRecordsCreated).toBe(records.length);
      seededRecords = seeded.usageRecordsCreated;

      // The page was standing before the seed landed, so every range it has
      // already queried is cached from before it. Reloading is what puts the
      // seeded row inside the figures the steps below read.
      await usagePage.goto();
    });

    await test.step('all charts render with data on All range', async () => {
      await usagePage.selectDateRange('all');
      await usagePage.expectAllChartsVisible();

      await usagePage.expectChartHasData(usagePage.spendingChart);
      // The seeded model is in no catalog, so its row is named by its id.
      await usagePage.expectCostByModelRow(BACKDATED_MODEL_ID);

      // The loaded branch of the summary rendered: the total and the facts
      // line exist only there. What the account actually spent is asserted
      // against the seed's own report above, on the wallet rather than on a
      // figure rounded to the cent for display.
      await expect(usagePage.totalSpent).toBeVisible();
      await expect(usagePage.messagesFact).not.toHaveText(/^0 messages$/);

      // The seed charged a conversation inside the all-time window, so the list
      // ranks at least one.
      await expect(usagePage.topConversationRows.first()).toBeVisible();
    });

    await test.step('date range filters update the summary', async () => {
      await usagePage.selectDateRange('all');
      const allTime = await usagePage.readSummaryMessages();

      await usagePage.selectDateRange('7d');

      // What the narrowing removes now, less what it removed before the seed.
      // A charge minted during the run sits in both windows and cancels inside
      // each difference; a row an earlier execution left behind sits outside
      // the window in both differences and cancels between them. The seed is
      // the only term that survives, so the expectation is the count the route
      // reported creating. A filter that stopped narrowing would hold this at
      // the sampled history negated, which no seed count can equal.
      await expect
        .poll(async () => allTime - (await usagePage.readSummaryMessages()) - outsideWindowBefore, {
          timeout: TIMEOUTS.MODAL,
        })
        .toBe(seededRecords);
    });

    await test.step('model filter narrows data', async () => {
      // Switch back to All time so we have data
      await usagePage.selectDateRange('all');
      await usagePage.expectChartHasData(usagePage.spendingChart);

      // The spending series is the surface the model filter narrows, and its
      // text alternative carries one column per charted model beside the
      // period column. A filter that draws the same picture whatever is
      // selected shows up here as a column set that never narrowed; a Recharts
      // surface being present says only that a chart drew something. The cost
      // breakdown is deliberately left on the whole range — narrowing a
      // per-model breakdown to one model would say nothing.
      const seriesColumns = usagePage.spendingChart.getByRole('columnheader');
      const chartsSeveralModels = async (): Promise<number> => seriesColumns.count();
      await expect
        .poll(chartsSeveralModels, { timeout: TIMEOUTS.ASSERT })
        .toBeGreaterThanOrEqual(seededColumns);

      // The model to filter by is read off the spending series rather than
      // named: the filter offers only models this account actually spent on,
      // and which those are follows from whatever the seeded conversations
      // happened to run. Any id written here is a guess about that, and a
      // wrong guess leaves the dropdown open on an option that never appears.
      // It is read from this chart, whose columns name a model by display
      // name as the filter's options do, so the string selected and the
      // surviving column asserted below are one value read off one surface.
      // The period column leads, so the first model column is next.
      const filteredModel = (await seriesColumns.nth(1).textContent()) ?? '';
      await usagePage.selectModel(filteredModel);

      await expect(seriesColumns).toHaveCount(2);
      await expect(seriesColumns.last()).toHaveText(filteredModel);

      await usagePage.clearModelFilter();
      await expect
        .poll(chartsSeveralModels, { timeout: TIMEOUTS.ASSERT })
        .toBeGreaterThanOrEqual(seededColumns);
    });
  });
});
