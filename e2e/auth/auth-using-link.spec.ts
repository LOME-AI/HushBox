import { test, expect } from '../fixtures.js';
import { setupGroupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { createInviteLink, createWriteLinkWithBudget } from '../helpers/invite-link.js';
import { ChatPage } from '../pages/index.js';
import {
  expectSharedConversationLoaded,
  expectNoDecryptionErrors,
  expectSendInputDisabled,
  sendMessageAsGuest,
} from '../helpers/link-assertions.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Auth User Using Link', () => {
  // eslint-disable-next-line no-restricted-syntax -- serial: both tests drive the same shared `test-alice`/`test-bob` personas through link-creation + budget flows; serializing avoids cross-test contention on those shared accounts under fullyParallel.
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
      const result = await createInviteLink(authenticatedPage, sidebar, {
        withHistory: true,
        extractLinkId: false,
      });
      readUrl = result.url;
    });

    await test.step('Bob opens read link — messages decrypt correctly', async () => {
      await testBobPage.goto(readUrl, { waitUntil: 'domcontentloaded' });

      await expectSharedConversationLoaded(testBobPage);

      // Chat mounts at the latest message; older rows may be virtualized out
      // of the viewport, so use the scroll-aware helper to assert visibility.
      const bobChatPage = new ChatPage(testBobPage);
      await bobChatPage.assertMessageVisible('Hello from Alice', { timeout: TIMEOUTS.ASSERT });
      await bobChatPage.assertMessageVisible('Hi from Bob');

      await expectNoDecryptionErrors(testBobPage);
      await expectSendInputDisabled(testBobPage);
    });

    await test.step('create write+history link and setup budgets', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(authenticatedPage, sidebar, {
        helper,
        conversationId: groupConversation.id,
        withHistory: true,
        displayName: 'Write Link History',
      });
      writeUrl = result.url;
    });

    await test.step('Bob opens write link — messages decrypt, can send', async () => {
      await testBobPage.goto(writeUrl, { waitUntil: 'domcontentloaded' });

      await expectSharedConversationLoaded(testBobPage);

      const bobChatPage = new ChatPage(testBobPage);
      await bobChatPage.assertMessageVisible('Hello from Alice', { timeout: TIMEOUTS.ASSERT });

      await expectNoDecryptionErrors(testBobPage);

      await sendMessageAsGuest(testBobPage, `Bob via link ${String(Date.now())}`, /message/i);
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
      const result = await createInviteLink(authenticatedPage, sidebar, { extractLinkId: false });
      readUrl = result.url;
      await sidebar.closeMobileSidebarIfOpen();
    });

    await test.step('Alice sends message in new epoch', async () => {
      const baselineCount = await chatPage.getMessageCountViaAPI();
      const newMessage = `Post no-history link ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(newMessage);
      await chatPage.expectMessageVisible(newMessage);
      // Stream + persistence runs under Workers waitUntil; Bob's GET below would
      // otherwise race the DB write and load an empty conversation.
      // waitForStreamComplete gates on the client's SSE-done signal, which under
      // saturation can lead the server's waitUntil commit — so additionally read
      // the conversation back through the API until the write lands before Bob
      // navigates. (`.catch` keeps a transient saturation 503 on the read from
      // failing the poll outright.)
      await chatPage.waitForStreamComplete();
      await expect
        .poll(() => chatPage.getMessageCountViaAPI().catch(() => baselineCount), {
          timeout: TIMEOUTS.STREAM_SATURATED,
        })
        .toBeGreaterThan(baselineCount);
    });

    await test.step('Bob opens read link — sees only new messages, no errors', async () => {
      await testBobPage.goto(readUrl, { waitUntil: 'domcontentloaded' });

      await expectSharedConversationLoaded(testBobPage);

      await expect(testBobPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // CONVERSATION_LOAD, not ASSERT: a link guest's first paint waits on the
      // WASM decryption pass, which a saturated host serializes behind every
      // other worker — the "messages loaded and decrypted" budget, not the
      // generic assertion one. The message arrives; it is starved, not missing.
      await expect(testBobPage.getByText('Post no-history link').first()).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      await expectNoDecryptionErrors(testBobPage);
      await expectSendInputDisabled(testBobPage);
    });

    await test.step('create write+no-history link and setup budgets', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(authenticatedPage, sidebar, {
        helper,
        conversationId: groupConversation.id,
        displayName: 'Write Link No History',
      });
      writeUrl = result.url;
      await sidebar.closeMobileSidebarIfOpen();
    });

    await test.step('Alice sends another message', async () => {
      const baselineCount = await chatPage.getMessageCountViaAPI();
      const latestMessage = `Latest for write link ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(latestMessage);
      await chatPage.expectMessageVisible(latestMessage);
      // Confirm the server-side write landed before Bob's link GET (see the
      // read-link step above) — waitForStreamComplete alone races the waitUntil
      // commit under saturation, leaving Bob's view empty.
      await chatPage.waitForStreamComplete();
      await expect
        .poll(() => chatPage.getMessageCountViaAPI().catch(() => baselineCount), {
          timeout: TIMEOUTS.STREAM_SATURATED,
        })
        .toBeGreaterThan(baselineCount);
    });

    await test.step('Bob opens write link — sees only new, can send, no errors', async () => {
      await testBobPage.goto(writeUrl, { waitUntil: 'domcontentloaded' });

      await expectSharedConversationLoaded(testBobPage);

      await expect(testBobPage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Decryption can paint after settled fires.
      // CONVERSATION_LOAD, not ASSERT: the link guest's decryption pass is
      // CPU-starved under the saturated matrix (see the read-link assertion above).
      await expect(testBobPage.getByText('Latest for write link').first()).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      await expectNoDecryptionErrors(testBobPage);

      await sendMessageAsGuest(
        testBobPage,
        `Bob no-history write ${String(Date.now())}`,
        /message/i
      );
    });
  });
});
