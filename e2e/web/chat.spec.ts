import { test, expect } from '../fixtures.js';
import { ChatPage, SidebarPage } from '../pages';

test.describe('Chat Functionality', () => {
  test.describe('New Chat', () => {
    test('displays new chat page with greeting and input', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();
    });

    test('creates conversation when sending first message', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();

      const testMessage = `New chat test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await chatPage.waitForConversation();
      await chatPage.expectMessageVisible(testMessage);
    });

    test('receives AI response after creating new conversation', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();

      const testMessage = `New chat echo test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await chatPage.waitForConversation();

      await chatPage.waitForAIResponse();

      await chatPage.expectAssistantMessageContains('Echo:');
    });
  });

  test.describe('Existing Conversation', () => {
    test('displays existing conversation with messages', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;
      await expect(chatPage.messageInput).toBeVisible();

      // The fixture creates a message starting with "Fixture setup"
      await expect(chatPage.messageList).toBeVisible();
    });

    test('can send additional messages', async ({ authenticatedPage, testConversation }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;
      const followupMessage = `Follow-up ${String(Date.now())}`;

      await chatPage.sendFollowUpMessage(followupMessage);
      await chatPage.expectMessageVisible(followupMessage);
    });
    test('send button re-enables after streaming completes', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;

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
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;

      const testMessage = `Echo test ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(testMessage);

      await chatPage.waitForAIResponse(testMessage);

      await chatPage.expectAssistantMessageContains('Echo:');
    });
  });

  test.describe('Message Layout', () => {
    test('long unbroken strings do not push previous messages off screen', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;

      const firstMessage = chatPage.messageList.locator('[data-testid="message-item"]').first();
      const initialBoundingBox = await firstMessage.boundingBox();
      expect(initialBoundingBox).not.toBeNull();

      const longString = 'test'.repeat(200);
      await chatPage.sendFollowUpMessage(longString);

      await chatPage.waitForAIResponse(longString);

      const scrollWidth = await authenticatedPage.evaluate(
        () => document.documentElement.scrollWidth
      );
      const clientWidth = await authenticatedPage.evaluate(
        () => document.documentElement.clientWidth
      );
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      await expect(firstMessage).toBeAttached();

      await chatPage.scrollToTop();
      await expect(firstMessage).toBeInViewport({ ratio: 0.5 });
    });

    test('long messages wrap properly without horizontal overflow', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;

      const longString = 'a'.repeat(500);
      await chatPage.sendFollowUpMessage(longString);
      await chatPage.waitForAIResponse(longString);

      const overflowingElements = await authenticatedPage.evaluate(() => {
        const elements = document.querySelectorAll('*');
        const results: string[] = [];
        elements.forEach((el) => {
          const htmlEl = el as HTMLElement;
          const overflow = htmlEl.scrollWidth - htmlEl.clientWidth;
          // Only show elements with significant overflow (>100px) and meaningful dimensions
          // Skip: sr-only, truncate, overflow-hidden, or elements with zero width (invisible)
          if (
            overflow > 100 &&
            htmlEl.clientWidth > 0 &&
            !htmlEl.className.includes('sr-only') &&
            !htmlEl.className.includes('truncate') &&
            !htmlEl.className.includes('overflow-hidden')
          ) {
            const tag = htmlEl.tagName.toLowerCase();
            const id = htmlEl.id ? `#${htmlEl.id}` : '';
            const cls = htmlEl.className ? `.${htmlEl.className.replace(/\s+/g, '.')}` : '';
            const testId = htmlEl.dataset.testid ? `[data-testid="${htmlEl.dataset.testid}"]` : '';
            const slot = htmlEl.dataset.slot ? `[data-slot="${htmlEl.dataset.slot}"]` : '';
            results.push(
              `${tag}${id}${testId}${slot} overflow:${String(overflow)} scrollW:${String(htmlEl.scrollWidth)} clientW:${String(htmlEl.clientWidth)}\n  classes: ${cls.substring(0, 200)}`
            );
          }
        });
        return results;
      });
      if (overflowingElements.length > 0) {
        console.log('\n=== OVERFLOWING ELEMENTS (>100px overflow) ===');
        overflowingElements.forEach((el) => {
          console.log(el);
        });
        console.log('=== END OVERFLOWING ELEMENTS ===\n');
      }

      expect(
        overflowingElements.length,
        `Found ${String(overflowingElements.length)} overflowing elements:\n${overflowingElements.join('\n')}`
      ).toBe(0);

      const messageItem = chatPage.messageList.locator('[data-testid="message-item"]').last();
      await expect(messageItem).toBeVisible();
      const messageBox = await messageItem.boundingBox();

      const viewportWidth = await authenticatedPage.evaluate(() => window.innerWidth);

      if (messageBox) {
        expect(messageBox.width).toBeLessThanOrEqual(viewportWidth);
        expect(messageBox.x + messageBox.width).toBeLessThanOrEqual(viewportWidth);
      }
    });
  });
});
