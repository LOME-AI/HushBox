import { test, expect } from '../fixtures.js';
import { unsettledExpect } from '../helpers/settled-expect.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { searchAndSelectMember } from '../helpers/add-member.js';

test.describe('Auth Member Access', () => {
  test('read member lifecycle: history access, removal, no-history re-add, privilege elevation', async ({
    authenticatedPage,
    testDavePage,
    groupConversation,
  }) => {
    test.slow();

    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    // ── Goal A: read+history member sees all messages, cannot send ──

    await test.step('add Dave as read+history member', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await searchAndSelectMember(authenticatedPage, sidebar, 'test dave');

      // Set read privilege
      await authenticatedPage.getByTestId('add-member-privilege-select').selectOption('read');

      // Check history checkbox
      await authenticatedPage
        .getByTestId('add-member-history-checkbox')
        .getByRole('checkbox')
        .check();

      await authenticatedPage.getByTestId('add-member-submit-button').click();
      await expect(authenticatedPage.getByTestId('add-member-modal')).not.toBeVisible();
    });

    await test.step('Dave sees all messages and cannot send', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);
      await daveChatPage.waitForConversationLoaded();

      // Sees all history
      await daveChatPage.expectMessageVisible('Hello from Alice');
      await daveChatPage.expectMessageVisible('Hi from Bob');

      // Read privilege: send input should be disabled or hidden
      const sendInput = testDavePage.getByRole('textbox', { name: 'Ask me anything...' });
      const sendVisible = await sendInput.isVisible().catch(() => false);
      if (sendVisible) {
        // If visible, it should be disabled
        await expect(sendInput).toBeDisabled();
      }
    });

    // ── Goal B: remove, re-add without history, verify epoch isolation ──

    await test.step('remove Dave from conversation', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const daveMemberId = await sidebar.getMemberIdByUsername('test dave');
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickRemoveMember(daveMemberId);

      const modal = authenticatedPage.getByTestId('remove-member-modal');
      await expect(modal).toBeVisible();
      await authenticatedPage.getByTestId('remove-member-confirm').click();
      await unsettledExpect(modal).not.toBeVisible();

      await expect(sidebar.memberRow(daveMemberId)).not.toBeVisible();
    });

    await test.step('Dave loses access to conversation', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);

      // Dave should be redirected away or see an error
      await expect(testDavePage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: 10_000,
      });
    });

    await test.step('add Dave as read+no-history member', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await searchAndSelectMember(authenticatedPage, sidebar, 'test dave');

      // Set read privilege
      await authenticatedPage.getByTestId('add-member-privilege-select').selectOption('read');

      // Explicitly uncheck history (may retain state from previous modal use)
      await authenticatedPage
        .getByTestId('add-member-history-checkbox')
        .getByRole('checkbox')
        .uncheck();

      await authenticatedPage.getByTestId('add-member-submit-button').click();
      await expect(authenticatedPage.getByTestId('add-member-modal')).not.toBeVisible();

      // Verify Dave was actually added before proceeding
      await unsettledExpect(sidebar.findMemberByUsername('test dave')).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('Alice sends message in new epoch', async () => {
      const newMessage = `Post-rotation for Dave ${String(Date.now())}`;
      await aliceChatPage.sendFollowUpMessage(newMessage);
      await aliceChatPage.expectMessageVisible(newMessage);
    });

    await test.step('Dave sees only new messages, send is disabled', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);
      await daveChatPage.waitForConversationLoaded();

      // Should NOT see pre-rotation messages
      await expect(testDavePage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should see post-rotation message (decryption may lag behind fetch settlement)
      await unsettledExpect(testDavePage.getByText('Post-rotation for Dave').first()).toBeVisible({
        timeout: 10_000,
      });

      // Read privilege: send input should be disabled or hidden
      const sendInput = testDavePage.getByRole('textbox', { name: 'Ask me anything...' });
      const sendVisible = await sendInput.isVisible().catch(() => false);
      if (sendVisible) {
        await expect(sendInput).toBeDisabled();
      }
    });

    await test.step('promote Dave to admin — still sees only new messages but has admin controls', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const daveMemberId = await sidebar.getMemberIdByUsername('test dave');
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickChangePrivilege(daveMemberId, 'admin');
      await sidebar.expectMemberInSection(daveMemberId, 'admin');
    });

    await test.step('Dave as admin sees only new messages (no-history preserved)', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await testDavePage.reload();
      await daveChatPage.waitForConversationLoaded();

      // Still should NOT see pre-rotation messages (privilege change doesn't grant history)
      await expect(testDavePage.getByText('Hello from Alice', { exact: true })).not.toBeVisible();

      // Should still see post-rotation message (decryption may lag behind fetch settlement)
      await unsettledExpect(testDavePage.getByText('Post-rotation for Dave').first()).toBeVisible({
        timeout: 10_000,
      });
    });
  });
});
