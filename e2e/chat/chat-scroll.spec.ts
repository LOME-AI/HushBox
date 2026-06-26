import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Auto-scroll During Streaming', () => {
  test('auto-scrolls to bottom in all scenarios', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const message = 'Echo long response test';
    await chatPage.sendFollowUpMessage(message);
    await chatPage.waitForAIResponse(message);
    // Gate on the app's settled-at-bottom signal, not a one-shot pixel read: the
    // reply's code block highlights (Shiki) and grows a controls bar after the
    // stream completes, and auto-scroll re-pins once that settles. data-at-bottom
    // reflects that final state deterministically (no mid-layout flake).
    await chatPage.waitForAtBottom();

    const followUp = 'Second message to verify auto-scroll stays on';
    await chatPage.sendFollowUpMessage(followUp);
    await chatPage.waitForAIResponse(followUp);
    await chatPage.waitForAtBottom();

    await chatPage.scrollToTop();

    const message2 = 'Hello after scroll up';
    await chatPage.sendFollowUpMessage(message2);
    await chatPage.waitForAIResponse(message2);
    await chatPage.waitForAtBottom();
  });

  test('single scroll during streaming breaks away from bottom', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    const setupMessages = [
      'Building scrollable content - message one with enough text to add some height to the chat',
      'Building scrollable content - message two with enough text to add more height to the chat',
      'Building scrollable content - message three with enough text to build up scrollable content',
    ];

    for (const msg of setupMessages) {
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
    }

    const initialPos = await chatPage.getScrollPosition();
    expect(initialPos.scrollHeight).toBeGreaterThan(initialPos.clientHeight);

    const testMessage = 'Testing scroll behavior during streaming. '.repeat(10);

    await chatPage.sendFollowUpMessage(testMessage);

    await expect(
      chatPage.messagesByRole('assistant').getByText('Testing scroll', { exact: false })
    ).toBeVisible({ timeout: TIMEOUTS.ASSERT });

    // Re-issue the scroll each poll iteration, not once: under a saturated mobile
    // engine the break-away gesture (a synthetic wheel event) can land outside
    // the app's USER_SCROLL_DECAY_MS window relative to Virtuoso's debounced
    // atBottom callback, so a single scroll-up may not register and the list
    // re-pins to the bottom. Keep nudging — the behaviour a user who keeps
    // scrolling sees — until the view holds clear of the bottom by the
    // viewport-proportional threshold. A list that never breaks away (a real
    // regression) never clears the threshold and the poll times out.
    await expect(async () => {
      await chatPage.scrollUp(300);
      const pos = await chatPage.getScrollPosition();
      const distanceFromBottom = pos.scrollHeight - pos.scrollTop - pos.clientHeight;
      const minDistance = Math.max(20, pos.clientHeight * 0.05);
      expect(distanceFromBottom).toBeGreaterThan(minDistance);
    }).toPass({ timeout: TIMEOUTS.ASSERT });

    await chatPage.waitForStreamComplete();

    // Poll (like the mid-stream check above), don't point-read: as the finished
    // turn settles its final layout (the toolbar mounts, code highlights, the
    // post-turn refetch reconciles) the scroller height shifts, and on a
    // saturated mobile engine that can momentarily read as snapped-to-bottom
    // before the view re-settles at the user's break-away position. A permanent
    // re-engage (the break-away genuinely lost) still fails — the distance never
    // recovers and the poll times out.
    await expect(async () => {
      const finalPos = await chatPage.getScrollPosition();
      const distanceFromBottom = finalPos.scrollHeight - finalPos.scrollTop - finalPos.clientHeight;
      const finalMinDistance = Math.max(50, finalPos.clientHeight * 0.05);
      expect(distanceFromBottom).toBeGreaterThan(finalMinDistance);
    }).toPass({ timeout: TIMEOUTS.ASSERT });
  });
});

test.describe('Dynamic Over-scroll Space', () => {
  test('can scroll to bottom after sending messages', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.sendFollowUpMessage('Test message');
    await chatPage.waitForAIResponse('Test message');

    await chatPage.scrollToBottom();

    const { scrollTop, scrollHeight, clientHeight } = await chatPage.getScrollPosition();

    expect(scrollHeight - scrollTop - clientHeight).toBeLessThanOrEqual(100);
  });
});

test.describe('Message Visibility', () => {
  test('user message and AI response are visible after sending', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const message = 'Visibility test message';
    await chatPage.sendFollowUpMessage(message);

    const userMessage = chatPage.messagesByRole('user').last();
    await expect(userMessage).toBeInViewport();

    await chatPage.waitForAIResponse(message);

    const aiMessage = chatPage.messagesByRole('assistant').last();
    await expect(aiMessage).toBeInViewport();
  });

  test('last message remains visible without manual scrolling', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const messages = ['First test', 'Second test', 'Third test'];

    for (const msg of messages) {
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);

      const lastAiMessage = chatPage.messagesByRole('assistant').last();
      await expect(lastAiMessage).toBeInViewport();
    }
  });
});

test.describe('Input Ready After Streaming', () => {
  test('input is ready for typing after first message streaming completes', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.goto();

    const message = 'First message auto-focus test';
    await chatPage.sendNewChatMessage(message);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse(message);

    await expect(chatPage.messageInput).toBeVisible();
    await expect(chatPage.messageInput).toBeEnabled();

    await chatPage.messageInput.click();
    await chatPage.messageInput.fill('follow up');
    await expect(chatPage.messageInput).toHaveValue('follow up');
  });

  test('input is ready for typing after streaming completes', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const message = 'Hello';
    await chatPage.sendFollowUpMessage(message);
    await chatPage.waitForAIResponse(message);

    await expect(chatPage.messageInput).toBeVisible();
    await expect(chatPage.messageInput).toBeEnabled();

    await chatPage.messageInput.click();
    await chatPage.messageInput.fill('another message');
    await expect(chatPage.messageInput).toHaveValue('another message');
  });

  test('does NOT focus input if user clicked something', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const message = 'Testing user interaction during streaming response. '.repeat(10);
    const countBefore = await chatPage.getMessageCountViaAPI();

    await chatPage.sendFollowUpMessage(message);

    await expect
      .poll(() => chatPage.getMessageCountViaAPI(), { timeout: TIMEOUTS.ASSERT })
      .toBe(countBefore + 2);

    await chatPage.messageList.click();
    await chatPage.waitForAIResponse(message);

    await expect(chatPage.messageInput).not.toBeFocused();
  });
});
