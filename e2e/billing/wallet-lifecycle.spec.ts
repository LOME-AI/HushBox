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

    // Step 1: Sign up, verify email, and login
    await test.step('sign up, verify email, and login', async () => {
      await signUpAndVerify(page, request, { username, email, password });
    });

    // page.request shares the browser context's auth cookies
    const budget = new BudgetHelper(page.request);

    // Step 2: Verify wallets were provisioned at signup with correct balances
    await test.step('verify initial balances after signup', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeCloseTo(0.2, 2);
      expect(balance.freeAllowanceCents).toBe(5);
    });

    // Step 3: Zero out purchased wallet to force free-tier billing
    await test.step('zero out purchased wallet via dev endpoint', async () => {
      await setWalletBalance(request, email, 'purchased', '0.00000000');
    });

    // Step 4: Confirm purchased is empty, free tier intact
    await test.step('verify purchased is zero, free tier intact', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBe(0);
      expect(balance.freeAllowanceCents).toBe(5);
    });

    // Step 5: Send message on free tier (must use non-premium model)
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

    // Step 6: Verify free tier was charged, purchased still empty
    let freeTierAfterFirstMessage = 0;

    await test.step('verify free tier decreased, purchased still zero', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBe(0);
      expect(balance.freeAllowanceCents).toBeLessThan(5);
      freeTierAfterFirstMessage = balance.freeAllowanceCents;
    });

    // Step 7: Simulate payment by crediting purchased wallet
    await test.step('credit purchased wallet via dev endpoint ($10)', async () => {
      await setWalletBalance(request, email, 'purchased', '10.00000000');
    });

    // Step 8: Reload to refresh frontend balance cache, then verify
    await test.step('verify purchased wallet has $10', async () => {
      // Dev endpoint bypasses TanStack Query cache — reload refreshes billing resolution
      await page.reload();
      await chatPage.waitForConversationLoaded();
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeCloseTo(10, 2);
    });

    // Step 9: Send follow-up on paid tier (purchased wallet charged first by priority)
    const paidMessage = `Paid tier ${String(Date.now())}`;

    await test.step('send follow-up message on paid tier', async () => {
      await chatPage.sendFollowUpMessage(paidMessage);
      await chatPage.waitForAIResponse(paidMessage);
      // Wait for billing to complete
      await expect(
        chatPage.messageList
          .locator('[data-role="assistant"]')
          .last()
          .locator('[data-testid="message-cost"]')
      ).toBeVisible({ timeout: 15_000 });
    });

    // Step 10: Verify purchased decreased, free tier unchanged
    await test.step('verify purchased decreased, free tier unchanged', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeLessThan(10);
      // Free tier must be untouched — purchased wallet has higher priority (0 < 1)
      expect(balance.freeAllowanceCents).toBe(freeTierAfterFirstMessage);
    });
  });
});
