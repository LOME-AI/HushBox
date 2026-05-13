import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';
import { BudgetHelper, setWalletBalance } from '../helpers/budget.js';
import { signUpAndVerify, uniqueEmail, clearAuthRateLimits } from '../helpers/auth.js';

test.describe('Wallet Lifecycle', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test('signup → free tier message → payment → paid tier message', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(120_000);

    const page = unauthenticatedPage;
    const email = uniqueEmail('e2e-wallet');
    const username = `wal${String(Date.now()).slice(-6)}`;
    const password = 'TestPassword123!';

    await test.step('sign up, verify email, and login', async () => {
      await signUpAndVerify(page, request, { username, email, password });
    });

    // page.request shares the browser context's auth cookies
    const budget = new BudgetHelper(page.request);

    await test.step('verify initial balances after signup', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeCloseTo(0.2, 2);
      expect(balance.freeAllowanceCents).toBe(5);
    });

    await test.step('zero out purchased wallet via dev endpoint', async () => {
      await setWalletBalance(request, email, 'purchased', '0.00000000');
    });

    await test.step('verify purchased is zero, free tier intact', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBe(0);
      expect(balance.freeAllowanceCents).toBe(5);
    });

    const chatPage = new ChatPage(page);
    const freeMessage = `Free tier ${String(Date.now())}`;

    await test.step('send message on free tier', async () => {
      await chatPage.goto();
      await chatPage.waitForAppStable();
      await chatPage.selectNonPremiumModel();
      await chatPage.sendNewChatMessage(freeMessage);
      await chatPage.waitForConversation();
      await chatPage.waitForAIResponse(freeMessage);
      // Wait for billing to complete — cost badge appears after saveChatTurn
      await expect(
        chatPage.messageList
          .locator('[data-role="assistant"]')
          .last()
          .locator('[data-testid="message-cost"]')
      ).toBeVisible({ timeout: 15_000 });
    });

    let freeTierAfterFirstMessage = 0;

    await test.step('verify free tier decreased, purchased still zero', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBe(0);
      expect(balance.freeAllowanceCents).toBeLessThan(5);
      freeTierAfterFirstMessage = balance.freeAllowanceCents;
    });

    await test.step('credit purchased wallet via dev endpoint ($10)', async () => {
      await setWalletBalance(request, email, 'purchased', '10.00000000');
    });

    await test.step('verify purchased wallet has $10', async () => {
      // Dev endpoint bypasses TanStack Query cache — reload refreshes billing resolution
      await page.reload();
      await chatPage.waitForConversationLoaded();
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeCloseTo(10, 2);
    });

    const paidMessage = `Paid tier ${String(Date.now())}`;

    await test.step('send follow-up message on paid tier', async () => {
      await chatPage.sendFollowUpMessage(paidMessage);
      await chatPage.waitForAIResponse(paidMessage);
      await expect(
        chatPage.messageList
          .locator('[data-role="assistant"]')
          .last()
          .locator('[data-testid="message-cost"]')
      ).toBeVisible({ timeout: 15_000 });
    });

    await test.step('verify purchased decreased, free tier unchanged', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeLessThan(10);
      // Free tier must be untouched — purchased wallet has higher priority (0 < 1)
      expect(balance.freeAllowanceCents).toBe(freeTierAfterFirstMessage);
    });
  });
});
