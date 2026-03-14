import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';

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

    const chatPage = new ChatPage(authenticatedPage);
    const helper = new BudgetHelper(authenticatedRequest);

    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let readUrl: string;
    let writeUrl: string;
    let writeLinkId: string;

    await test.step('create read+history link and verify guest access', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      // Check history checkbox
      await authenticatedPage
        .getByTestId('invite-link-history-checkbox')
        .getByRole('checkbox')
        .check();

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      readUrl = (await urlEl.textContent()) ?? '';
      expect(readUrl).toContain('/share/c/');

      await authenticatedPage.locator('[data-slot="modal-overlay-close"]').click();
    });

    await test.step('read guest sees all history and has no send input', async () => {
      await unauthenticatedPage.goto(readUrl);

      await expect(unauthenticatedPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Sees pre-existing messages (with-history)
      await expect(unauthenticatedPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(unauthenticatedPage.getByText('Hi from Bob').first()).toBeVisible();

      // Read privilege: no send input
      const sendInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await expect(sendInput).not.toBeVisible();

      // Correct notification: read-only notice, not trial notice
      await expect(
        unauthenticatedPage.getByTestId('budget-message-read_only_notice')
      ).toBeVisible();
      await expect(
        unauthenticatedPage.getByTestId('budget-message-trial_notice')
      ).not.toBeVisible();
    });

    await test.step('create write+history link', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('invite-link-privilege-select').selectOption('write');

      await authenticatedPage
        .getByTestId('invite-link-history-checkbox')
        .getByRole('checkbox')
        .check();

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      writeUrl = (await urlEl.textContent()) ?? '';

      await authenticatedPage.locator('[data-slot="modal-overlay-close"]').click();

      // Capture linkId for budget setup
      const linkRow = sidebar.content.locator('[data-testid^="link-item-"]').first();
      await expect(linkRow).toBeVisible();
      const testId = await linkRow.getAttribute('data-testid');
      writeLinkId = testId!.replace('link-item-', '');
    });

    await test.step('setup budgets for write link', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const linkMemberId = await helper.findLinkMemberId(groupConversation.id, writeLinkId);
      await helper.setMemberBudget(groupConversation.id, linkMemberId, 500);
    });

    await test.step('write guest sees history and can send', async () => {
      // Use fresh context to avoid cache from read guest
      const freshContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const freshPage = await freshContext.newPage();
      await freshPage.goto(writeUrl);

      await expect(freshPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Sees pre-existing messages
      await expect(freshPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });

      // Correct notification: delegated budget notice, not trial notice
      await expect(freshPage.getByTestId('budget-message-delegated_budget_notice')).toBeVisible();
      await expect(freshPage.getByTestId('budget-message-trial_notice')).not.toBeVisible();

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

    const chatPage = new ChatPage(authenticatedPage);
    const helper = new BudgetHelper(authenticatedRequest);

    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let readUrl: string;
    let writeUrl: string;
    let writeLinkId: string;

    await test.step('create read+no-history link (triggers epoch rotation)', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      // History checkbox left unchecked (default)
      const historyCheckbox = authenticatedPage
        .getByTestId('invite-link-history-checkbox')
        .getByRole('checkbox');
      await expect(historyCheckbox).not.toBeChecked();

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      readUrl = (await urlEl.textContent()) ?? '';

      await authenticatedPage.locator('[data-slot="modal-overlay-close"]').click();
    });

    await test.step('Alice sends message in new epoch', async () => {
      const newMessage = `Post-rotation message ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(newMessage);
      await chatPage.expectMessageVisible(newMessage);
    });

    await test.step('read guest does NOT see old messages, sees new message', async () => {
      await unauthenticatedPage.goto(readUrl);

      await expect(unauthenticatedPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Should NOT see pre-rotation messages
      await expect(
        unauthenticatedPage.getByText('Hello from Alice', { exact: true })
      ).not.toBeVisible();

      // Should see post-rotation message
      await expect(unauthenticatedPage.getByText('Post-rotation message').first()).toBeVisible({
        timeout: 10_000,
      });

      // No send input (read privilege)
      const sendInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await expect(sendInput).not.toBeVisible();

      // Correct notification: read-only notice, not trial notice
      await expect(
        unauthenticatedPage.getByTestId('budget-message-read_only_notice')
      ).toBeVisible();
      await expect(
        unauthenticatedPage.getByTestId('budget-message-trial_notice')
      ).not.toBeVisible();
    });

    await test.step('create write+no-history link', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('invite-link-privilege-select').selectOption('write');

      // History checkbox left unchecked
      const historyCheckbox = authenticatedPage
        .getByTestId('invite-link-history-checkbox')
        .getByRole('checkbox');
      await expect(historyCheckbox).not.toBeChecked();

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      writeUrl = (await urlEl.textContent()) ?? '';

      await authenticatedPage.locator('[data-slot="modal-overlay-close"]').click();

      // Capture linkId for budget setup
      const linkRow = sidebar.content.locator('[data-testid^="link-item-"]').first();
      await expect(linkRow).toBeVisible();
      const testId = await linkRow.getAttribute('data-testid');
      writeLinkId = testId!.replace('link-item-', '');
    });

    await test.step('setup budgets for write link', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const linkMemberId = await helper.findLinkMemberId(groupConversation.id, writeLinkId);
      await helper.setMemberBudget(groupConversation.id, linkMemberId, 500);
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

      await expect(freshPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Should NOT see pre-rotation messages
      await expect(freshPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see latest epoch message
      await expect(freshPage.getByText('Latest epoch message').first()).toBeVisible({
        timeout: 10_000,
      });

      // Correct notification: delegated budget notice, not trial notice
      await expect(freshPage.getByTestId('budget-message-delegated_budget_notice')).toBeVisible();
      await expect(freshPage.getByTestId('budget-message-trial_notice')).not.toBeVisible();

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
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      // Include history so guest can access the conversation
      await authenticatedPage
        .getByTestId('invite-link-history-checkbox')
        .getByRole('checkbox')
        .check();

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      readUrl = (await urlEl.textContent()) ?? '';

      await authenticatedPage.locator('[data-slot="modal-overlay-close"]').click();
    });

    await test.step('read guest sees read-only notice (not trial notice)', async () => {
      // Guest opens link without any new messages being sent after link creation
      await unauthenticatedPage.goto(readUrl);

      await expect(unauthenticatedPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Should see read-only notice, never trial notice
      await expect(unauthenticatedPage.getByTestId('budget-message-read_only_notice')).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        unauthenticatedPage.getByTestId('budget-message-trial_notice')
      ).not.toBeVisible();
    });
  });
});
