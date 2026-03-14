import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';
import { createWriteLinkWithBudget } from '../helpers/invite-link.js';
import { expectSharedConversationLoaded } from '../helpers/link-assertions.js';

test.describe('Link Guest Chat', () => {
  test('write-privileged guest can send messages and get AI responses', async ({
    authenticatedPage,
    unauthenticatedPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    const helper = new BudgetHelper(authenticatedRequest);

    let inviteUrl: string;

    await test.step('create write-privileged invite link and setup budgets', async () => {
      await chatPage.gotoConversation(groupConversation.id);
      await chatPage.waitForConversationLoaded();

      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(
        authenticatedPage,
        sidebar,
        helper,
        groupConversation.id,
        { withHistory: true, closeMethod: 'escape' }
      );
      inviteUrl = result.url;
      expect(inviteUrl).toContain('/share/c/');
      expect(inviteUrl).toContain('#');
    });

    const initialBalance = await helper.getBalance();

    await test.step('guest opens shared conversation and sees messages', async () => {
      await unauthenticatedPage.goto(inviteUrl);

      await expectSharedConversationLoaded(unauthenticatedPage);

      // Existing messages from group fixture should be visible
      await expect(unauthenticatedPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('guest sends message and receives AI response', async () => {
      const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await expect(guestInput).toBeVisible({ timeout: 5000 });

      const guestMessage = `Guest says hello ${String(Date.now())}`;
      await guestInput.fill(guestMessage);

      const sendButton = unauthenticatedPage.getByTestId('send-button');
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      // Guest's message should appear
      await expect(unauthenticatedPage.getByText(guestMessage).first()).toBeVisible({
        timeout: 10_000,
      });

      // AI Echo response should appear
      await expect(
        unauthenticatedPage.getByRole('log', { name: 'Chat messages' }).getByText('Echo:').first()
      ).toBeVisible({ timeout: 15_000 });
    });

    await test.step('guest selects a model and sends another message', async () => {
      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.selectNonPremiumModel();

      const modelMessage = `Guest model test ${String(Date.now())}`;
      const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await guestInput.fill(modelMessage);

      const sendButton = unauthenticatedPage.getByTestId('send-button');
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      // Guest's message should appear
      await expect(unauthenticatedPage.getByText(modelMessage).first()).toBeVisible({
        timeout: 10_000,
      });

      // AI response should appear with model nametag
      await guestChatPage.waitForAIResponse();
      await guestChatPage.expectAllAIMessagesHaveNametag();
    });

    await test.step('owner balance decreased (owner-funded billing)', async () => {
      await expect
        .poll(
          async () => {
            const finalBalance = await helper.getBalance();
            return Number.parseFloat(finalBalance.balance);
          },
          { timeout: 10_000, intervals: [500, 1000, 2000] }
        )
        .toBeLessThan(Number.parseFloat(initialBalance.balance));
    });
  });
});
