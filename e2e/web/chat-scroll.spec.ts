import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

test.describe('Auto-scroll During Streaming', () => {
  test('auto-scrolls when user is at bottom', async ({ authenticatedPage, testConversation }) => {
    const chatPage = new ChatPage(authenticatedPage);
    void testConversation;

    const message = 'Echo long response test';
    // User is at bottom (just loaded conversation)
    await chatPage.sendFollowUpMessage(message);

    // Wait for streaming to complete (must specify message to distinguish from fixture's Echo)
    await chatPage.waitForAIResponse(message);

    // Verify we're still at bottom (within threshold)
    const { scrollTop, scrollHeight, clientHeight } = await chatPage.getScrollPosition();
    expect(scrollHeight - scrollTop - clientHeight).toBeLessThanOrEqual(50);
  });

  test('does NOT auto-scroll when user scrolled up', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    void testConversation;

    // Scroll to top before sending
    await chatPage.scrollToTop();
    const beforePos = await chatPage.getScrollPosition();

    const message = 'Hello';
    await chatPage.sendFollowUpMessage(message);
    await chatPage.waitForAIResponse(message);

    // Should still be near top (not scrolled down automatically)
    const afterPos = await chatPage.getScrollPosition();
    expect(afterPos.scrollTop).toBeLessThanOrEqual(beforePos.scrollTop + 50);
  });

  // This test verifies the scroll direction detection logic works correctly.
  // The "glue effect" fix uses scroll direction to detect user intent - when scrollTop
  // decreases, auto-scroll is disabled even if a pending RAF would pull user back.
  // A single scroll event should be enough to break away from auto-scroll.
  test('single scroll during streaming breaks away from bottom', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    void testConversation;

    // First, build up enough content to create a scrollable area
    // Send several messages to ensure content exceeds viewport height on ALL devices
    // (iPad Pro 11 has a larger viewport than phones, so we need more messages)
    const setupMessages = [
      'Building scrollable content - message one with enough text to add height',
      'Building scrollable content - message two with enough text to add height',
      'Building scrollable content - message three with enough text to add height',
      'Building scrollable content - message four with enough text to add height',
      'Building scrollable content - message five with enough text to add height',
    ];

    for (const msg of setupMessages) {
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
    }

    // Verify we now have scrollable content
    const initialPos = await chatPage.getScrollPosition();
    expect(initialPos.scrollHeight).toBeGreaterThan(initialPos.clientHeight);

    // Now send the test message - use a long message to ensure streaming takes several seconds
    // Mock streams at 10ms/char, so ~500 chars = ~5 seconds of streaming
    const testMessage = 'Testing scroll behavior during streaming. '.repeat(12);

    // Count "Echo:" texts before sending (fixture + 5 setup messages = 6 total)
    const echoCountBefore = await chatPage.messageList.getByText('Echo:').count();

    await chatPage.sendFollowUpMessage(testMessage);

    // Wait for streaming to START - a new "Echo:" appears when AI response begins streaming
    await expect(chatPage.messageList.getByText('Echo:')).toHaveCount(echoCountBefore + 1, {
      timeout: 10000,
    });

    // Scroll up while streaming is active - single scroll should break away
    await chatPage.scrollUp(150);

    // Wait for streaming to complete
    await chatPage.waitForAIResponse(testMessage);

    // Allow any pending RAFs to complete
    await authenticatedPage.waitForTimeout(100);

    // Assert: user should NOT be at bottom (broke away from auto-scroll)
    const finalPos = await chatPage.getScrollPosition();
    const distanceFromBottom = finalPos.scrollHeight - finalPos.scrollTop - finalPos.clientHeight;
    expect(distanceFromBottom).toBeGreaterThan(50);
  });
});

test.describe('Input Ready After Streaming', () => {
  test('input is ready for typing after first message streaming completes', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    // Start on /chat (new chat page)
    await chatPage.goto();

    // Send first message - this navigates to /chat/new then to /chat/{id}
    const message = 'First message auto-focus test';
    await chatPage.sendNewChatMessage(message);

    // Wait for navigation to conversation page
    await chatPage.waitForConversation();

    // Wait for AI response to complete
    await chatPage.waitForAIResponse(message);

    // Verify input is visible and enabled after streaming completes
    await expect(chatPage.messageInput).toBeVisible();
    await expect(chatPage.messageInput).toBeEnabled();

    // Verify user can type (click to focus, then type)
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill('follow up');
    await expect(chatPage.messageInput).toHaveValue('follow up');
  });

  test('input is ready for typing after streaming completes', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    void testConversation;

    const message = 'Hello';
    await chatPage.sendFollowUpMessage(message);
    await chatPage.waitForAIResponse(message);

    // Verify input is visible and enabled after streaming completes
    await expect(chatPage.messageInput).toBeVisible();
    await expect(chatPage.messageInput).toBeEnabled();

    // Verify user can type (click to focus, then type)
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill('another message');
    await expect(chatPage.messageInput).toHaveValue('another message');
  });

  test('does NOT focus input if user clicked something', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    void testConversation;

    // Use a long message so streaming takes enough time to click during it
    // Mock streams at 10ms/char, so ~500 chars = ~5 seconds of streaming time
    const message = 'Testing user interaction during streaming response. '.repeat(10);

    // Count "Echo:" texts before sending (fixture has 1)
    const echoCountBefore = await chatPage.messageList.getByText('Echo:').count();

    await chatPage.sendFollowUpMessage(message);

    // Wait for streaming to START - a new "Echo:" appears when AI response begins streaming
    await expect(chatPage.messageList.getByText('Echo:')).toHaveCount(echoCountBefore + 1, {
      timeout: 10000,
    });

    // Click on the message list while streaming (more reliable than clicking body on mobile)
    await chatPage.messageList.click();

    await chatPage.waitForAIResponse(message);
    await authenticatedPage.waitForTimeout(200);

    // Input should NOT be focused (user interacted)
    await expect(chatPage.messageInput).not.toBeFocused();
  });
});
