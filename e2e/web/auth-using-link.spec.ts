import { test, expect } from '../fixtures.js';
import { setupGroupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { createInviteLink, createWriteLinkWithBudget } from '../helpers/invite-link.js';
import {
  expectSharedConversationLoaded,
  expectNoDecryptionErrors,
  expectNoSendInput,
  sendMessageAsGuest,
} from '../helpers/link-assertions.js';

test.describe('Auth User Using Link', () => {
  test.describe.configure({ mode: 'serial' });

  test('logged-in member using history link sees decrypted messages', async ({
    authenticatedPage,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    test.slow();

    const { sidebar, helper } = await setupGroupConversationWithSidebar(
      authenticatedPage,
      authenticatedRequest,
      groupConversation.id
    );

    let readUrl: string;
    let writeUrl: string;

    await test.step('create read+history link', async () => {
      const result = await createInviteLink(authenticatedPage, sidebar, { withHistory: true });
      readUrl = result.url;
    });

    await test.step('Bob opens read link — messages decrypt correctly', async () => {
      await testBobPage.goto(readUrl);

      await expectSharedConversationLoaded(testBobPage);

      // Messages should decrypt without errors (Bug 2 fix: credentials omit)
      await expect(testBobPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(testBobPage.getByText('Hi from Bob').first()).toBeVisible();

      await expectNoDecryptionErrors(testBobPage);
      await expectNoSendInput(testBobPage, 'Ask me anything...');
    });

    await test.step('create write+history link and setup budgets', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(
        authenticatedPage,
        sidebar,
        helper,
        groupConversation.id,
        { withHistory: true }
      );
      writeUrl = result.url;
    });

    await test.step('Bob opens write link — messages decrypt, can send', async () => {
      await testBobPage.goto(writeUrl);

      await expectSharedConversationLoaded(testBobPage);

      // Messages decrypt correctly
      await expect(testBobPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });

      await expectNoDecryptionErrors(testBobPage);

      // Can send a message
      await sendMessageAsGuest(testBobPage, `Bob via link ${String(Date.now())}`);
    });
  });

  test('logged-in member using no-history link sees only new messages', async ({
    authenticatedPage,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    test.slow();

    const { chatPage, sidebar, helper } = await setupGroupConversationWithSidebar(
      authenticatedPage,
      authenticatedRequest,
      groupConversation.id
    );

    let readUrl: string;
    let writeUrl: string;

    await test.step('create read+no-history link', async () => {
      const result = await createInviteLink(authenticatedPage, sidebar);
      readUrl = result.url;
    });

    await test.step('Alice sends message in new epoch', async () => {
      const newMessage = `Post no-history link ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(newMessage);
      await chatPage.expectMessageVisible(newMessage);
    });

    await test.step('Bob opens read link — sees only new messages, no errors', async () => {
      await testBobPage.goto(readUrl);

      await expectSharedConversationLoaded(testBobPage);

      // Should NOT see pre-rotation messages
      await expect(testBobPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see post-rotation message
      await expect(testBobPage.getByText('Post no-history link').first()).toBeVisible({
        timeout: 10_000,
      });

      await expectNoDecryptionErrors(testBobPage);
      await expectNoSendInput(testBobPage, 'Ask me anything...');
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

    await test.step('Alice sends another message', async () => {
      const latestMessage = `Latest for write link ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(latestMessage);
      await chatPage.expectMessageVisible(latestMessage);
    });

    await test.step('Bob opens write link — sees only new, can send, no errors', async () => {
      await testBobPage.goto(writeUrl);

      await expectSharedConversationLoaded(testBobPage);

      // Should NOT see old messages
      await expect(testBobPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see latest message
      await expect(testBobPage.getByText('Latest for write link').first()).toBeVisible({
        timeout: 10_000,
      });

      await expectNoDecryptionErrors(testBobPage);

      // Can send a message
      await sendMessageAsGuest(testBobPage, `Bob no-history write ${String(Date.now())}`);
    });
  });
});
