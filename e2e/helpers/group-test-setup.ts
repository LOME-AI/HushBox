import { type Page, type APIRequestContext } from '@playwright/test';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper } from './budget.js';

export interface GroupTestContext {
  chatPage: ChatPage;
  sidebar: MemberSidebarPage;
  helper: BudgetHelper;
}

export interface ConversationWithSidebarContext {
  chatPage: ChatPage;
  sidebar: MemberSidebarPage;
}

export async function setupConversationWithSidebar(
  page: Page,
  conversationId: string
): Promise<ConversationWithSidebarContext> {
  const chatPage = new ChatPage(page);

  await chatPage.gotoConversation(conversationId);
  await chatPage.waitForConversationLoaded();

  const sidebar = new MemberSidebarPage(page);
  await sidebar.openViaFacepile();
  await sidebar.waitForLoaded();

  return { chatPage, sidebar };
}

/**
 * Navigates to a group conversation, waits for it to load, and opens the member sidebar.
 * Common setup shared across link-guest-access, auth-using-link, and other group chat tests.
 */
export async function setupGroupConversationWithSidebar(
  authenticatedPage: Page,
  authenticatedRequest: APIRequestContext,
  conversationId: string
): Promise<GroupTestContext> {
  const { chatPage, sidebar } = await setupConversationWithSidebar(
    authenticatedPage,
    conversationId
  );
  const helper = new BudgetHelper(authenticatedRequest);

  return { chatPage, sidebar, helper };
}
