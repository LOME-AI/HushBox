import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';

test.describe('Shared Content', () => {
  test('invite link: shared conversation view and revoked link error', async ({
    authenticatedPage,
    unauthenticatedPage,
    groupConversation,
    browser,
  }) => {
    // Setup: navigate Alice to group conversation and open member sidebar
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let inviteUrl: string;
    let linkId: string;

    await test.step('create invite link and capture URL', async () => {
      await sidebar.clickInviteLink();
      const modal = authenticatedPage.getByTestId('invite-link-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('invite-link-generate-button').click();

      const urlEl = authenticatedPage.getByTestId('invite-link-url');
      await expect(urlEl).toBeVisible();
      inviteUrl = (await urlEl.textContent()) ?? '';
      expect(inviteUrl).toContain('/share/c/');
      expect(inviteUrl).toContain('#');

      await authenticatedPage.keyboard.press('Escape');

      // Capture linkId from sidebar for later revocation
      const linkRow = sidebar.content.locator('[data-testid^="link-item-"]').first();
      await expect(linkRow).toBeVisible();
      const testId = await linkRow.getAttribute('data-testid');
      linkId = testId!.replace('link-item-', '');
    });

    await test.step('unauthenticated user sees decrypted messages', async () => {
      await unauthenticatedPage.goto(inviteUrl);

      // Wait for loading to finish
      await expect(unauthenticatedPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Verify decrypted conversation content is visible
      await expect(unauthenticatedPage.getByText('Hello from Alice').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(unauthenticatedPage.getByText('Hi from Bob').first()).toBeVisible();

      // Error state should NOT be visible
      await expect(unauthenticatedPage.getByTestId('shared-conversation-error')).not.toBeVisible();
    });

    await test.step('revoke the invite link', async () => {
      await sidebar.openLinkActions(linkId);
      await sidebar.clickRevokeLinkAction(linkId);

      const modal = authenticatedPage.getByTestId('revoke-link-modal');
      await expect(modal).toBeVisible();
      await authenticatedPage.getByTestId('revoke-link-confirm').click();

      await sidebar.expectLinkNotVisible(linkId);
    });

    await test.step('revoked link shows error', async () => {
      // Fresh context to avoid TanStack Query cache from step 2
      const freshContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const freshPage = await freshContext.newPage();
      await freshPage.goto(inviteUrl);

      await expect(freshPage.getByTestId('shared-conversation-error')).toBeVisible({
        timeout: 15_000,
      });

      await freshContext.close();
    });
  });

  test('shared message link shows decrypted content', async ({
    authenticatedPage,
    unauthenticatedPage,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    let shareUrl: string;

    await test.step('share AI message and capture URL', async () => {
      const aiMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
      await aiMessage.hover();

      const shareButton = aiMessage.getByRole('button', { name: 'Share' });
      await expect(shareButton).toBeVisible();
      await shareButton.click();

      const modal = authenticatedPage.getByTestId('share-message-modal');
      await expect(modal).toBeVisible();

      await authenticatedPage.getByTestId('share-message-create-button').click();

      const urlEl = authenticatedPage.getByTestId('share-message-url');
      await expect(urlEl).toBeVisible();
      shareUrl = (await urlEl.textContent()) ?? '';
      expect(shareUrl).toContain('/share/m/');
      expect(shareUrl).toContain('#');

      await authenticatedPage.keyboard.press('Escape');
    });

    await test.step('unauthenticated user sees decrypted message', async () => {
      await unauthenticatedPage.goto(shareUrl);

      // Wait for loading to finish
      await expect(unauthenticatedPage.getByTestId('shared-message-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Verify decrypted message content (AI echo response)
      await expect(unauthenticatedPage.getByText('Echo:').first()).toBeVisible({
        timeout: 10_000,
      });

      // Error state should NOT be visible
      await expect(unauthenticatedPage.getByTestId('shared-message-error')).not.toBeVisible();
    });
  });

  test('invalid share links show error states', async ({ unauthenticatedPage }) => {
    await test.step('invalid conversation link shows error', async () => {
      await unauthenticatedPage.goto('/share/c/nonexistent#invalidkey');

      await expect(unauthenticatedPage.getByTestId('shared-conversation-error')).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step('invalid message link shows error', async () => {
      await unauthenticatedPage.goto('/share/m/nonexistent#invalidkey');

      await expect(unauthenticatedPage.getByTestId('shared-message-error')).toBeVisible({
        timeout: 15_000,
      });
    });
  });
});
