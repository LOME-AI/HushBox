import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';

test.describe('Group Chat Admin', () => {
  test.describe.configure({ mode: 'serial' });

  // Test 1: Consolidates old sender labels + message grouping + AI toggle tests
  test('displays sender labels, groups consecutive messages, and AI toggle works', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // 6 steps with multiple page navigations + AI response
    test.slow();

    const bobMember = groupConversation.members.find((m) => m.email === 'test-bob@test.hushbox.ai');
    const aliceMember = groupConversation.members.find(
      (m) => m.email === 'test-alice@test.hushbox.ai'
    );

    await test.step('Alice sees correct sender labels', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();
      await aliceChatPage.expectMessageVisible('Hello from Alice');

      // Alice sees her messages labeled "You"
      const aliceLabels = aliceChatPage.getSenderLabels();
      await expect(aliceLabels.first()).toHaveText('You');

      // Alice sees bob's messages labeled with bob's username
      await expect(aliceLabels.getByText(bobMember!.username)).toBeVisible();

      // AI message has no sender label
      const aiMessage = aliceChatPage.messageList.locator('[data-role="assistant"]');
      await expect(aiMessage).toBeVisible();
      const aiLabels = aiMessage.locator('[data-testid="sender-label"]');
      await expect(aiLabels).toHaveCount(0);
    });

    await test.step('consecutive messages are grouped', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      const firstGroup = aliceChatPage.getMessageGroups().first();
      await expect(firstGroup.getByText('Hello from Alice')).toBeVisible();
      await expect(firstGroup.getByText('Second from Alice')).toBeVisible();
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
      // Send a message to create a 1:1 conversation
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

  // Test 2: Member sidebar display verification
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
      (m) => m.email === 'test-alice@test.hushbox.ai'
    )!;
    const bobMember = groupConversation.members.find(
      (m) => m.email === 'test-bob@test.hushbox.ai'
    )!;

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

      // Wait for WebSocket presence to propagate
      await authenticatedPage.waitForTimeout(2000);

      const bobMemberId = await sidebar.getMemberIdByUsername(bobMember.username);
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

    await test.step('admin action buttons are visible', async () => {
      await expect(sidebar.newMemberButton).toBeVisible();
      await expect(sidebar.inviteLinkButton).toBeVisible();
    });
  });

  // Test 3: Add member with full history
  test('add member with full history and verify access', async ({
    authenticatedPage,
    testDavePage,
    groupConversation,
  }) => {
    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    await test.step('open add member modal and search for Dave', async () => {
      await sidebar.clickNewMember();
      const modal = authenticatedPage.getByTestId('add-member-modal');
      await expect(modal).toBeVisible();

      const searchInput = authenticatedPage.getByTestId('add-member-search-input');
      await searchInput.fill('test dave');

      // Wait for search results
      const result = authenticatedPage.getByTestId(/^add-member-result-/);
      await expect(result.first()).toBeVisible({ timeout: 5000 });
      await result.first().click();

      await expect(authenticatedPage.getByTestId('add-member-selected')).toBeVisible();
    });

    await test.step('set privilege and history, submit', async () => {
      const privilegeSelect = authenticatedPage.getByTestId('add-member-privilege-select');
      await privilegeSelect.selectOption('write');

      const historyCheckbox = authenticatedPage.getByTestId('add-member-history-checkbox');
      await historyCheckbox.check();

      await authenticatedPage.getByTestId('add-member-submit-button').click();

      // Modal closes
      await expect(authenticatedPage.getByTestId('add-member-modal')).not.toBeVisible();
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
  });

  // Test 4: Change member privilege
  test('change member privilege updates sidebar grouping', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    const daveMemberId = await sidebar.getMemberIdByUsername('test dave');

    await test.step('change Dave to read privilege', async () => {
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickChangePrivilege(daveMemberId, 'read');

      // Wait for update to propagate
      await authenticatedPage.waitForTimeout(500);
      await sidebar.expectMemberInSection(daveMemberId, 'read');
    });

    await test.step('privilege options do not include owner', async () => {
      await sidebar.openMemberActions(daveMemberId);
      const changeTrigger = authenticatedPage.getByTestId(
        `member-change-privilege-${daveMemberId}`
      );
      await changeTrigger.click();

      // Verify admin, write, read exist
      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-admin`)
      ).toBeVisible();
      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-write`)
      ).toBeVisible();
      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-read`)
      ).toBeVisible();

      // Verify owner does NOT exist
      await expect(
        authenticatedPage.getByTestId(`privilege-option-${daveMemberId}-owner`)
      ).not.toBeVisible();

      // Close menu by pressing Escape
      await authenticatedPage.keyboard.press('Escape');
    });

    await test.step('change Dave to admin', async () => {
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickChangePrivilege(daveMemberId, 'admin');
      await authenticatedPage.waitForTimeout(500);
      await sidebar.expectMemberInSection(daveMemberId, 'admin');
    });
  });

  // Test 5: Invite link lifecycle
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

      // Warning about link sharing
      await expect(authenticatedPage.getByTestId('invite-link-warning')).toBeVisible();

      // Set name
      await authenticatedPage.getByTestId('invite-link-name-input').fill('Guest Reader');

      // Generate
      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      // URL appears
      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      const url = await urlEl.textContent();
      expect(url).toContain('/share/c/');

      // Copy button appears
      await expect(authenticatedPage.getByTestId('invite-link-copy-button')).toBeVisible();

      // Close modal
      await authenticatedPage.keyboard.press('Escape');
    });

    await test.step('read link appears in sidebar', async () => {
      // Find the link by its name in the read section
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

      // Select write privilege
      await authenticatedPage.getByTestId('invite-link-privilege-select').selectOption('write');

      // Set name
      await authenticatedPage.getByTestId('invite-link-name-input').fill('Guest Writer');
      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();

      await authenticatedPage.keyboard.press('Escape');
    });

    await test.step('rename link', async () => {
      await sidebar.openLinkActions(readLinkId);
      await sidebar.clickChangeLinkName(readLinkId);
      await sidebar.editLinkNameInline(readLinkId, 'Renamed Guest');

      // Verify name updated
      const linkRow = sidebar.linkRow(readLinkId);
      await expect(linkRow.getByText('Renamed Guest')).toBeVisible();
    });

    await test.step('change link privilege', async () => {
      await sidebar.openLinkActions(readLinkId);
      await sidebar.clickChangeLinkPrivilege(readLinkId, 'write');
      await authenticatedPage.waitForTimeout(500);
    });

    await test.step('revoke link with confirmation', async () => {
      await sidebar.openLinkActions(readLinkId);
      await sidebar.clickRevokeLinkAction(readLinkId);

      // Confirmation modal
      const modal = authenticatedPage.getByTestId('revoke-link-modal');
      await expect(modal).toBeVisible();

      const warning = authenticatedPage.getByTestId('revoke-link-warning');
      await expect(warning).toBeVisible();

      await authenticatedPage.getByTestId('revoke-link-confirm').click();

      // Link removed from sidebar
      await sidebar.expectLinkNotVisible(readLinkId);
    });
  });

  // Test 6: Budget settings modal
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

      // Conversation budget is an input (owner can edit)
      await expect(authenticatedPage.getByTestId('budget-conversation-input')).toBeVisible();

      // Save button exists but is disabled (no changes yet)
      const saveButton = authenticatedPage.getByTestId('budget-save-button');
      await expect(saveButton).toBeVisible();
      await expect(saveButton).toBeDisabled();
    });

    await test.step('owner edits and saves budget', async () => {
      const convInput = authenticatedPage.getByTestId('budget-conversation-input');
      await convInput.clear();
      await convInput.fill('10.00');

      // If there are member budget inputs, set one
      const memberInputs = authenticatedPage.locator('[data-testid^="budget-input-"]');
      const memberCount = await memberInputs.count();
      if (memberCount > 0) {
        await memberInputs.first().clear();
        await memberInputs.first().fill('5.00');
      }

      const saveButton = authenticatedPage.getByTestId('budget-save-button');
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      // Modal closes after save
      await expect(authenticatedPage.getByTestId('budget-settings-modal')).not.toBeVisible();
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

      // Values displayed as text, not inputs
      await expect(testBobPage.getByTestId('budget-conversation-value')).toBeVisible();
      await expect(testBobPage.getByTestId('budget-conversation-input')).not.toBeVisible();

      // No Save button for non-owner
      await expect(testBobPage.getByTestId('budget-save-button')).not.toBeVisible();

      // Close
      await testBobPage.getByTestId('budget-cancel-button').click();
    });

    await test.step('cancel discards edits', async () => {
      // Re-open sidebar on Alice's page
      await sidebar.clickBudgetSettings();
      const modal = authenticatedPage.getByTestId('budget-settings-modal');
      await expect(modal).toBeVisible();

      const convInput = authenticatedPage.getByTestId('budget-conversation-input');
      await convInput.clear();
      await convInput.fill('999.00');

      // Cancel
      await authenticatedPage.getByTestId('budget-cancel-button').click();
      await expect(modal).not.toBeVisible();

      // Reopen — value should NOT be 999.00
      await sidebar.clickBudgetSettings();
      await expect(authenticatedPage.getByTestId('budget-settings-modal')).toBeVisible();
      const currentValue = await authenticatedPage
        .getByTestId('budget-conversation-input')
        .inputValue();
      expect(currentValue).not.toBe('999.00');

      await authenticatedPage.keyboard.press('Escape');
    });
  });

  // Test 7: Share AI message
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

      // Preview shows message content
      await expect(authenticatedPage.getByTestId('share-message-preview')).toBeVisible();

      // Isolation info
      await expect(authenticatedPage.getByTestId('share-message-isolation-info')).toBeVisible();

      // Create link
      await authenticatedPage.getByTestId('share-message-create-button').click();

      // URL appears
      const urlEl = authenticatedPage.getByTestId('share-message-url');
      await expect(urlEl).toBeVisible();
      const url = await urlEl.textContent();
      expect(url).toContain('/share/m/');

      // Copy button appears
      await expect(authenticatedPage.getByTestId('share-message-copy-button')).toBeVisible();

      // Close
      await authenticatedPage.keyboard.press('Escape');
    });

    await test.step('cancel share does not create link', async () => {
      // Hover and click share on a different message
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

  // Test 8: Remove member
  test('remove member and cancel remove', async ({
    authenticatedPage,
    testDavePage,
    groupConversation,
  }) => {
    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    const bobMemberId = await sidebar.getMemberIdByUsername('test bob');

    await test.step('cancel remove keeps member', async () => {
      await sidebar.openMemberActions(bobMemberId);
      await sidebar.clickRemoveMember(bobMemberId);

      const modal = authenticatedPage.getByTestId('remove-member-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('remove-member-cancel').click();
      await expect(modal).not.toBeVisible();

      // Bob still in sidebar
      await expect(sidebar.memberRow(bobMemberId)).toBeVisible();
    });

    const daveMemberId = await sidebar.getMemberIdByUsername('test dave');

    await test.step('remove Dave with confirmation', async () => {
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickRemoveMember(daveMemberId);

      const modal = authenticatedPage.getByTestId('remove-member-modal');
      await expect(modal).toBeVisible();

      // Warning text
      await expect(authenticatedPage.getByTestId('remove-member-warning')).toBeVisible();

      await authenticatedPage.getByTestId('remove-member-confirm').click();
      await expect(modal).not.toBeVisible();

      // Dave removed from sidebar
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
  });
});
