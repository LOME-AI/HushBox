import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

test.describe('Auto-scroll During Streaming', () => {
  test('auto-scrolls to bottom in all scenarios', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const message = 'Echo long response test';
    await chatPage.sendFollowUpMessage(message);
    await chatPage.waitForAIResponse(message);

    const pos1 = await chatPage.getScrollPosition();
    expect(pos1.scrollHeight - pos1.scrollTop - pos1.clientHeight).toBeLessThanOrEqual(100);

    const followUp = 'Second message to verify auto-scroll stays on';
    await chatPage.sendFollowUpMessage(followUp);
    await chatPage.waitForAIResponse(followUp);

    const finalPos1 = await chatPage.getScrollPosition();
    expect(
      finalPos1.scrollHeight - finalPos1.scrollTop - finalPos1.clientHeight
    ).toBeLessThanOrEqual(100);

    await chatPage.scrollToTop();

    const message2 = 'Hello after scroll up';
    await chatPage.sendFollowUpMessage(message2);
    await chatPage.waitForAIResponse(message2);

    const afterPos = await chatPage.getScrollPosition();
    expect(afterPos.scrollHeight - afterPos.scrollTop - afterPos.clientHeight).toBeLessThanOrEqual(
      100
    );
  });

  test('single scroll during streaming breaks away from bottom', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
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

    // ~5 seconds at 10ms/char
    const testMessage = 'Testing scroll behavior during streaming. '.repeat(10);

    await chatPage.sendFollowUpMessage(testMessage);

    await expect(
      chatPage.messageList
        .locator('[data-role="assistant"]')
        .getByText('Testing scroll', { exact: false })
    ).toBeVisible({ timeout: 10_000 });

    await chatPage.scrollUp(300);

    await authenticatedPage.waitForTimeout(1000);

    const midStreamPos = await chatPage.getScrollPosition();
    const midStreamDistance =
      midStreamPos.scrollHeight - midStreamPos.scrollTop - midStreamPos.clientHeight;
    expect(midStreamDistance).toBeGreaterThan(100);

    await authenticatedPage.waitForTimeout(2000);

    const finalPos = await chatPage.getScrollPosition();
    const distanceFromBottom = finalPos.scrollHeight - finalPos.scrollTop - finalPos.clientHeight;
    expect(distanceFromBottom).toBeGreaterThan(50);
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
    await authenticatedPage.waitForTimeout(100);

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

    const userMessage = chatPage.page.locator('[data-role="user"]').last();
    await expect(userMessage).toBeInViewport();

    await chatPage.waitForAIResponse(message);

    const aiMessage = chatPage.page.locator('[data-role="assistant"]').last();
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

      const lastAiMessage = chatPage.page.locator('[data-role="assistant"]').last();
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

    // ~5 seconds at 10ms/char
    const message = 'Testing user interaction during streaming response. '.repeat(10);
    const echoCountBefore = await chatPage.messageList.getByText('Echo:').count();

    await chatPage.sendFollowUpMessage(message);

    await expect(chatPage.messageList.getByText('Echo:')).toHaveCount(echoCountBefore + 1, {
      timeout: 10_000,
    });

    await chatPage.messageList.click();
    await chatPage.waitForAIResponse(message);
    await authenticatedPage.waitForTimeout(200);

    await expect(chatPage.messageInput).not.toBeFocused();
  });
});
