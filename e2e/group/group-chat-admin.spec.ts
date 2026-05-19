import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { searchAndSelectMember } from '../helpers/add-member.js';
import { expectAccessRevoked } from '../helpers/member-actions.js';
import { closeOverlay } from '../helpers/overlay.js';
import { personaEmail } from '../helpers/personas.js';

test.describe('Group Chat Admin', () => {
  test.describe.configure({ mode: 'serial' });

  test('displays sender labels, groups consecutive messages, and AI toggle works', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // 6 steps with multiple page navigations + AI response
    test.slow();

    const bobMember = groupConversation.members.find((m) => m.email === personaEmail('test-bob'));
    const aliceMember = groupConversation.members.find(
      (m) => m.email === personaEmail('test-alice')
    );

    await test.step('Alice sees correct sender labels', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();
      await aliceChatPage.expectMessageVisible('Hello from Alice');

      // Park the first row at the top so `.first()` refers to Alice's first
      // message rather than whichever message Virtuoso happens to keep in
      // the DOM after `expectMessageVisible` finishes scrolling.
      await aliceChatPage.scrollMessageIntoView(0);
      const aliceLabels = aliceChatPage.getSenderLabels();
      await expect(aliceLabels.first()).toHaveText('You');

      await expect(aliceLabels.getByText(bobMember!.username)).toBeVisible();

      const aiMessage = aliceChatPage.messageList.locator('[data-role="assistant"]').first();
      await expect(aiMessage).toBeVisible();
      const aiLabels = aiMessage.locator('[data-testid="sender-label"]');
      await expect(aiLabels).toHaveCount(0);
    });

    await test.step('consecutive messages are grouped', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      // Messages #4 and #5 ("Alice replies" + "Summarize this") are consecutive
      // from Alice and should be grouped into a single message-item.
      // Park the grouped row in view first — the chat mounts at the latest
      // message, so middle-of-conversation rows can be virtualized out.
      await aliceChatPage.scrollMessageIntoView(3);
      const aliceGroup = aliceChatPage.getMessageGroups().filter({ hasText: 'Alice replies' });
      await expect(aliceGroup.getByText('Alice replies')).toBeVisible();
      await expect(aliceGroup.getByText('Summarize this')).toBeVisible();
    });

    await test.step('Bob sees inverted sender labels', async () => {
      const bobChatPage = new ChatPage(testBobPage);
      await bobChatPage.gotoConversation(groupConversation.id);
      await bobChatPage.waitForConversationLoaded();
      await bobChatPage.expectMessageVisible('Hi from Bob');

      const bobLabels = bobChatPage.getSenderLabels();
      await expect(bobLabels.getByText('You')).toBeVisible();
      await expect(bobLabels.getByText(aliceMember!.username).first()).toBeVisible();
    });

    await test.step('1:1 chat has no sender labels or AI toggle', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      await aliceChatPage.goto();
      await aliceChatPage.sendNewChatMessage(`Solo test ${String(Date.now())}`);
      await aliceChatPage.waitForConversation();

      const senderLabels = aliceChatPage.getSenderLabels();
      await expect(senderLabels).toHaveCount(0);

      const aiToggle = aliceChatPage.getAiToggleButton();
      await expect(aiToggle).not.toBeVisible();
    });

    await test.step('AI toggle off: message appears without AI response', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();

      const aiToggle = aliceChatPage.getAiToggleButton();
      await expect(aiToggle).toBeVisible();
      await aiToggle.click();
      await expect(aiToggle).toHaveAccessibleName(/AI response off/);

      const humanMessage = `Human only ${String(Date.now())}`;
      await aliceChatPage.sendFollowUpMessage(humanMessage);
      await aliceChatPage.expectMessageVisible(humanMessage);

      const thinkingIndicator = aliceChatPage.messageList.locator(
        '[data-testid="thinking-indicator"]'
      );
      await expect(thinkingIndicator).not.toBeVisible();
    });

    await test.step('AI toggle on: triggers AI response with cost', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      const aiToggle = aliceChatPage.getAiToggleButton();
      await aiToggle.click();
      await expect(aiToggle).toHaveAccessibleName(/AI response on/);

      const aiMessage = `AI message ${String(Date.now())}`;
      await aliceChatPage.sendFollowUpMessage(aiMessage);
      await aliceChatPage.waitForAIResponse(aiMessage);
      await aliceChatPage.expectAssistantMessageContains('Echo:');
      await aliceChatPage.expectMessageCostVisible();
    });
  });

  test('member sidebar displays correctly with sections, badges, and search', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);

    await test.step('facepile opens sidebar', async () => {
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();
    });

    await test.step('member count is correct', async () => {
      await sidebar.expectMemberCount(2);
    });

    const aliceMember = groupConversation.members.find(
      (m) => m.email === personaEmail('test-alice')
    )!;
    const bobMember = groupConversation.members.find((m) => m.email === personaEmail('test-bob'))!;

    await test.step('privilege sections show correct members', async () => {
      await sidebar.expectSectionVisible('owner');
      await sidebar.expectSectionVisible('admin');
      await sidebar.findMemberByUsername(aliceMember.username).waitFor({ state: 'visible' });
      await sidebar.findMemberByUsername(bobMember.username).waitFor({ state: 'visible' });
    });

    let aliceMemberId: string;

    await test.step('current user has (you) badge', async () => {
      aliceMemberId = await sidebar.getMemberIdByUsername(aliceMember.username);
      await sidebar.expectYouBadge(aliceMemberId);
    });

    await test.step('online indicators visible for connected users', async () => {
      // Bob needs to be on the page too for online status
      const bobChatPage = new ChatPage(testBobPage);
      await bobChatPage.gotoConversation(groupConversation.id);
      await bobChatPage.waitForConversationLoaded();

      const bobMemberId = await sidebar.getMemberIdByUsername(bobMember.username);
      // Wait for WebSocket presence to propagate (online indicators appear asynchronously)
      await sidebar.expectOnlineIndicator(aliceMemberId);
      await sidebar.expectOnlineIndicator(bobMemberId);
    });

    await test.step('search filters members', async () => {
      await sidebar.searchMembers(bobMember.username);
      await expect(sidebar.findMemberByUsername(bobMember.username)).toBeVisible();
      await expect(sidebar.findMemberByUsername(aliceMember.username)).not.toBeVisible();

      await sidebar.clearSearch();
      await expect(sidebar.findMemberByUsername(aliceMember.username)).toBeVisible();
      await expect(sidebar.findMemberByUsername(bobMember.username)).toBeVisible();
    });

    await test.step('search with no results shows empty state', async () => {
      await sidebar.searchMembers('zzz-nonexistent-user-xyz');
      await expect(sidebar.findMemberByUsername(aliceMember.username)).not.toBeVisible();
      await expect(sidebar.findMemberByUsername(bobMember.username)).not.toBeVisible();

      await sidebar.clearSearch();
      await expect(sidebar.findMemberByUsername(aliceMember.username)).toBeVisible();
      await expect(sidebar.findMemberByUsername(bobMember.username)).toBeVisible();
    });

    await test.step('partial username match works', async () => {
      await sidebar.searchMembers('bob');
      await expect(sidebar.findMemberByUsername(bobMember.username)).toBeVisible();
      await expect(sidebar.findMemberByUsername(aliceMember.username)).not.toBeVisible();

      await sidebar.clearSearch();
    });

    await test.step('admin action buttons are visible', async () => {
      await expect(sidebar.newMemberButton).toBeVisible();
      await expect(sidebar.inviteLinkButton).toBeVisible();
    });
  });

  test('member lifecycle: add, change privilege, remove', async ({
    authenticatedPage,
    testDavePage,
    groupConversation,
  }) => {
    // Many steps with sidebar interactions + page navigations
    test.slow();

    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    await test.step('open add member modal and search for Dave', async () => {
      await searchAndSelectMember(authenticatedPage, sidebar, 'test dave');
    });

    await test.step('set privilege and history, submit', async () => {
      const privilegeSelect = authenticatedPage.getByTestId('add-member-privilege-select');
      await privilegeSelect.selectOption('write');

      const historyCheckbox = authenticatedPage.getByTestId('add-member-history-checkbox');
      await historyCheckbox.getByRole('checkbox').check();

      await authenticatedPage.getByTestId('add-member-submit-button').click();

      await unsettledExpect(authenticatedPage.getByTestId('add-member-modal')).not.toBeVisible();
    });

    await test.step('sidebar updates with new member', async () => {
      await sidebar.expectMemberCount(3);
      await sidebar.expectSectionVisible('write');
      await expect(sidebar.findMemberByUsername('test dave')).toBeVisible();
    });

    await test.step('Dave can access conversation and sees full history', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);
      await daveChatPage.waitForConversationLoaded();
      await daveChatPage.expectMessageVisible('Hello from Alice');
      await daveChatPage.expectMessageVisible('Hi from Bob');
    });

    const daveMemberId = await sidebar.getMemberIdByUsername('test dave');

    await test.step('change Dave to read privilege', async () => {
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickChangePrivilege(daveMemberId, 'read');

      await sidebar.expectMemberInSection(daveMemberId, 'read');
    });

    await test.step('verify privilege options and change Dave to admin', async () => {
      await sidebar.openMemberActions(daveMemberId);
      const changeTrigger = authenticatedPage.getByTestId(
        `member-change-privilege-${daveMemberId}`
      );
      await changeTrigger.click();

      const adminOption = authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-admin`);
      await expect(adminOption).toBeVisible();
      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-write`)
      ).toBeVisible();
      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-read`)
      ).toBeVisible();

      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-owner`)
      ).not.toBeVisible();

      // Click admin directly from open sub-menu (no close/reopen cycle)
      await adminOption.click();
      await sidebar.expectMemberInSection(daveMemberId, 'admin');
    });

    const bobMemberId = await sidebar.getMemberIdByUsername('test bob');

    await test.step('cancel remove keeps member', async () => {
      await sidebar.openMemberActions(bobMemberId);
      await sidebar.clickRemoveMember(bobMemberId);

      const modal = authenticatedPage.getByTestId('remove-member-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('remove-member-cancel').click();
      await unsettledExpect(modal).not.toBeVisible();

      await expect(sidebar.memberRow(bobMemberId)).toBeVisible();
    });

    await test.step('remove Dave with confirmation', async () => {
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickRemoveMember(daveMemberId);

      const modal = authenticatedPage.getByTestId('remove-member-modal');
      await expect(modal).toBeVisible();

      await expect(authenticatedPage.getByTestId('remove-member-warning')).toBeVisible();

      await authenticatedPage.getByTestId('remove-member-confirm').click();
      await expect(modal).not.toBeVisible();

      await expect(sidebar.memberRow(daveMemberId)).not.toBeVisible();
    });

    await test.step('Dave loses access to conversation', async () => {
      await expectAccessRevoked(testDavePage, groupConversation.id);
    });
  });

  test('invite link lifecycle: create, rename, change privilege, revoke', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let readLinkId: string;

    await test.step('create read-only invite link', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      await expect(authenticatedPage.getByTestId('invite-link-warning')).toBeVisible();

      await authenticatedPage.getByTestId('invite-link-name-input').fill('Guest Reader');

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      const url = await urlEl.textContent();
      expect(url).toContain('/share/c/');

      await expect(authenticatedPage.getByTestId('invite-link-copy-button')).toBeVisible();

      // Close modal via X button (Escape would also close the sidebar Sheet on tablet)
      await closeOverlay(authenticatedPage);
    });

    await test.step('read link appears in sidebar', async () => {
      const linkRow = sidebar.content
        .locator('[data-testid^="link-item-"]')
        .filter({ hasText: 'Guest Reader' });
      await expect(linkRow).toBeVisible();

      const testId = await linkRow.getAttribute('data-testid');
      readLinkId = testId!.replace('link-item-', '');
    });

    await test.step('create write invite link', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('invite-link-privilege-select').selectOption('write');

      await authenticatedPage.getByTestId('invite-link-name-input').fill('Guest Writer');
      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();

      // Close modal via X button (Escape would also close the sidebar Sheet on tablet)
      await closeOverlay(authenticatedPage);
    });

    await test.step('rename link', async () => {
      await sidebar.openLinkActions(readLinkId);
      await sidebar.clickChangeLinkName(readLinkId);
      await sidebar.editLinkNameInline(readLinkId, 'Renamed Guest');

      const linkRow = sidebar.linkRow(readLinkId);
      await expect(linkRow.getByText('Renamed Guest')).toBeVisible();
    });

    await test.step('change link privilege', async () => {
      await sidebar.openLinkActions(readLinkId);
      await sidebar.clickChangeLinkPrivilege(readLinkId, 'write');
      await expect(
        authenticatedPage.getByTestId('member-section-write').getByTestId(`link-item-${readLinkId}`)
      ).toBeVisible();
    });

    await test.step('revoke link with confirmation', async () => {
      await sidebar.openLinkActions(readLinkId);
      await sidebar.clickRevokeLinkAction(readLinkId);

      const modal = authenticatedPage.getByTestId('revoke-link-modal');
      await expect(modal).toBeVisible();

      const warning = authenticatedPage.getByTestId('revoke-link-warning');
      await expect(warning).toBeVisible();

      await authenticatedPage.getByTestId('revoke-link-confirm').click();

      await sidebar.expectLinkNotVisible(readLinkId);
    });
  });

  test('budget settings: owner editable, non-owner read-only', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    await test.step('owner sees editable budget modal', async () => {
      await sidebar.clickBudgetSettings();
      const modal = authenticatedPage.getByTestId('budget-settings-modal');
      await expect(modal).toBeVisible();

      await expect(authenticatedPage.getByTestId('budget-conversation-input')).toBeVisible();

      const saveButton = authenticatedPage.getByTestId('budget-save-button');
      await expect(saveButton).toBeVisible();
      await expect(saveButton).toBeDisabled();
    });

    await test.step('owner edits and saves budget', async () => {
      const convInput = authenticatedPage.getByTestId('budget-conversation-input');
      await convInput.clear();
      await convInput.fill('10.00');

      const memberInputs = authenticatedPage.locator('[data-testid^="budget-input-"]');
      const memberCount = await memberInputs.count();
      if (memberCount > 0) {
        await memberInputs.first().clear();
        await memberInputs.first().fill('5.00');
      }

      const saveButton = authenticatedPage.getByTestId('budget-save-button');
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      await unsettledExpect(
        authenticatedPage.getByTestId('budget-settings-modal')
      ).not.toBeVisible();
    });

    await test.step('non-owner sees read-only budget modal', async () => {
      const bobChatPage = new ChatPage(testBobPage);
      await bobChatPage.gotoConversation(groupConversation.id);
      await bobChatPage.waitForConversationLoaded();

      const bobSidebar = new MemberSidebarPage(testBobPage);
      await bobSidebar.openViaFacepile();
      await bobSidebar.waitForLoaded();
      await bobSidebar.clickBudgetSettings();

      const modal = testBobPage.getByTestId('budget-settings-modal');
      await expect(modal).toBeVisible();

      await expect(testBobPage.getByTestId('budget-conversation-value')).toBeVisible();
      await expect(testBobPage.getByTestId('budget-conversation-input')).not.toBeVisible();

      await expect(testBobPage.getByTestId('budget-save-button')).not.toBeVisible();

      await testBobPage.getByTestId('budget-cancel-button').click();
    });

    await test.step('cancel discards edits', async () => {
      await sidebar.clickBudgetSettings();
      const modal = authenticatedPage.getByTestId('budget-settings-modal');
      await expect(modal).toBeVisible();

      const convInput = authenticatedPage.getByTestId('budget-conversation-input');
      await convInput.clear();
      await convInput.fill('999.00');

      await authenticatedPage.getByTestId('budget-cancel-button').click();
      await unsettledExpect(modal).not.toBeVisible();

      await sidebar.clickBudgetSettings();
      await expect(authenticatedPage.getByTestId('budget-settings-modal')).toBeVisible();
      const currentValue = await authenticatedPage
        .getByTestId('budget-conversation-input')
        .inputValue();
      expect(currentValue).not.toBe('999.00');

      await authenticatedPage.keyboard.press('Escape');
    });
  });

  test('share AI message creates shareable link', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('share button appears on hover for AI message', async () => {
      const aiMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
      await aiMessage.hover();

      const shareButton = aiMessage.getByRole('button', { name: 'Share' });
      await expect(shareButton).toBeVisible();
      await shareButton.click();
    });

    await test.step('share modal shows preview and creates link', async () => {
      const modal = authenticatedPage.getByTestId('share-message-modal');
      await expect(modal).toBeVisible();

      await expect(authenticatedPage.getByTestId('share-message-preview')).toBeVisible();

      await expect(authenticatedPage.getByTestId('share-message-isolation-info')).toBeVisible();

      await authenticatedPage.getByTestId('share-message-create-button').click();

      const urlEl = authenticatedPage.getByTestId('share-message-url');
      await expect(urlEl).toBeVisible();
      const url = await urlEl.textContent();
      expect(url).toContain('/share/m/');

      await expect(authenticatedPage.getByTestId('share-message-copy-button')).toBeVisible();

      await authenticatedPage.keyboard.press('Escape');
    });

    await test.step('cancel share does not create link', async () => {
      const userMessages = chatPage.messageList.locator('[data-role="user"]');
      const firstUserMessage = userMessages.first();
      await firstUserMessage.hover();

      // User messages may or may not have share button — check if present
      const shareButton = firstUserMessage.getByRole('button', { name: 'Share' });
      const shareVisible = await shareButton.isVisible().catch(() => false);
      if (shareVisible) {
        await shareButton.click();
        await authenticatedPage.getByTestId('share-message-cancel-button').click();
        await expect(authenticatedPage.getByTestId('share-message-modal')).not.toBeVisible();
      }
    });
  });

  test('add member without history: adder retains access to old messages after page refresh', async ({
    authenticatedPage,
    testDavePage,
    groupConversation,
  }) => {
    test.slow();

    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    await test.step('Alice sees pre-existing messages before adding member', async () => {
      await aliceChatPage.expectMessageVisible('Hello from Alice');
    });

    await test.step('add Dave WITHOUT history', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await searchAndSelectMember(authenticatedPage, sidebar, 'test dave');

      await authenticatedPage.getByTestId('add-member-privilege-select').selectOption('write');

      // Do NOT check history checkbox — leave unchecked for "without history"
      await expect(
        authenticatedPage.getByTestId('add-member-history-checkbox').getByRole('checkbox')
      ).not.toBeChecked();

      await authenticatedPage.getByTestId('add-member-submit-button').click();
      await expect(authenticatedPage.getByTestId('add-member-modal')).not.toBeVisible();
    });

    await test.step('Alice refreshes page and still sees old messages', async () => {
      await authenticatedPage.reload();

      const refreshedChat = new ChatPage(authenticatedPage);
      await refreshedChat.waitForConversationLoaded();

      // Alice must still be able to decrypt messages from before the rotation
      await refreshedChat.expectMessageVisible('Hello from Alice');
    });

    await test.step('Dave cannot see pre-rotation messages', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);
      await daveChatPage.waitForConversationLoaded();

      await daveChatPage.assertMessageNotVisible('Hello from Alice', { exact: true });
    });
  });
});
