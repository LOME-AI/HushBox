import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { setupGroupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { createInviteLink, createWriteLinkWithBudget } from '../helpers/invite-link.js';
import {
  expectSharedConversationLoaded,
  expectNoSendInput,
  expectReadOnlyNotice,
  expectDelegatedBudgetNotice,
} from '../helpers/link-assertions.js';

test.describe('Link Guest Access', () => {
  test.describe.configure({ mode: 'serial' });

  test('with-history link guests can view and interact', async ({
    authenticatedPage,
    unauthenticatedPage,
    authenticatedRequest,
    groupConversation,
    browser,
  }) => {
    test.slow();

    const { sidebar, helper } = await setupGroupConversationWithSidebar(
      authenticatedPage,
      authenticatedRequest,
      groupConversation.id
    );

    let readUrl: string;
    let writeUrl: string;

    await test.step('create read+history link and verify guest access', async () => {
      const result = await createInviteLink(authenticatedPage, sidebar, { withHistory: true });
      readUrl = result.url;
      expect(readUrl).toContain('/share/c/');
    });

    await test.step('read guest sees all history and has no send input', async () => {
      await unauthenticatedPage.goto(readUrl);

      await expectSharedConversationLoaded(unauthenticatedPage);

      // Sees pre-existing messages (with-history)
      await expect(unauthenticatedPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(unauthenticatedPage.getByText('Hi from Bob').first()).toBeVisible();

      await expectNoSendInput(unauthenticatedPage);
      await expectReadOnlyNotice(unauthenticatedPage);
    });

    await test.step('create write+history link and setup budgets', async () => {
      const result = await createWriteLinkWithBudget(
        authenticatedPage,
        sidebar,
        helper,
        groupConversation.id,
        { withHistory: true }
      );
      writeUrl = result.url;
    });

    await test.step('write guest sees history and can send', async () => {
      // Use fresh context to avoid cache from read guest
      const freshContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const freshPage = await freshContext.newPage();
      await freshPage.goto(writeUrl);

      await expectSharedConversationLoaded(freshPage);

      // Sees pre-existing messages
      await expect(freshPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });

      await expectDelegatedBudgetNotice(freshPage);

      // Can send a message
      const guestInput = freshPage.getByRole('textbox', { name: /message/i });
      await expect(guestInput).toBeVisible({ timeout: 5000 });

      const guestMessage = `Write guest says hello ${String(Date.now())}`;
      await guestInput.fill(guestMessage);

      const sendButton = freshPage.getByTestId('send-button');
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      await expect(freshPage.getByText(guestMessage).first()).toBeVisible({ timeout: 10_000 });

      // AI Echo response appears
      await expect(
        freshPage.getByRole('log', { name: 'Chat messages' }).getByText('Echo:').first()
      ).toBeVisible({ timeout: 15_000 });

      await freshContext.close();
    });
  });

  test('without-history link guests see only post-link messages', async ({
    authenticatedPage,
    unauthenticatedPage,
    authenticatedRequest,
    groupConversation,
    browser,
  }) => {
    test.slow();

    const { chatPage, sidebar, helper } = await setupGroupConversationWithSidebar(
      authenticatedPage,
      authenticatedRequest,
      groupConversation.id
    );

    let readUrl: string;
    let writeUrl: string;

    await test.step('create read+no-history link (triggers epoch rotation)', async () => {
      const result = await createInviteLink(authenticatedPage, sidebar);
      readUrl = result.url;
    });

    await test.step('Alice sends message in new epoch', async () => {
      const newMessage = `Post-rotation message ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(newMessage);
      await chatPage.expectMessageVisible(newMessage);
    });

    await test.step('read guest does NOT see old messages, sees new message', async () => {
      await unauthenticatedPage.goto(readUrl);

      await expectSharedConversationLoaded(unauthenticatedPage);

      // Should NOT see pre-rotation messages
      await expect(
        unauthenticatedPage.getByText('Hello from Alice', { exact: true })
      ).not.toBeVisible();

      // Should see post-rotation message
      await expect(unauthenticatedPage.getByText('Post-rotation message').first()).toBeVisible({
        timeout: 10_000,
      });

      await expectNoSendInput(unauthenticatedPage);
      await expectReadOnlyNotice(unauthenticatedPage);
    });

    await test.step('create write+no-history link and setup budgets', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(
        authenticatedPage,
        sidebar,
        helper,
        groupConversation.id
      );
      writeUrl = result.url;
    });

    await test.step('Alice sends another message in latest epoch', async () => {
      const latestMessage = `Latest epoch message ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(latestMessage);
      await chatPage.expectMessageVisible(latestMessage);
    });

    await test.step('write guest sees only new messages and can send', async () => {
      const freshContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const freshPage = await freshContext.newPage();
      await freshPage.goto(writeUrl);

      await expectSharedConversationLoaded(freshPage);

      // Should NOT see pre-rotation messages
      await expect(freshPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see latest epoch message
      await expect(freshPage.getByText('Latest epoch message').first()).toBeVisible({
        timeout: 10_000,
      });

      await expectDelegatedBudgetNotice(freshPage);

      // Can send a message
      const guestInput = freshPage.getByRole('textbox', { name: /message/i });
      await expect(guestInput).toBeVisible({ timeout: 5000 });

      const guestMessage = `No-history write guest ${String(Date.now())}`;
      await guestInput.fill(guestMessage);

      const sendButton = freshPage.getByTestId('send-button');
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      await expect(freshPage.getByText(guestMessage).first()).toBeVisible({ timeout: 10_000 });

      await freshContext.close();
    });
  });

  test('read guest sees read-only notice on blank conversation', async ({
    authenticatedPage,
    unauthenticatedPage,
    groupConversation,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let readUrl: string;

    await test.step('create read+history link', async () => {
      const result = await createInviteLink(authenticatedPage, sidebar, { withHistory: true });
      readUrl = result.url;
    });

    await test.step('read guest sees read-only notice (not trial notice)', async () => {
      // Guest opens link without any new messages being sent after link creation
      await unauthenticatedPage.goto(readUrl);

      await expectSharedConversationLoaded(unauthenticatedPage);
      await expectReadOnlyNotice(unauthenticatedPage);
    });
  });
});
