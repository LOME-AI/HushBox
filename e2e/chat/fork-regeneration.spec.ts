import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';

test.describe('Fork and Regeneration Interaction', () => {
  test.describe.configure({ mode: 'serial' });

  test('regenerate on fork only affects that fork', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    const followup = `Followup ${String(Date.now())}`;
    const forkMsg = `Fork only ${String(Date.now())}`;

    await test.step('send follow-up to have 4 messages', async () => {
      await chatPage.sendFollowUpMessage(followup);
      await chatPage.waitForAIResponse(followup);
      expect(await chatPage.countMessages()).toBe(4);
    });

    await test.step('fork from first AI response', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('on Fork 1: send extra message', async () => {
      await chatPage.sendFollowUpMessage(forkMsg);
      await chatPage.waitForAIResponse(forkMsg);
    });

    const fork1Count = await chatPage.countMessages();

    await test.step('switch to Main and retry follow-up user message', async () => {
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      // Main has 4 messages: [user, AI, followup-user, followup-AI].
      // After a fork-tab switch MessageList remounts (key includes activeForkId);
      // Virtuoso has to re-measure rows before [data-item-index] attributes are
      // set. Gate on Main's followup-user text being rendered before reading
      // any index — `followup` is unique to Main's chain so this also confirms
      // we're not still painting Fork 1's content.
      await chatPage.expectMessageVisible(followup);
      // Retry the followup user message (index 2)
      await chatPage.clickRetry(2);
      await chatPage.waitForStreamComplete();
    });

    await test.step('switch to Fork 1 — verify unchanged', async () => {
      await chatPage.clickForkTab('Fork 1');
      // Same gating reason as the Main switch above — wait for Fork 1's
      // unique message before counting rows.
      await chatPage.expectMessageVisible(forkMsg);
      await unsettledExpect
        .poll(() => chatPage.countMessages(), { timeout: 5000 })
        .toBe(fork1Count);
    });
  });

  test('regenerate before fork point preserves shared messages', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    // At this point from previous test, conversation has messages on Main + Fork 1
    // Create a fresh conversation for clarity
    await chatPage.goto();
    const uniqueMsg = `Shared test ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(uniqueMsg);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse(uniqueMsg);

    const followup = `Second msg ${String(Date.now())}`;
    const forkMsg = `Fork extra ${String(Date.now())}`;

    await test.step('send follow-up to have 4 messages', async () => {
      await chatPage.sendFollowUpMessage(followup);
      await chatPage.waitForAIResponse(followup);
      expect(await chatPage.countMessages()).toBe(4);
    });

    await test.step('fork from second AI response (index 1)', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
    });

    await test.step('on Fork 1: send extra message', async () => {
      await chatPage.sendFollowUpMessage(forkMsg);
      await chatPage.waitForAIResponse(forkMsg);
    });

    await test.step('on Main: retry first user message', async () => {
      await chatPage.clickForkTab('Main');
      // Gate on Main's followup text before reading row indices — MessageList
      // remounts on fork-tab switch and Virtuoso needs to measure rows before
      // `clickRetry` can scroll/attach by index.
      await chatPage.expectMessageVisible(followup);
      await chatPage.clickRetry(0);
      await chatPage.waitForAIResponse();
      // After retry + refetch, Main's fork chain should have only 2 messages.
      // Use poll — the fork filter updates asynchronously after query refetch.
      await unsettledExpect.poll(() => chatPage.countMessages(), { timeout: 10_000 }).toBe(2);
    });

    await test.step('Fork 1 still intact with its messages', async () => {
      await chatPage.clickForkTab('Fork 1');
      // Gate on Fork 1's exclusive message before counting.
      await chatPage.expectMessageVisible(forkMsg);
      // Fork 1 chain walk from its tip should include the shared early messages
      await expect
        .poll(() => chatPage.countMessages(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(4);
    });
  });

  test('nested fork from a fork', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.goto();
    const msg = `Nested fork test ${String(Date.now())}`;
    const fork1Msg = `Fork1 msg ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(msg);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse(msg);

    await test.step('create Fork 1 from AI response', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('send messages on Fork 1', async () => {
      await chatPage.sendFollowUpMessage(fork1Msg);
      await chatPage.waitForAIResponse(fork1Msg);
    });

    await test.step('fork from a message on Fork 1 to create Fork 2', async () => {
      const aiMessages = chatPage.messageList.locator('[data-role="assistant"]');
      const lastAi = aiMessages.last();
      await lastAi.hover();
      await lastAi.getByRole('button', { name: 'Fork' }).click();
    });

    await test.step('verify 3 tabs', async () => {
      await chatPage.expectForkTabCount(3);
      await expect(chatPage.getForkTab('Fork 2')).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 2');
    });

    await test.step('send on Fork 2 and verify divergence', async () => {
      const fork2Msg = `Fork2 unique ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(fork2Msg);
      await chatPage.waitForAIResponse(fork2Msg);

      await chatPage.expectMessageVisible(fork2Msg);

      await chatPage.clickForkTab('Fork 1');
      // Gate on a Fork 1-exclusive message rendering before asserting Fork 2's
      // unique text is gone — MessageList remounts on fork switch and would
      // otherwise be transiently empty (no children → vacuous not-visible).
      // Use the unique-per-run text because expectMessageVisible does an
      // exact-string match (it's a thin alias over assertMessageVisible
      // with `exact: true`).
      await chatPage.expectMessageVisible(fork1Msg);
      await expect(chatPage.messageList.getByText(fork2Msg, { exact: true })).not.toBeVisible();
    });
  });

  test('delete fork preserves shared messages for other forks', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.goto();
    const msg = `Delete fork test ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(msg);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse(msg);

    await test.step('send follow-up', async () => {
      const followup = `Followup ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(followup);
      await chatPage.waitForAIResponse(followup);
    });

    await test.step('create fork from AI response', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
    });

    await test.step('send messages on Fork 1', async () => {
      const forkMsg = `Fork exclusive ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(forkMsg);
      await chatPage.waitForAIResponse(forkMsg);
    });

    const totalBefore = await chatPage.getMessageCountViaAPI();

    await test.step('delete Fork 1', async () => {
      await chatPage.clickForkTabMenuAction('Fork 1', 'Delete');
      await chatPage.confirmDelete();
      // confirmDelete only awaits the dialog disappearing (which is sync
      // setState). The DELETE request itself is in-flight. The server
      // collapses the tablist to linear once only Main remains
      // (apps/api/src/services/forks/forks.ts:307-310), so wait for the fork
      // tabs to vanish before probing the API — otherwise we read the
      // pre-delete state and the page teardown aborts the DELETE.
      await chatPage.expectNoForkTabs();
    });

    await test.step('verify Main messages intact', async () => {
      await chatPage.expectMessageVisible(msg);
      await expect
        .poll(() => chatPage.countMessages(), { timeout: 5000 })
        .toBeGreaterThanOrEqual(2);
    });

    await test.step('verify API message count decreased', async () => {
      const totalAfter = await chatPage.getMessageCountViaAPI();
      expect(totalAfter).toBeLessThan(totalBefore);
    });
  });
});
