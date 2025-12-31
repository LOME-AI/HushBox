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

      // Wait for navigation to the new conversation
      await chatPage.waitForConversation();

      // Wait for AI response to stream (mock client echoes back)
      await chatPage.waitForAIResponse();

      // Verify AI response contains echoed message
      await chatPage.expectAssistantMessageContains('Echo:');
    });
  });

  test.describe('Existing Conversation', () => {
    test('displays existing conversation with messages', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation; // Fixture creates conversation and navigates to it
      // Verify the message input is visible
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
  });

  test.describe('Sidebar Actions', () => {
    // Run sidebar tests serially to prevent race conditions
    // Multiple parallel tests modifying the same sidebar causes flakiness
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

      // Should navigate back to /chat (new chat page)
      await expect(authenticatedPage).toHaveURL('/chat');
      await chatPage.expectNewChatPageVisible();
    });

    test('can cancel delete confirmation', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.cancelDelete(testConversation.id);

      // Should still be on the same URL
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

      // Wait for streaming to complete (mock client has 20ms delay per char)
      await chatPage.waitForAIResponse();

      // Verify AI response contains echoed message (mock returns "Echo: {message}")
      await chatPage.expectAssistantMessageContains('Echo:');
    });

    test('shows streaming indicator while response is being generated', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      void testConversation;

      await chatPage.sendFollowUpMessage('Hello');

      // Either streaming indicator appears OR response already rendered (streaming too fast)
      await expect(
        chatPage.streamingMessage.or(chatPage.messageList.getByText(/^Echo:/).first()).first()
      ).toBeVisible({ timeout: 5000 });
    });
  });
});
