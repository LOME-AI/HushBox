import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';

test.describe('Auth User Using Link', () => {
  test.describe.configure({ mode: 'serial' });

  test('logged-in member using history link sees decrypted messages', async ({
    authenticatedPage,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    const helper = new BudgetHelper(authenticatedRequest);

    let readUrl: string;
    let writeUrl: string;
    let writeLinkId: string;

    await test.step('create read+history link', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

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

    await test.step('Bob opens read link — messages decrypt correctly', async () => {
      await testBobPage.goto(readUrl);

      await expect(testBobPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Messages should decrypt without errors (Bug 2 fix: credentials omit)
      await expect(testBobPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(testBobPage.getByText('Hi from Bob').first()).toBeVisible();

      // No decryption errors
      await expect(testBobPage.getByText('[decryption failed')).not.toBeVisible();

      // Read privilege: no send input
      const sendInput = testBobPage.getByRole('textbox', { name: 'Ask me anything...' });
      await expect(sendInput).not.toBeVisible();
    });

    await test.step('create write+history link', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

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
      await expect(linkRow).toBeVisible({ timeout: 10_000 });
      const testId = await linkRow.getAttribute('data-testid');
      writeLinkId = testId!.replace('link-item-', '');
    });

    await test.step('setup budgets for write link', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const linkMemberId = await helper.findLinkMemberId(groupConversation.id, writeLinkId);
      await helper.setMemberBudget(groupConversation.id, linkMemberId, 500);
    });

    await test.step('Bob opens write link — messages decrypt, can send', async () => {
      await testBobPage.goto(writeUrl);

      await expect(testBobPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Messages decrypt correctly
      await expect(testBobPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });

      // No decryption errors
      await expect(testBobPage.getByText('[decryption failed')).not.toBeVisible();

      // Can send a message
      const bobInput = testBobPage.getByRole('textbox', { name: 'Ask me anything...' });
      await expect(bobInput).toBeVisible({ timeout: 5000 });

      const bobMessage = `Bob via link ${String(Date.now())}`;
      await bobInput.fill(bobMessage);

      const sendButton = testBobPage.getByTestId('send-button');
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      await expect(testBobPage.getByText(bobMessage).first()).toBeVisible({ timeout: 10_000 });
    });
  });

  test('logged-in member using no-history link sees only new messages', async ({
    authenticatedPage,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const helper = new BudgetHelper(authenticatedRequest);

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let readUrl: string;
    let writeUrl: string;
    let writeLinkId: string;

    await test.step('create read+no-history link', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      // History checkbox left unchecked
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
      const newMessage = `Post no-history link ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(newMessage);
      await chatPage.expectMessageVisible(newMessage);
    });

    await test.step('Bob opens read link — sees only new messages, no errors', async () => {
      await testBobPage.goto(readUrl);

      await expect(testBobPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Should NOT see pre-rotation messages
      await expect(testBobPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see post-rotation message
      await expect(testBobPage.getByText('Post no-history link').first()).toBeVisible({
        timeout: 10_000,
      });

      // No decryption errors
      await expect(testBobPage.getByText('[decryption failed')).not.toBeVisible();

      // No send input (read privilege)
      const sendInput = testBobPage.getByRole('textbox', { name: 'Ask me anything...' });
      await expect(sendInput).not.toBeVisible();
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
      await expect(linkRow).toBeVisible({ timeout: 10_000 });
      const testId = await linkRow.getAttribute('data-testid');
      writeLinkId = testId!.replace('link-item-', '');
    });

    await test.step('setup budgets for write link', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const linkMemberId = await helper.findLinkMemberId(groupConversation.id, writeLinkId);
      await helper.setMemberBudget(groupConversation.id, linkMemberId, 500);
    });

    await test.step('Alice sends another message', async () => {
      const latestMessage = `Latest for write link ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(latestMessage);
      await chatPage.expectMessageVisible(latestMessage);
    });

    await test.step('Bob opens write link — sees only new, can send, no errors', async () => {
      await testBobPage.goto(writeUrl);

      await expect(testBobPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Should NOT see old messages
      await expect(testBobPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see latest message
      await expect(testBobPage.getByText('Latest for write link').first()).toBeVisible({
        timeout: 10_000,
      });

      // No decryption errors
      await expect(testBobPage.getByText('[decryption failed')).not.toBeVisible();

      // Can send a message
      const bobInput = testBobPage.getByRole('textbox', { name: 'Ask me anything...' });
      await expect(bobInput).toBeVisible({ timeout: 5000 });

      const bobMessage = `Bob no-history write ${String(Date.now())}`;
      await bobInput.fill(bobMessage);

      const sendButton = testBobPage.getByTestId('send-button');
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      await expect(testBobPage.getByText(bobMessage).first()).toBeVisible({ timeout: 10_000 });
    });
  });
});
