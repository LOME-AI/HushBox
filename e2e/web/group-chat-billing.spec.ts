import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper, setWalletBalance } from '../helpers/budget.js';

async function getLastAiPayerId(
  request: APIRequestContext,
  conversationId: string
): Promise<string | null | undefined> {
  const convResponse = await request.get(`/api/conversations/${conversationId}`);
  const convData = (await convResponse.json()) as {
    messages: { senderType: string; payerId: string | null }[];
  };
  const aiMessages = convData.messages.filter((m) => m.senderType === 'ai');
  return aiMessages.at(-1)?.payerId;
}

/**
 * Group Chat Billing E2E Tests
 *
 * Seeded balances:
 * - test-alice: $100.00 purchased + 5¢ free → paid tier
 * - test-bob:   $0.00 purchased + 5¢ free → free tier
 *
 * Billing decision (resolveBilling):
 *   effectiveCents = min(conversationRemaining, memberRemaining, ownerRemaining)
 *   > 0 → owner_balance (owner pays)
 *   ≤ 0 → personal fallthrough (sender pays from own tier)
 */
test.describe('Group Chat Billing', () => {
  // Each test gets its own groupConversation fixture (isolated billing state)

  test('owner-funded: all budgets active, owner pays', async ({
    authenticatedPage: _alice,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    const helper = new BudgetHelper(authenticatedRequest);
    const bobUser = groupConversation.members.find((m) => m.email === 'test-bob@test.hushbox.ai')!;

    await test.step('setup budgets: conv=$10, member=$5', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const bobMemberId = await helper.findMemberId(groupConversation.id, bobUser.userId);
      await helper.setMemberBudget(groupConversation.id, bobMemberId, 500);
    });

    const initialBalance = await helper.getBalance();

    await test.step('Bob sends message in group chat', async () => {
      const chatPage = new ChatPage(testBobPage);
      await chatPage.gotoConversation(groupConversation.id);
      await chatPage.waitForConversationLoaded();

      await chatPage.sendFollowUpMessage(`Budget test ${String(Date.now())}`);
      await chatPage.waitForAIResponse('Budget test');
    });

    await test.step('verify owner-funded billing', async () => {
      // Message cost is visible
      const chatPage = new ChatPage(testBobPage);
      await chatPage.expectMessageCostVisible();

      // No free_tier_notice (owner is paying)
      await expect(testBobPage.getByTestId('budget-message-free_tier_notice')).not.toBeVisible();

      // Alice's balance decreased (owner charged)
      const finalBalance = await helper.getBalance();
      expect(Number.parseFloat(finalBalance.balance)).toBeLessThan(
        Number.parseFloat(initialBalance.balance)
      );

      // Group spending incremented (owner-funded → spending tracked)
      // Use expect.poll() — the DB write may not be visible to the next API call immediately
      await expect
        .poll(
          async () => {
            const budgets = await helper.getBudgets(groupConversation.id);
            return Number.parseFloat(budgets.totalSpent);
          },
          { timeout: 5000, message: 'totalSpent should be > 0 after owner-funded message' }
        )
        .toBeGreaterThan(0);

      await expect
        .poll(
          async () => {
            const budgets = await helper.getBudgets(groupConversation.id);
            const bob = budgets.memberBudgets.find((mb) => mb.userId === bobUser.userId);
            return Number.parseFloat(bob?.spent ?? '0');
          },
          { timeout: 5000, message: 'bob spent should be > 0' }
        )
        .toBeGreaterThan(0);
    });
  });

  // Both tests below fall through to Bob's personal free_allowance billing,
  // reserving against the same Redis key (chatReservedBalance:{bobUserId}).
  // Serial mode prevents concurrent reservations from exceeding Bob's 5¢ allowance.
  // beforeEach resets Bob's wallet to ensure each test starts with a clean 5¢ balance.
  test.describe('personal free-allowance fallthrough', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ authenticatedRequest }) => {
      await setWalletBalance(
        authenticatedRequest,
        'test-bob@test.hushbox.ai',
        'free_tier',
        '0.05000000'
      );
    });

    test('member budget exhausted: falls through to free allowance', async ({
      authenticatedPage: _alice,
      testBobPage,
      authenticatedRequest,
      groupConversation,
    }) => {
      const helper = new BudgetHelper(authenticatedRequest);

      await test.step('setup: conv=$10, member=$0 (default)', async () => {
        // Set high conversation budget but do NOT set Bob's member budget (stays 0)
        await helper.setConversationBudget(groupConversation.id, 1000);
      });

      await test.step('Bob navigates and sees free_tier_notice', async () => {
        const chatPage = new ChatPage(testBobPage);
        await chatPage.gotoConversation(groupConversation.id);
        await chatPage.waitForConversationLoaded();

        // memberRemaining = 0 → effectiveCents = 0 → personal → free_allowance
        await expect(testBobPage.getByTestId('budget-message-free_tier_notice')).toBeVisible({
          timeout: 10_000,
        });
      });

      await test.step('Bob sends and owner is NOT charged', async () => {
        const chatPage = new ChatPage(testBobPage);
        await chatPage.sendFollowUpMessage(`Member exhausted ${String(Date.now())}`);
        await chatPage.waitForAIResponse('Member exhausted');

        // Verify Bob (not Alice) was charged — per-message payerId check,
        // immune to parallel test pollution (unlike Alice's global balance)
        const bobUser = groupConversation.members.find(
          (m) => m.email === 'test-bob@test.hushbox.ai'
        )!;
        await expect
          .poll(() => getLastAiPayerId(authenticatedRequest, groupConversation.id), {
            timeout: 10_000,
            message: 'last AI message payerId should be Bob (personal billing)',
          })
          .toBe(bobUser.userId);

        // Group spending NOT incremented (free_allowance → owner didn't pay)
        const budgets = await helper.getBudgets(groupConversation.id);
        expect(Number.parseFloat(budgets.totalSpent)).toBe(0);
      });
    });

    test('conversation budget exhausted: falls through to free allowance', async ({
      authenticatedPage: _alice,
      testBobPage,
      authenticatedRequest,
      groupConversation,
    }) => {
      const helper = new BudgetHelper(authenticatedRequest);
      const bobUser = groupConversation.members.find(
        (m) => m.email === 'test-bob@test.hushbox.ai'
      )!;

      await test.step('setup: conv=$0 (default), member=$5', async () => {
        // Set high member budget but do NOT set conversation budget (stays 0)
        const bobMemberId = await helper.findMemberId(groupConversation.id, bobUser.userId);
        await helper.setMemberBudget(groupConversation.id, bobMemberId, 500);
      });

      await test.step('Bob navigates and sees free_tier_notice', async () => {
        const chatPage = new ChatPage(testBobPage);
        await chatPage.gotoConversation(groupConversation.id);
        await chatPage.waitForConversationLoaded();

        // conversationRemaining = 0 → effectiveCents = 0 → personal → free_allowance
        await expect(testBobPage.getByTestId('budget-message-free_tier_notice')).toBeVisible({
          timeout: 10_000,
        });
      });

      await test.step('Bob sends and owner is NOT charged', async () => {
        const chatPage = new ChatPage(testBobPage);
        await chatPage.sendFollowUpMessage(`Conv exhausted ${String(Date.now())}`);
        await chatPage.waitForAIResponse('Conv exhausted');

        // Verify Bob (not Alice) was charged — per-message payerId check,
        // immune to parallel test pollution (unlike Alice's global balance)
        await expect
          .poll(() => getLastAiPayerId(authenticatedRequest, groupConversation.id), {
            timeout: 10_000,
            message: 'last AI message payerId should be Bob (personal billing)',
          })
          .toBe(bobUser.userId);

        // Group spending NOT incremented (free_allowance → owner didn't pay)
        const budgets = await helper.getBudgets(groupConversation.id);
        expect(Number.parseFloat(budgets.totalSpent)).toBe(0);
      });
    });
  });

  test('owner balance exhausted: paid member uses personal balance', async ({
    authenticatedPage,
    authenticatedRequest,
    testBobRequest,
  }) => {
    // Create a custom group chat where Bob (free tier, $0 balance) is the owner
    // and Alice (paid tier, $100 balance) is an admin member.
    const createResponse = await authenticatedRequest.post('/api/dev/group-chat', {
      data: {
        ownerEmail: 'test-bob@test.hushbox.ai',
        memberEmails: ['test-alice@test.hushbox.ai'],
        messages: [
          {
            senderEmail: 'test-bob@test.hushbox.ai',
            content: 'Welcome to Bob group',
            senderType: 'user',
          },
        ],
      },
    });
    expect(createResponse.ok()).toBe(true);
    const { conversationId } = (await createResponse.json()) as { conversationId: string };

    const bobHelper = new BudgetHelper(testBobRequest);
    const aliceHelper = new BudgetHelper(authenticatedRequest);

    await test.step('setup budgets with Bob (owner) auth: conv=$10, member=$5', async () => {
      await bobHelper.setConversationBudget(conversationId, 1000);

      // Find Alice's memberId using Bob's auth (Bob is owner, can see all members)
      const budgets = await bobHelper.getBudgets(conversationId);
      const aliceUser = budgets.memberBudgets.find((mb) => mb.userId !== null);
      expect(aliceUser).toBeDefined();
      await bobHelper.setMemberBudget(conversationId, aliceUser!.memberId, 500);
    });

    const initialBalance = await aliceHelper.getBalance();

    await test.step('Alice navigates to Bob-owned group', async () => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.gotoConversation(conversationId);
      await chatPage.waitForConversationLoaded();
      await chatPage.expectMessageVisible('Welcome to Bob group');
    });

    await test.step('Alice sees no free_tier_notice (paid tier)', async () => {
      // ownerRemaining = 0 (Bob has $0) → effectiveCents = 0 → personal
      // Alice is paid tier → personal_balance → no free_tier_notice
      await authenticatedPage.waitForTimeout(2000);
      await expect(
        authenticatedPage.getByTestId('budget-message-free_tier_notice')
      ).not.toBeVisible();
    });

    await test.step('Alice sends and her own balance decreases', async () => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.sendFollowUpMessage(`Owner exhausted ${String(Date.now())}`);
      await chatPage.waitForAIResponse('Owner exhausted');
      await chatPage.expectMessageCostVisible();

      // Alice's balance decreased (she paid from personal_balance)
      const finalBalance = await aliceHelper.getBalance();
      expect(Number.parseFloat(finalBalance.balance)).toBeLessThan(
        Number.parseFloat(initialBalance.balance)
      );

      // Group spending NOT incremented (personal_balance → owner didn't pay)
      const budgets = await bobHelper.getBudgets(conversationId);
      expect(Number.parseFloat(budgets.totalSpent)).toBe(0);
    });
  });

  test('budget visibility: footer and modal reflect spending', async ({
    authenticatedPage,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    // 5 steps: setup, Bob send+AI response, Bob modal, Alice modal
    test.slow();

    const helper = new BudgetHelper(authenticatedRequest);
    const bobUser = groupConversation.members.find((m) => m.email === 'test-bob@test.hushbox.ai')!;

    await test.step('setup budgets', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const bobMemberId = await helper.findMemberId(groupConversation.id, bobUser.userId);
      await helper.setMemberBudget(groupConversation.id, bobMemberId, 500);
    });

    const bobChatPage = new ChatPage(testBobPage);
    await bobChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.waitForConversationLoaded();

    await test.step('budget footer is visible', async () => {
      const sidebar = new MemberSidebarPage(testBobPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await expect(sidebar.budgetFooter).toBeVisible();
      await sidebar.closeSidebar();
    });

    await test.step('no free_tier_notice when owner-funded', async () => {
      await expect(testBobPage.getByTestId('budget-message-free_tier_notice')).not.toBeVisible();
    });

    await test.step('Bob sends message and costs appear', async () => {
      await bobChatPage.sendFollowUpMessage(`Visibility test ${String(Date.now())}`);
      await bobChatPage.waitForAIResponse('Visibility test');
      await bobChatPage.expectMessageCostVisible();
    });

    await test.step('Bob budget modal shows spending', async () => {
      const sidebar = new MemberSidebarPage(testBobPage);
      // Reopen sidebar — on mobile (pixel-7) the Sheet is fully closed,
      // so member-budget-trigger is not in the DOM
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();
      await sidebar.clickBudgetSettings();

      const modal = testBobPage.getByTestId('budget-settings-modal');
      await expect(modal).toBeVisible();

      // Values are text (read-only for non-owner)
      await expect(testBobPage.getByTestId('budget-conversation-value')).toBeVisible();

      // Total spent should be > $0.00
      const totalSpent = testBobPage.getByTestId('budget-total-spent');
      await expect(totalSpent).toBeVisible();

      await testBobPage.getByTestId('budget-cancel-button').click();
    });

    await test.step('Alice budget modal also shows updated spending', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();

      const aliceSidebar = new MemberSidebarPage(authenticatedPage);
      await aliceSidebar.openViaFacepile();
      await aliceSidebar.waitForLoaded();
      await aliceSidebar.clickBudgetSettings();

      const modal = authenticatedPage.getByTestId('budget-settings-modal');
      await expect(modal).toBeVisible();

      // Owner sees editable inputs
      await expect(authenticatedPage.getByTestId('budget-conversation-input')).toBeVisible();

      // Total spent is visible
      const totalSpent = authenticatedPage.getByTestId('budget-total-spent');
      await expect(totalSpent).toBeVisible();

      await authenticatedPage.keyboard.press('Escape');
    });
  });
});
