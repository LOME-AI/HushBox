import {
  test,
  expect,
  unsettledExpect,
  expectApiErrors,
  expectConsoleErrors,
} from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { createInviteLink } from '../helpers/invite-link.js';
import { createMessageShareUrl } from '../helpers/share-message.js';
import { requireEnv } from '../helpers/env.js';
import { expectVideoDecoded } from '../helpers/webkit-media-decode.js';

const apiUrl = requireEnv('VITE_API_URL');

test.describe('Shared Content', () => {
  test('invite link: shared conversation view and revoked link error', async ({
    authenticatedPage,
    unauthenticatedPage,
    groupConversation,
    createPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    let inviteUrl: string;
    let linkId: string;

    await test.step('create invite link and capture URL', async () => {
      const result = await createInviteLink(authenticatedPage, sidebar, {
        withHistory: true,
        closeMethod: 'escape',
      });
      inviteUrl = result.url;
      linkId = result.linkId;
      expect(inviteUrl).toContain('/share/c/');
      expect(inviteUrl).toContain('#');
    });

    await test.step('unauthenticated user sees decrypted messages', async () => {
      // Deliberate: opening the invite link briefly fires user-auth prefetches
      // of every per-conversation resource through the page's `unauthenticatedPage`
      // session — each 401s with NOT_AUTHENTICATED before the link-guest
      // context establishes.
      expectApiErrors(unauthenticatedPage, [
        /401 Unauthorized GET .*\/api\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
        /"code":"NOT_AUTHENTICATED"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);

      await unauthenticatedPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(unauthenticatedPage.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.assertMessageVisible('Hello from Alice', { timeout: 10_000 });
      await guestChatPage.assertMessageVisible('Hi from Bob');

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
      const freshPage = await createPage();
      // Deliberate: after the invite link is revoked, the guest's fetch
      // of every per-conversation resource through that link 401s with
      // NOT_AUTHENTICATED.
      expectApiErrors(freshPage, [
        /401 Unauthorized GET .*\/api\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
        /"code":"NOT_AUTHENTICATED"/,
      ]);
      expectConsoleErrors(freshPage, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);
      await freshPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(freshPage.getByTestId('shared-conversation-error')).toBeVisible({
        timeout: 15_000,
      });
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
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('unauthenticated user sees decrypted message', async () => {
      await unauthenticatedPage.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(unauthenticatedPage.getByTestId('shared-message-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      await expect(unauthenticatedPage.getByText('Echo:').first()).toBeVisible({
        timeout: 10_000,
      });

      await expect(unauthenticatedPage.getByTestId('shared-message-error')).not.toBeVisible();
    });
  });

  test('invalid share links show error states', async ({ unauthenticatedPage }) => {
    // Deliberate: this test fetches `/share/{c,m}/nonexistent` URLs and
    // asserts the error state. The underlying share-lookup API returns
    // 404 SHARE_NOT_FOUND for both.
    expectApiErrors(unauthenticatedPage, [
      /404 Not Found GET .*\/api\/shares\/nonexistent/,
      /"code":"SHARE_NOT_FOUND"/,
    ]);
    expectConsoleErrors(unauthenticatedPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
    await test.step('invalid conversation link shows error', async () => {
      await unauthenticatedPage.goto('/share/c/nonexistent#invalidkey', {
        waitUntil: 'domcontentloaded',
      });

      await expect(unauthenticatedPage.getByTestId('shared-conversation-error')).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step('invalid message link shows error', async () => {
      await unauthenticatedPage.goto('/share/m/nonexistent#invalidkey', {
        waitUntil: 'domcontentloaded',
      });

      await expect(unauthenticatedPage.getByTestId('shared-message-error')).toBeVisible({
        timeout: 15_000,
      });
    });
  });

  /**
   * D1: end-to-end share of a generated image.
   * Sender generates an image, shares the assistant message, and the recipient
   * (a fresh, unauthenticated browser context built via createPage()) sees the
   * rendered image. Using a fresh page avoids TanStack Query cache pollution
   * from previous unauthenticatedPage uses in the same fixture.
   *
   * Also intercepts the recipient's GET /api/shares/:id and asserts the
   * response body does NOT carry `modelName` or `cost` keys — share recipients
   * must see content, not generation metadata.
   */
  test('shared image message: guest sees the rendered image', async ({
    authenticatedPage,
    createPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Share this image ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    let shareUrl = '';

    await test.step('share assistant image message and capture URL', async () => {
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('guest sees the rendered image at the share URL', async () => {
      const recipient = await createPage();

      // Intercept the share fetch to assert sensitive fields are stripped.
      let capturedShareBody: string | null = null;
      await recipient.route('**/api/shares/*', async (route) => {
        const response = await route.fetch();
        capturedShareBody = await response.text();
        await route.fulfill({ response });
      });

      await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(recipient.getByTestId('shared-message-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      // Image renders for the guest. The shared media renderer uses the same
      // MediaPreview component, so an `<img>` element appears once decryption
      // completes against the URL-fragment shareSecret.
      await expect(recipient.locator('img').first()).toBeVisible({ timeout: 15_000 });

      await expect(recipient.getByTestId('shared-message-error')).not.toBeVisible();

      // Sensitive metadata must not appear in the share response payload.
      expect(capturedShareBody, 'share response not captured').toBeTruthy();
      const body = capturedShareBody!;
      expect(body).not.toContain('"modelName"');
      expect(body).not.toContain('"cost"');
      expect(body).not.toContain('"isSmartModel"');
    });
  });

  /**
   * D2: end-to-end share of a generated video. Sender generates a video,
   * shares the message, and a fresh recipient browser context (createPage())
   * sees a `<video>` element render in the share view (round-trip with the
   * encrypted bytes fetched via the presigned URL and decrypted with the
   * URL-fragment shareSecret).
   */
  test('shared video message: guest plays the rendered video', async ({
    authenticatedPage,
    createPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Share this video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    let shareUrl = '';

    await test.step('share assistant video message and capture URL', async () => {
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('guest sees the rendered video at the share URL', async () => {
      const recipient = await createPage();

      // Intercept the share fetch to assert sensitive fields are stripped from
      // the public payload (parity with the image-share test).
      let capturedShareBody: string | null = null;
      await recipient.route('**/api/shares/*', async (route) => {
        const response = await route.fetch();
        capturedShareBody = await response.text();
        await route.fulfill({ response });
      });

      await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(recipient.getByTestId('shared-message-loading')).not.toBeVisible({
        timeout: 15_000,
      });

      const videoElement = recipient.locator('video').first();
      await expect(videoElement).toBeVisible({ timeout: 15_000 });

      await expect(recipient.getByTestId('shared-message-error')).not.toBeVisible();

      // Sensitive metadata must not appear in the public share payload.
      expect(capturedShareBody, 'share response not captured').toBeTruthy();
      const body = capturedShareBody!;
      expect(body).not.toContain('"modelName"');
      expect(body).not.toContain('"cost"');
      expect(body).not.toContain('"isSmartModel"');
    });
  });

  /**
   * D3: the share-create POST is tiny — never carries inline media bytes.
   * The encrypted media stays in R2; the share row only records a wrapped
   * key (`wrappedShareKey`). We intercept POST /api/messages/share, capture
   * the body, and assert (a) it is well under any sane "blob in JSON" size
   * (<2 KB) and (b) it does not look like base64 image data.
   */
  test('share-create POST body stays small (no inline media bytes)', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    await chatPage.sendNewChatMessage(`Share size check ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    let capturedBody: string | null = null;
    await authenticatedPage.route('**/api/messages/share', async (route) => {
      const data = route.request().postData();
      if (data !== null) capturedBody = data;
      await route.continue();
    });

    const aiMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    await aiMessage.hover();
    await aiMessage.getByRole('button', { name: 'Share' }).click();

    const modal = authenticatedPage.getByTestId('share-message-modal');
    await expect(modal).toBeVisible();
    await authenticatedPage.getByTestId('share-message-create-button').click();
    await expect(authenticatedPage.getByTestId('share-message-url')).toBeVisible();

    expect(capturedBody, 'POST body for share-create not captured').toBeTruthy();
    const body = capturedBody!;
    // Tiny: well under 2 KB. Real bodies are a few hundred bytes (messageId + wrapped key).
    expect(body.length).toBeLessThan(2048);
    // The PNG header in base64 starts with `iVBORw0K`. Ensure it's not in the body.
    expect(body).not.toContain('iVBORw0K');
    // Also no `data:image` payload smuggled in.
    expect(body).not.toContain('data:image');
  });

  /**
   * D5: revoking a share makes subsequent fetches return 404. Uses the dev-only
   * `/api/dev/revoke-message-share` endpoint to delete the share row, then asserts
   * that GET /api/shares/:id responds with 404 and the share view surfaces the
   * standard error state.
   *
   * Recipient is a fresh createPage() so cache pollution from earlier
   * unauthenticated work doesn't mask the revoked-state.
   */
  test('revoked message share returns 404 on fetch', async ({ authenticatedPage, createPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    await chatPage.sendNewChatMessage(`Revoke share ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    let shareUrl = '';
    let shareId = '';
    let createResponseBody: { shareId: string } | null = null;

    await authenticatedPage.route('**/api/messages/share', async (route) => {
      const response = await route.fetch();
      const json = (await response.json().catch(() => null)) as { shareId: string } | null;
      if (json) createResponseBody = json;
      await route.fulfill({ response });
    });

    const aiMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    await aiMessage.hover();
    await aiMessage.getByRole('button', { name: 'Share' }).click();
    const modal = authenticatedPage.getByTestId('share-message-modal');
    await expect(modal).toBeVisible();
    await authenticatedPage.getByTestId('share-message-create-button').click();

    const urlEl = authenticatedPage.getByTestId('share-message-url');
    await expect(urlEl).toBeVisible();
    shareUrl = (await urlEl.textContent()) ?? '';
    expect(createResponseBody, 'share-create response body not captured').toBeTruthy();
    shareId = createResponseBody!.shareId;
    expect(shareId).toBeTruthy();

    await authenticatedPage.keyboard.press('Escape');

    const revoke = await authenticatedPage.request.post(`${apiUrl}/api/dev/revoke-message-share`, {
      data: { shareId },
    });
    expect(revoke.ok()).toBe(true);

    const recipient = await createPage();

    expectApiErrors(recipient, [
      /404 Not Found GET .*\/api\/shares\/[0-9a-f-]+/,
      /"code":"SHARE_NOT_FOUND"/,
    ]);
    expectConsoleErrors(recipient, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);

    const fetchAfterRevoke = await recipient.request.get(`${apiUrl}/api/shares/${shareId}`);
    expect(fetchAfterRevoke.status()).toBe(404);

    await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });
    await expect(recipient.getByTestId('shared-message-error')).toBeVisible({
      timeout: 15_000,
    });
    await expect(recipient.locator('img')).toHaveCount(0);
  });

  /**
   * Lane 9 #2: a group-conversation invite link must surface generated image
   * and video assets to a fresh, unauthenticated browser context. Owner Alice
   * generates one image and one video inside a group conversation, then mints
   * a public invite link with history. A guest opens the link and both media
   * elements decode (non-zero `naturalWidth` / playable `<video>`).
   */
  test('group invite link surfaces generated image and video to guests', async ({
    authenticatedPage,
    groupConversation,
    createPage,
    browserName,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('owner generates an image inside the group conversation', async () => {
      const imageIcon = authenticatedPage.getByRole('button', { name: /switch to image/i });
      await expect(imageIcon).toBeVisible();
      await imageIcon.click();
      await expect(authenticatedPage.getByRole('button', { name: '1:1' })).toBeVisible();

      await chatPage.sendFollowUpMessage(`Group image ${String(Date.now())}`);
      await chatPage.expectImageVisible(30_000);
      await chatPage.waitForStreamComplete(30_000);
    });

    await test.step('owner generates a video inside the same group conversation', async () => {
      const videoIcon = authenticatedPage.getByRole('button', { name: /switch to video/i });
      await expect(videoIcon).toBeVisible();
      await videoIcon.click();
      await expect(authenticatedPage.getByRole('button', { name: /720p/i })).toBeVisible();

      await chatPage.sendFollowUpMessage(`Group video ${String(Date.now())}`);
      await chatPage.expectVideoVisible(30_000);
      await chatPage.waitForStreamComplete(30_000);
    });

    let inviteUrl = '';

    await test.step('owner mints a public invite link with full history', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createInviteLink(authenticatedPage, sidebar, {
        withHistory: true,
        closeMethod: 'escape',
        extractLinkId: false,
      });
      inviteUrl = result.url;
      expect(inviteUrl).toContain('/share/c/');
      expect(inviteUrl).toContain('#');
    });

    await test.step('guest sees both image and video render at the invite URL', async () => {
      const guest = await createPage();
      await guest.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(guest.getByTestId('shared-conversation-loading')).not.toBeVisible({
        timeout: 15_000,
      });
      await expect(guest.getByTestId('shared-conversation-error')).not.toBeVisible();

      // expectImageVisible / expectVideoVisible park the relevant row in view
      // first, so iPhone-15 virtualization doesn't drop the tile from the DOM
      // before the assertion runs.
      const guestChatPage = new ChatPage(guest);
      await guestChatPage.expectImageVisible(15_000);
      const imageElement = guestChatPage.messageList.locator('img').first();
      await unsettledExpect
        .poll(async () => imageElement.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);

      await guestChatPage.expectVideoVisible(15_000);
      const videoElement = guestChatPage.messageList.locator('video').first();
      // Wait until the video reports a parseable duration (metadata loaded);
      // degrades to a "src bound" check on engines that can't decode.
      await expectVideoDecoded(videoElement, browserName, { timeout: 15_000 });
    });
  });
});
