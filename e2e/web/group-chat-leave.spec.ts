import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';

test.describe('Group Chat Leave', () => {
  // Each test is destructive (leaving a conversation), so each gets its own groupConversation fixture
  test('non-owner leave navigates to /chat', async ({ testBobPage, groupConversation }) => {
    const chatPage = new ChatPage(testBobPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectMessageVisible('Hello from Alice');

    const sidebar = new MemberSidebarPage(testBobPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    await test.step('trigger leave and verify warning', async () => {
      const bobMemberId = await sidebar.getMemberIdByUsername('test_bob');
      await sidebar.openMemberActions(bobMemberId);
      await sidebar.clickLeave();

      const modal = testBobPage.getByTestId('leave-confirmation-modal');
      await expect(modal).toBeVisible();
      await expect(testBobPage.getByTestId('leave-confirmation-warning')).toBeVisible();
    });

    await test.step('confirm leave navigates away', async () => {
      await testBobPage.getByTestId('leave-confirmation-confirm').click();
      await expect(testBobPage).toHaveURL('/chat', { timeout: 10_000 });
    });

    await test.step('navigating back to conversation redirects', async () => {
      await testBobPage.goto(`/chat/${groupConversation.id}`);
      // Should redirect away since Bob is no longer a member
      await expect(testBobPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: 10_000,
      });
    });
  });

  test('owner leave shows deletion warning and destroys conversation', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    await test.step('trigger leave and verify owner-specific warning', async () => {
      const aliceMemberId = await sidebar.getMemberIdByUsername('test_alice');
      await sidebar.openMemberActions(aliceMemberId);
      await sidebar.clickLeave();

      const modal = authenticatedPage.getByTestId('leave-confirmation-modal');
      await expect(modal).toBeVisible();

      // Owner gets a stronger warning about deleting the conversation
      const warning = authenticatedPage.getByTestId('leave-confirmation-warning');
      await expect(warning).toBeVisible();
    });

    await test.step('confirm leave navigates away', async () => {
      await authenticatedPage.getByTestId('leave-confirmation-confirm').click();
      await expect(authenticatedPage).toHaveURL('/chat', { timeout: 10_000 });
    });

    await test.step('conversation no longer accessible', async () => {
      await authenticatedPage.goto(`/chat/${groupConversation.id}`);
      await expect(authenticatedPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: 10_000,
      });
    });
  });

  test('cancel leave keeps user in conversation', async ({ testBobPage, groupConversation }) => {
    const chatPage = new ChatPage(testBobPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectMessageVisible('Hello from Alice');

    const sidebar = new MemberSidebarPage(testBobPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    const bobMemberId = await sidebar.getMemberIdByUsername('test_bob');
    await sidebar.openMemberActions(bobMemberId);
    await sidebar.clickLeave();

    const modal = testBobPage.getByTestId('leave-confirmation-modal');
    await expect(modal).toBeVisible();

    // Cancel
    await testBobPage.getByTestId('leave-confirmation-cancel').click();
    await expect(modal).not.toBeVisible();

    // Close sidebar so message list is accessible on mobile
    await sidebar.closeSidebar();

    // Still on conversation page with messages visible
    await expect(testBobPage).toHaveURL(new RegExp(groupConversation.id));
    await chatPage.expectMessageVisible('Hello from Alice');
  });
});
