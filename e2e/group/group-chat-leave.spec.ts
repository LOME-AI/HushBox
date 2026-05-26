import { test, expect, unsettledExpect } from '../fixtures.js';
import { setupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { ChatPage, MemberSidebarPage, SidebarPage } from '../pages/index.js';

test.describe('Group Chat Leave', () => {
  // Each test is destructive (leaving a conversation), so each gets its own groupConversation fixture
  test('non-owner leave navigates to /chat', async ({ testBobPage, groupConversation }) => {
    // Verify message visibility BEFORE opening sidebar — on mobile the sidebar
    // is a modal Sheet that covers the chat, making messages invisible.
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
      await testBobPage.goto(`/chat/${groupConversation.id}`, { waitUntil: 'domcontentloaded' });
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
    const { sidebar } = await setupConversationWithSidebar(authenticatedPage, groupConversation.id);

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
      await authenticatedPage.goto(`/chat/${groupConversation.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(authenticatedPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: 10_000,
      });
    });
  });

  test('non-owner leave from sidebar dropdown rotates epoch and navigates', async ({
    testBobPage,
    groupConversation,
  }) => {
    // Sidebar's per-conversation Leave action shares the same rotation code
    // path as the member-sidebar Leave — both go through `leaveConversation()`
    // in lib/leave-conversation.ts. Regression target: before the unification
    // this path called `mutate({ conversationId })` without rotation and the
    // server returned 400 ROTATION_REQUIRED.
    const chatPage = new ChatPage(testBobPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectMessageVisible('Hello from Alice');

    const sidebar = new SidebarPage(testBobPage);
    await sidebar.openMoreMenu(groupConversation.id);
    await testBobPage.getByRole('menuitem', { name: 'Leave' }).click();

    const modal = testBobPage.getByTestId('leave-confirmation-modal');
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId('leave-confirmation-confirm').click();

    // Leaving the active conversation redirects to /chat.
    await expect(testBobPage).toHaveURL('/chat', { timeout: 10_000 });

    // The leaving user can no longer open the conversation.
    await testBobPage.goto(`/chat/${groupConversation.id}`, { waitUntil: 'domcontentloaded' });
    await expect(testBobPage).not.toHaveURL(new RegExp(groupConversation.id), {
      timeout: 10_000,
    });
  });

  test('leave from sidebar of a non-active chat leaves URL unchanged', async ({
    testBobPage,
    groupConversation,
  }) => {
    // Bob lands on /chat (no conversation active) and leaves the group from the
    // sidebar dropdown. The URL must NOT change to /chat — only the active
    // chat's Leave should redirect.
    await testBobPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await testBobPage.locator('[data-app-stable="true"]').waitFor({ state: 'visible' });

    const sidebar = new SidebarPage(testBobPage);
    await sidebar.openMoreMenu(groupConversation.id);
    await testBobPage.getByRole('menuitem', { name: 'Leave' }).click();

    const modal = testBobPage.getByTestId('leave-confirmation-modal');
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId('leave-confirmation-confirm').click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // URL stays at /chat (the listing dashboard) — no forced redirect.
    await expect(testBobPage).toHaveURL('/chat');

    // And the conversation is gone from Bob's sidebar.
    await expect(sidebar.getChatLink(groupConversation.id)).not.toBeVisible({ timeout: 10_000 });
  });

  test('cancel leave keeps user in conversation', async ({ testBobPage, groupConversation }) => {
    // Verify message visibility BEFORE opening sidebar — on mobile the sidebar
    // is a modal Sheet that covers the chat, making messages invisible.
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

    await testBobPage.getByTestId('leave-confirmation-cancel').click();
    // Radix Dialog close is CSS-animation only; the settled-aware `expect`
    // can short-circuit on slow webkit before the animation completes.
    await unsettledExpect(modal).not.toBeVisible({ timeout: 5_000 });

    // Close sidebar so message list is accessible on mobile
    await sidebar.closeSidebar();

    await expect(testBobPage).toHaveURL(new RegExp(groupConversation.id));
    await chatPage.assertMessageVisible('Hello from Alice');
  });
});
