import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { setupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { ChatPage, MemberSidebarPage, SidebarPage } from '../pages/index.js';
import { waitForAppStable } from '../helpers/page-signals.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Group Chat Leave', () => {
  // Each test is destructive (leaving a conversation), so each gets its own groupConversation fixture
  test('non-owner leave navigates to /chat', async ({ testBobPage, groupConversation }) => {
    // Deliberate: after Bob leaves and navigates back to the conversation
    // URL, the router prefetches per-conversation resources Bob has now
    // lost access to — each returns 404 CONVERSATION_NOT_FOUND.
    expectApiErrors(testBobPage, [
      /404 Not Found GET .*\/api\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
      /"code":"CONVERSATION_NOT_FOUND"/,
    ]);
    expectConsoleErrors(testBobPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
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

      const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
      await expect(modal).toBeVisible();
      await expect(testBobPage.getByTestId(TEST_IDS.leaveConfirmationWarning)).toBeVisible();
    });

    await test.step('confirm leave navigates away', async () => {
      await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
      await expect(testBobPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    await test.step('navigating back to conversation redirects', async () => {
      // `commit`, not `domcontentloaded`: the access guard client-redirects a
      // non-member to /chat, which interrupts a longer wait ("interrupted by
      // another navigation"). Resolving at commit lands before the redirect; the
      // assertion below is what proves Bob was bounced.
      await testBobPage.goto(`/chat/${groupConversation.id}`, { waitUntil: 'commit' });
      // Should redirect away since Bob is no longer a member
      await expect(testBobPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: TIMEOUTS.ROUTE,
      });
    });
  });

  test('owner leave shows deletion warning and destroys conversation', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    test.slow();
    // Deliberate: after the owner leaves, the conversation is destroyed.
    // The post-leave `goto` then prefetches resources that no longer
    // exist for anyone — each returns 404 CONVERSATION_NOT_FOUND.
    expectApiErrors(authenticatedPage, [
      /404 Not Found GET .*\/api\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
      /"code":"CONVERSATION_NOT_FOUND"/,
    ]);
    expectConsoleErrors(authenticatedPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
    const { sidebar } = await setupConversationWithSidebar(authenticatedPage, groupConversation.id);

    await test.step('trigger leave and verify owner-specific warning', async () => {
      const aliceMemberId = await sidebar.getMemberIdByUsername('test_alice');
      await sidebar.openMemberActions(aliceMemberId);
      await sidebar.clickLeave();

      const modal = authenticatedPage.getByTestId(TEST_IDS.leaveConfirmationModal);
      await expect(modal).toBeVisible();

      // Owner gets a stronger warning about deleting the conversation
      const warning = authenticatedPage.getByTestId(TEST_IDS.leaveConfirmationWarning);
      await expect(warning).toBeVisible();
    });

    await test.step('confirm leave navigates away', async () => {
      await authenticatedPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
      await expect(authenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    await test.step('conversation no longer accessible', async () => {
      // `commit` so the post-destroy redirect to /chat can't interrupt the
      // navigation wait; the assertion below proves the conversation is gone.
      await authenticatedPage.goto(`/chat/${groupConversation.id}`, {
        waitUntil: 'commit',
      });
      await expect(authenticatedPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: TIMEOUTS.ROUTE,
      });
    });
  });

  test('non-owner leave from sidebar dropdown rotates epoch and navigates', async ({
    testBobPage,
    groupConversation,
  }) => {
    // Deliberate: after Bob leaves and `goto`s back to the conversation,
    // the prefetch for per-conversation resources he can no longer access
    // returns 404 CONVERSATION_NOT_FOUND for each.
    expectApiErrors(testBobPage, [
      /404 Not Found GET .*\/api\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
      /"code":"CONVERSATION_NOT_FOUND"/,
    ]);
    expectConsoleErrors(testBobPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
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

    const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();

    // Leaving the active conversation redirects to /chat.
    await expect(testBobPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });

    // The leaving user can no longer open the conversation. `commit` lands
    // before the non-member redirect to /chat that would otherwise interrupt the
    // navigation wait; the assertion below proves Bob was bounced.
    await testBobPage.goto(`/chat/${groupConversation.id}`, { waitUntil: 'commit' });
    await expect(testBobPage).not.toHaveURL(new RegExp(groupConversation.id), {
      timeout: TIMEOUTS.ROUTE,
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
    await waitForAppStable(testBobPage);

    const sidebar = new SidebarPage(testBobPage);
    await sidebar.openMoreMenu(groupConversation.id);
    await testBobPage.getByRole('menuitem', { name: 'Leave' }).click();

    const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

    // URL stays at /chat (the listing dashboard) — no forced redirect.
    await expect(testBobPage).toHaveURL('/chat');

    // And the conversation is gone from Bob's sidebar.
    await expect(sidebar.getChatLink(groupConversation.id)).not.toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
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

    const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId(TEST_IDS.leaveConfirmationCancel).click();
    // Radix Dialog close is CSS-animation only; give it the modal budget to
    // finish unmounting on slow webkit.
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

    // Close sidebar so message list is accessible on mobile
    await sidebar.closeSidebar();

    await expect(testBobPage).toHaveURL(new RegExp(groupConversation.id));
    await chatPage.assertMessageVisible('Hello from Alice');
  });
});
