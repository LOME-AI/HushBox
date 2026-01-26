import { test, expect } from '../fixtures.js';
import { ChatPage, SidebarPage } from '../pages';

test.describe('Chat Functionality', () => {
  test.describe('New Chat', () => {
    test('displays UI, creates conversation, receives response, appears once in sidebar', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const sidebar = new SidebarPage(authenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();

      const uniqueId = `combined-new-${String(Date.now())}`;
      const testMessage = `Test ${uniqueId}`;
      await chatPage.sendNewChatMessage(testMessage);

      await chatPage.waitForConversation();
      await chatPage.expectMessageVisible(testMessage);

      await chatPage.waitForAIResponse();
      await chatPage.expectAssistantMessageContains('Echo:');

      await authenticatedPage.waitForTimeout(1000);

      const matchingCount = await sidebar.countConversationsWithText(uniqueId);
      expect(matchingCount).toBe(1);
    });
  });

  test.describe('Existing Conversation', () => {
    test('displays messages and accepts followup', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageList).toBeVisible();

      const followupMessage = `Follow-up ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(followupMessage);
      await chatPage.expectMessageVisible(followupMessage);
    });

    test('send button re-enables after streaming completes', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      // Send first message
      const firstMessage = `First followup ${String(Date.now())}`;
      await chatPage.messageInput.fill(firstMessage);

      // Verify button is enabled after filling text
      await expect(chatPage.sendButton).toBeEnabled();
      await chatPage.sendButton.click();

      // Wait for message to appear and AI to respond
      await chatPage.expectMessageVisible(firstMessage);
      await chatPage.waitForAIResponse(firstMessage);

      // Send second message to confirm button works
      const secondMessage = `Second followup ${String(Date.now())}`;
      await chatPage.messageInput.fill(secondMessage);
      await chatPage.sendButton.click();

      // Verify second message works
      await chatPage.expectMessageVisible(secondMessage);
      await chatPage.waitForAIResponse(secondMessage);
      // Button is disabled after streaming when input is empty (correct behavior)
    });
  });

  test.describe('Sidebar Actions', () => {
    test.describe.configure({ mode: 'serial' });

    test('shows conversation in sidebar', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);
      await sidebar.expectConversationVisible(testConversation.id);
    });

    test('can rename conversation via dropdown menu', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.renameConversation(testConversation.id, 'My Renamed Conversation');
      await sidebar.expectConversationTitle(testConversation.id, 'My Renamed Conversation');
    });

    test('can delete conversation via dropdown menu', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.deleteConversation(testConversation.id);

      await expect(authenticatedPage).toHaveURL('/chat');
      await chatPage.expectNewChatPageVisible();
    });

    test('can cancel delete confirmation', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.cancelDelete(testConversation.id);

      await expect(authenticatedPage).toHaveURL(testConversation.url);
    });
  });

  test.describe('AI Response Streaming', () => {
    test('displays streaming AI response after sending message', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const testMessage = `Echo test ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(testMessage);

      await chatPage.waitForAIResponse(testMessage);

      await chatPage.expectAssistantMessageContains('Echo:');
    });
  });

  test.describe('Message Layout', () => {
    test('long unbroken strings do not push previous messages off screen', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const firstMessage = chatPage.messageList.locator('[data-testid="message-item"]').first();
      const initialBoundingBox = await firstMessage.boundingBox();
      expect(initialBoundingBox).not.toBeNull();

      const longString = 'test'.repeat(50);
      await chatPage.sendFollowUpMessage(longString);

      await chatPage.waitForAIResponse(longString);

      const { scrollWidth, clientWidth } = await chatPage.getDocumentDimensions();
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      await expect(firstMessage).toBeAttached();

      await chatPage.scrollToTop();
      await expect(firstMessage).toBeInViewport({ ratio: 0.5 });
    });

    test('long messages wrap properly without horizontal overflow', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }, testInfo) => {
      const chatPage = new ChatPage(authenticatedPage);

      const longString = 'a'.repeat(500);
      await chatPage.sendFollowUpMessage(longString);
      await chatPage.waitForAIResponse(longString);

      const overflowingElements = await chatPage.findOverflowingElements();
      if (overflowingElements.length > 0) {
        await testInfo.attach('overflowing-elements', {
          body: JSON.stringify(overflowingElements, null, 2),
          contentType: 'application/json',
        });
      }

      expect(
        overflowingElements.length,
        `Found ${String(overflowingElements.length)} overflowing elements:\n${overflowingElements.join('\n')}`
      ).toBe(0);

      const messageItem = chatPage.messageList.locator('[data-testid="message-item"]').last();
      await expect(messageItem).toBeVisible();
      const [messageBox, viewportWidth] = await Promise.all([
        messageItem.boundingBox(),
        chatPage.getViewportWidth(),
      ]);

      if (messageBox) {
        expect(messageBox.width).toBeLessThanOrEqual(viewportWidth);
        expect(messageBox.x + messageBox.width).toBeLessThanOrEqual(viewportWidth);
      }
    });
  });
});
