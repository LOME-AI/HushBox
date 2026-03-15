import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';

test.describe('Fork Lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  test('create first fork shows tab UI with Main and Fork 1', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify no fork tabs initially', async () => {
      await expect(chatPage.getForkTabList()).not.toBeVisible();
    });

    await test.step('hover AI message and click fork', async () => {
      await chatPage.clickFork(1);
    });

    await test.step('verify fork tabs appear with Main and Fork 1', async () => {
      await expect(chatPage.getForkTabList()).toBeVisible();
      await chatPage.expectForkTabCount(2);
      await expect(chatPage.getForkTab('Main')).toBeVisible();
      await expect(chatPage.getForkTab('Fork 1')).toBeVisible();
    });

    await test.step('verify Fork 1 is active', async () => {
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('verify URL has fork param', () => {
      const forkId = chatPage.getForkIdFromUrl();
      expect(forkId).not.toBeNull();
    });
  });

  test('switch between fork tabs shows different messages', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('on Fork 1: send follow-up and wait for AI', async () => {
      const msg = `Fork 1 msg ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
    });

    const fork1MessageCount = await chatPage.getMessageCount();

    await test.step('switch to Main tab — fewer messages', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: 10_000 });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      const mainCount = await chatPage.getMessageCount();
      expect(mainCount).toBeLessThan(fork1MessageCount);
    });

    await test.step('switch back to Fork 1 — more messages', async () => {
      await expect(chatPage.getForkTab('Fork 1')).toBeVisible({ timeout: 10_000 });
      await chatPage.clickForkTab('Fork 1');
      await chatPage.expectActiveForkTab('Fork 1');
      const count = await chatPage.getMessageCount();
      expect(count).toBe(fork1MessageCount);
    });
  });

  test('create second fork', async ({ authenticatedPage, testConversation: _testConversation }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('switch to Main and fork from user message', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: 10_000 });
      await chatPage.clickForkTab('Main');
      await chatPage.clickFork(0);
    });

    await test.step('verify 3 tabs', async () => {
      await chatPage.expectForkTabCount(3);
      await expect(chatPage.getForkTab('Fork 2')).toBeVisible();
      await chatPage.expectActiveForkTab('Fork 2');
    });
  });

  test('rename fork via three-dot menu', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('open menu on Fork 2 and click Rename', async () => {
      await chatPage.clickForkTabMenuAction('Fork 2', 'Rename');
    });

    await test.step('rename to My Branch', async () => {
      await chatPage.confirmRename('My Branch');
    });

    await test.step('verify tab reads My Branch', async () => {
      await expect(chatPage.getForkTab('My Branch')).toBeVisible();
      await expect(chatPage.getForkTab('Fork 2')).not.toBeVisible();
    });
  });

  test('delete fork via three-dot menu', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('open menu on My Branch and click Delete', async () => {
      await chatPage.clickForkTabMenuAction('My Branch', 'Delete');
    });

    await test.step('confirm delete', async () => {
      await chatPage.confirmDelete();
    });

    await test.step('verify 2 tabs remain', async () => {
      await chatPage.expectForkTabCount(2);
      await expect(chatPage.getForkTab('My Branch')).not.toBeVisible();
    });
  });

  test('delete last fork reverts to linear', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('delete Fork 1', async () => {
      await chatPage.clickForkTabMenuAction('Fork 1', 'Delete');
      await chatPage.confirmDelete();
    });

    await test.step('verify tab bar disappears', async () => {
      await chatPage.expectNoForkTabs();
    });

    await test.step('verify URL has no fork param', () => {
      const forkId = chatPage.getForkIdFromUrl();
      expect(forkId).toBeNull();
    });

    await test.step('verify messages display normally', async () => {
      const count = await chatPage.getMessageCount();
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  test('fork limit enforced', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create 5 forks (hitting MAX_FORKS_PER_CONVERSATION)', async () => {
      // Create fork 1 (creates Main + Fork 1 = 2 forks total)
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);

      // Create forks 2-4 via API for speed
      for (let index = 2; index <= 4; index++) {
        await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: 10_000 });
        await chatPage.clickForkTab('Main');
        await chatPage.clickFork(0);
        await chatPage.expectForkTabCount(index + 1);
      }
    });

    await test.step('try to create 6th fork — should fail', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: 10_000 });
      await chatPage.clickForkTab('Main');
      await chatPage.hoverMessage(0);
      await chatPage.getForkButton(0).click();

      // Should show an error (toast or similar) rather than creating a 6th tab
      // Wait a moment to ensure no new tab appears
      await authenticatedPage.waitForTimeout(2000);
      await chatPage.expectForkTabCount(5);
    });
  });
});

test.describe('Fork URL and Refresh', () => {
  test('fork URL param loads correct fork on page load', async ({
    authenticatedPage,
    testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create a fork', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
    });

    const forkId = chatPage.getForkIdFromUrl();
    expect(forkId).not.toBeNull();

    await test.step('navigate directly to fork URL', async () => {
      await authenticatedPage.goto(`/chat/${testConversation.id}?fork=${forkId!}`);
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify correct tab is active', async () => {
      await chatPage.expectActiveForkTab('Fork 1');
    });
  });

  test('page refresh preserves active fork', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('create fork and verify it is active', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('reload page', async () => {
      await authenticatedPage.reload();
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify same tab still active', async () => {
      await chatPage.expectActiveForkTab('Fork 1');
    });
  });

  test('invalid fork ID in URL falls back gracefully', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('navigate with invalid fork ID', async () => {
      await authenticatedPage.goto(`/chat/${testConversation.id}?fork=nonexistent-id`);
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify messages load without crash', async () => {
      const count = await chatPage.getMessageCount();
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });
});

test.describe('Group Chat Forking', () => {
  test('write+ member can fork, tabs visible to both users', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    test.slow();
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await test.step('Alice navigates and creates fork', async () => {
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();

      // Fork from the AI message
      const aiMessage = aliceChatPage.messageList.locator('[data-role="assistant"]').first();
      await aiMessage.hover();
      await aiMessage.getByRole('button', { name: 'Fork' }).click();

      await expect(aliceChatPage.getForkTabList()).toBeVisible();
      await aliceChatPage.expectForkTabCount(2);
    });

    await test.step('Bob navigates and sees same fork tabs', async () => {
      await bobChatPage.gotoConversation(groupConversation.id);
      await bobChatPage.waitForConversationLoaded();

      await expect(bobChatPage.getForkTabList()).toBeVisible();
      await bobChatPage.expectForkTabCount(2);
      await expect(bobChatPage.getForkTab('Main')).toBeVisible();
      await expect(bobChatPage.getForkTab('Fork 1')).toBeVisible();
    });
  });
});

test.describe('Fork History Preservation', () => {
  test('fork preserves all message history in both branches', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('send 3 exchanges (6 messages total)', async () => {
      const msg1 = `History test 1 ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(msg1);
      await chatPage.waitForConversation();
      await chatPage.waitForAIResponse(msg1);

      const msg2 = `History test 2 ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg2);
      await chatPage.waitForAIResponse(msg2);

      const msg3 = `History test 3 ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg3);
      await chatPage.waitForAIResponse(msg3);
    });

    const totalMessages = await chatPage.getMessageCount();
    expect(totalMessages).toBe(6);

    await test.step('fork from 4th message (2nd AI response)', async () => {
      await chatPage.clickFork(3);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('Fork 1 shows messages up to fork point', async () => {
      const forkCount = await chatPage.getMessageCount();
      expect(forkCount).toBe(4);
    });

    await test.step('Main still has all 6 messages', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: 10_000 });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      const mainCount = await chatPage.getMessageCount();
      expect(mainCount).toBe(6);
    });

    await test.step('switching back to Fork 1 preserves 4 messages', async () => {
      await chatPage.clickForkTab('Fork 1');
      await chatPage.expectActiveForkTab('Fork 1');
      const forkCount = await chatPage.getMessageCount();
      expect(forkCount).toBe(4);
    });
  });

  test('fork from multi-model response preserves sibling AI messages', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select 2 models and send message', async () => {
      await chatPage.selectModels(2);
      await chatPage.expectComparisonBarVisible();
      const testMessage = `Multi-model fork ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);
      await chatPage.waitForConversation();
      await chatPage.waitForMultiModelResponses(2);
    });

    const totalMessages = await chatPage.getMessageCount();
    expect(totalMessages).toBe(3); // 1 user + 2 AI

    // Capture the first AI message's model nametag before forking
    const firstAiNametag = await chatPage.getMessage(1).getByTestId('model-nametag').textContent();

    await test.step('fork from first AI message', async () => {
      await chatPage.clickFork(1);
      await chatPage.expectForkTabCount(2);
      await chatPage.expectActiveForkTab('Fork 1');
    });

    await test.step('Fork 1 has the forked AI message only', async () => {
      const forkCount = await chatPage.getMessageCount();
      expect(forkCount).toBe(2); // 1 user + 1 AI (the one forked from)
      await chatPage.expectModelNametag(1, firstAiNametag!);
    });

    await test.step('Main still has all 3 messages', async () => {
      await expect(chatPage.getForkTab('Main')).toBeVisible({ timeout: 10_000 });
      await chatPage.clickForkTab('Main');
      await chatPage.expectActiveForkTab('Main');
      const mainCount = await chatPage.getMessageCount();
      expect(mainCount).toBe(3);
    });
  });
});
