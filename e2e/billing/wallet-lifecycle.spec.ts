import { TEST_IDS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { BillingPage, ChatPage, SidebarPage } from '../pages';
import { BudgetHelper } from '../helpers/budget.js';
import {
  expectBalanceDelta,
  expectExactBalance,
  grantedDailyFreeAllowance,
  grantedWelcomeCredit,
  mockTextTurnCharge,
  readMockChargeBasis,
  readMoneyState,
  seedWalletBalance,
  seededWalletBalance,
  spendOf,
} from '../helpers/exact-money.js';
import { fetchAcquisitionSource } from '../helpers/acquisition-source.js';
import { pinTextTurnShape } from '../helpers/text-turn-shape.js';
import {
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'Signup/auth flows share the one localhost IP whose rate limits these tests clear, so a second project running them concurrently would consume the allowance under test. Wallet arithmetic is engine-independent.',
});

test.describe('Wallet Lifecycle', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request, []);
  });

  test('signup → free tier message → payment → paid tier message', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(TIMEOUTS.XLONG);

    const page = unauthenticatedPage;
    const email = uniqueEmail('e2e-wallet');
    const username = uniqueUsername('wal');
    const password = 'TestPassword123!';

    await test.step('sign up, verify email, and login', async () => {
      await signUpAndVerify(page, request, { username, email, password });
    });

    // page.request shares the browser context's auth cookies
    const budget = new BudgetHelper(page.request);

    await test.step('verify initial balances after signup', async () => {
      // The welcome credit is read back from the constant that mints it, so the
      // spec cannot drift from the grant registration issues. The second figure
      // is not a grant at all: it is the day's allowance CAP less what has been
      // spent today, and it equals its constant here only because a fresh
      // account has spent nothing yet.
      await expectExactBalance(page.request, {
        purchased: grantedWelcomeCredit(),
        allowanceRemaining: grantedDailyFreeAllowance(),
      });
    });

    const zeroed = await test.step('zero out purchased wallet via dev endpoint', async () => {
      return seedWalletBalance(request, email, 'purchased', '0.00000000');
    });

    await test.step('verify purchased is zero, free tier intact', async () => {
      // Priced from what the seed route reported applying, so the expectation
      // and the setup cannot become two spellings of one number. The allowance
      // line is again the day's cap with nothing spent yet, not a wallet.
      await expectExactBalance(page.request, {
        purchased: seededWalletBalance(zeroed),
        allowanceRemaining: grantedDailyFreeAllowance(),
      });
    });

    const chatPage = new ChatPage(page);
    const freeMessage = `Free tier ${String(Date.now())}`;
    const basis = await readMockChargeBasis(page.request);
    const beforeFreeTurn = await readMoneyState(page.request);

    await test.step('send message on free tier', async () => {
      await chatPage.goto();
      await chatPage.waitForAppStable();
      // Pins the model this spec already pinned, and the off rung it did not:
      // an effort wire would stream reasoning text into the persisted content
      // and grow the storage term the derivations below price.
      await pinTextTurnShape(chatPage);
      await chatPage.sendNewChatMessage(freeMessage);
      await chatPage.waitForConversation();
      await chatPage.waitForAIResponse(freeMessage);
      // Wait for billing to complete — cost badge appears after saveChatTurn
      await expect(
        chatPage.messagesByRole('assistant').last().getByTestId(TEST_IDS.messageCost)
      ).toBeVisible({ timeout: TIMEOUTS.STREAM });
    });

    let freeTierAfterFirstMessage = 0;

    await test.step('verify free tier decreased, purchased still zero', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBe(0);
      // What the day's allowance lost, to the nano. "Below 5¢" would hold for
      // any charge at all, including one for a turn nobody sent.
      await expectBalanceDelta(page.request, beforeFreeTurn, {
        allowanceRemaining: spendOf(mockTextTurnCharge(basis, { prompt: freeMessage, answers: 1 })),
      });
      freeTierAfterFirstMessage = balance.freeAllowanceCents;
    });

    const credited = await test.step('credit purchased wallet via dev endpoint ($10)', async () => {
      return seedWalletBalance(request, email, 'purchased', '10.00000000');
    });

    await test.step('verify purchased wallet carries the credit', async () => {
      // Dev endpoint bypasses TanStack Query cache — reload refreshes billing resolution
      await page.reload();
      await chatPage.waitForConversationLoaded();
      await expectExactBalance(page.request, { purchased: seededWalletBalance(credited) });
    });

    const beforePaidTurn = await readMoneyState(page.request);
    const paidMessage = `Paid tier ${String(Date.now())}`;

    await test.step('send follow-up message on paid tier', async () => {
      // Re-pinned after the reload rather than assumed to have survived it.
      await pinTextTurnShape(chatPage);
      await chatPage.sendFollowUpMessage(paidMessage);
      await chatPage.waitForAIResponse(paidMessage);
      await expect(
        chatPage.messagesByRole('assistant').last().getByTestId(TEST_IDS.messageCost)
      ).toBeVisible({ timeout: TIMEOUTS.STREAM });
    });

    await test.step('verify purchased decreased, free tier unchanged', async () => {
      // The credited wallet lost exactly the paid turn — not merely "less than
      // what was credited", which a double charge also satisfies.
      await expectBalanceDelta(page.request, beforePaidTurn, {
        purchased: spendOf(mockTextTurnCharge(basis, { prompt: paidMessage, answers: 1 })),
      });
      // Free tier must be untouched — purchased wallet has higher priority (0 < 1)
      const balance = await budget.getBalance();
      expect(balance.freeAllowanceCents).toBe(freeTierAfterFirstMessage);
    });
  });

  /**
   * The channel question's whole life: asked after signup, put away by a skip
   * that is recorded on the account rather than the device, asked again once
   * money has actually moved, and retired for good by the answer.
   *
   * A test of its own rather than steps inside the money test above: that one
   * is a wallet-arithmetic test on a fixed time budget, and a prompt is not
   * part of its subject.
   *
   * `@local-only` because the only payment a test can complete without a card
   * is the simulate button, which renders under `isLocalDev` and is hidden in
   * CI. The wallet seed the money test uses credits a wallet without writing a
   * payment, and a credited wallet is not a payment — the prompt asks for a
   * completed `payments` row, which is the whole point of asking at first
   * payment rather than at first balance.
   */
  test(
    'the channel question is asked after signup, again at first payment, and then never',
    { tag: '@local-only' },
    async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);

      const page = unauthenticatedPage;
      const email = uniqueEmail('e2e-wallet-prompt');
      const username = uniqueUsername('wpr');
      const password = 'TestPassword123!';

      // Answering the platform's notification question makes the notifications
      // offer ineligible, so the sidebar slot's one visible prompt is
      // deterministically the channel question.
      await page.context().grantPermissions(['notifications']);
      await signUpAndVerify(page, request, { username, email, password });

      // The row registration stamped, before the question has been put either
      // way. Every assertion below reads this same row back, because the
      // prompt's own comings and goings prove only what the server said was
      // due, never what it stored.
      expect(await fetchAcquisitionSource(request, email)).toEqual({
        campaign: 'direct',
        platform: 'web',
        selfReportedChannel: null,
        selfReportedContext: null,
        selfReportSkipped: null,
      });

      // A fresh desktop context lands with the sidebar open, but a phone lands
      // with the drawer shut and a remembered collapse lands on the rail, whose
      // slot carries a stand-in rather than the card; the body has to be on
      // screen before anything living in it can be read.
      const sidebar = new SidebarPage(page);
      const question = page.getByRole('heading', { name: 'Where did you hear about HushBox?' });
      const thanks = page.getByRole('heading', {
        name: 'Thanks for topping up. Where did you first hear about us?',
      });

      await test.step('skipping it after signup puts it away for this account', async () => {
        await sidebar.ensureSidebarExpanded();
        await expect(question).toBeVisible({ timeout: TIMEOUTS.ROUTE });
        await page.getByRole('button', { name: 'Skip' }).click();
        await expect(question).toBeHidden();

        // The skip lives on the account, not the device, so a reload must not
        // bring it back.
        await page.reload();
        await sidebar.ensureSidebarExpanded();
        await expect(question).toBeHidden({ timeout: TIMEOUTS.ROUTE });

        // Which context was skipped is what the row records — not merely that
        // something was — and no channel was answered by putting it away.
        expect(await fetchAcquisitionSource(request, email)).toEqual({
          campaign: 'direct',
          platform: 'web',
          selfReportedChannel: null,
          selfReportedContext: null,
          selfReportSkipped: 'post_signup',
        });
      });

      await test.step('complete a payment', async () => {
        const billingPage = new BillingPage(page);
        await billingPage.goto();
        await billingPage.simulateSuccessfulPayment('25');
        await billingPage.closeSuccessAndReset();
      });

      await test.step('it returns with its own headline', async () => {
        await page.goto('/chat');
        await sidebar.ensureSidebarExpanded();
        await expect(thanks).toBeVisible({ timeout: TIMEOUTS.ROUTE });

        // A completed payment is what made the question due again; it wrote
        // nothing to this row, and the earlier skip still stands.
        expect(await fetchAcquisitionSource(request, email)).toEqual({
          campaign: 'direct',
          platform: 'web',
          selfReportedChannel: null,
          selfReportedContext: null,
          selfReportSkipped: 'post_signup',
        });
      });

      await test.step('answering it retires the question for good', async () => {
        await page.getByRole('button', { name: 'Friend or colleague' }).click();
        await page.getByRole('button', { name: 'Done' }).click();
        await expect(thanks).toBeHidden();

        await page.reload();
        await sidebar.ensureSidebarExpanded();
        await expect(thanks).toBeHidden({ timeout: TIMEOUTS.ROUTE });
        await expect(question).toBeHidden();

        // The design's whole point in one row: the answer is stored with the
        // context it was given in, and it did not erase the record of the
        // earlier skip, which stands beside it.
        expect(await fetchAcquisitionSource(request, email)).toEqual({
          campaign: 'direct',
          platform: 'web',
          selfReportedChannel: 'friend',
          selfReportedContext: 'first_payment',
          selfReportSkipped: 'post_signup',
        });
      });
    }
  );
});
