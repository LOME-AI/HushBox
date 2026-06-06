import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages';
import { BudgetHelper, setWalletBalance } from '../helpers/budget.js';
import {
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import { TIMEOUTS } from '../config/timeouts.js';

// Signup/auth flows share the localhost IP whose rate limits these tests clear; @chromium-only
// gates them to the chromium project (config grepInvert excludes the tag from every other
// project), replacing the former in-body project-name skip in beforeEach.
test.describe('Wallet Lifecycle', { tag: '@chromium-only' }, () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
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
          .locator(`[data-testid="${TEST_IDS.messageCost}"]`)
      ).toBeVisible({ timeout: TIMEOUTS.STREAM });
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
          .locator(`[data-testid="${TEST_IDS.messageCost}"]`)
      ).toBeVisible({ timeout: TIMEOUTS.STREAM });
    });

    await test.step('verify purchased decreased, free tier unchanged', async () => {
      const balance = await budget.getBalance();
      expect(Number.parseFloat(balance.balance)).toBeLessThan(10);
      // Free tier must be untouched — purchased wallet has higher priority (0 < 1)
      expect(balance.freeAllowanceCents).toBe(freeTierAfterFirstMessage);
    });
  });
});
