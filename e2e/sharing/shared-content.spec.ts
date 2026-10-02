import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors, type Page } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { E2E_MODELS } from '../../scripts/lib/playwright/model-ids.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { createInviteLink } from '../helpers/invite-link.js';
import { createMessageShareUrl, openShareModalForMessage } from '../helpers/share-message.js';
import { requireEnv } from '../helpers/env.js';
import { settledReasoningLabel } from '../helpers/reasoning-row.js';
import { guestIp } from '../helpers/guest-identity.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { expectVideoDecoded } from '../helpers/webkit-media-decode.js';
import { imagesOnPage, videosOnPage } from '../helpers/page-signals.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

const apiUrl = requireEnv('VITE_API_URL');

/**
 * A reasoning-capable text model: its catalog entry carries structured
 * `reasoning` metadata, so the turn records the level it ran at. Validated
 * present in the live catalog at `e2e:prepare`, like every E2E model id.
 */
const REASONING_MODEL_ID = E2E_MODELS.text[1];

const SETTLED_REASONING_LABEL = settledReasoningLabel('high');

test.describe('Shared Content', SPEC_MATRIX, () => {
  test('invite link: shared conversation view and revoked link error', async ({
    authenticatedPage,
    unauthenticatedPage,
    groupConversation,
    createPage,
  }) => {
    await unauthenticatedPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

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
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+(?:\/(?:budgets|keychain|members|links))?(?=\?|\s|$)/,
        /"code":"NOT_AUTHENTICATED"/,
        // Deliberate: this page is still open when the `revoke the invite link` step runs, and
        // revocation evicts its live socket, so the reconnect's ticket mint refuses and no
        // upgrade is attempted.
        /401 Unauthorized POST .*\/conversations\/[0-9a-f-]+\/websocket-ticket(?=\?|\s|$)/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);

      await unauthenticatedPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(
        unauthenticatedPage.getByTestId(TEST_IDS.sharedConversationLoading)
      ).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.assertMessageVisible('Hello from Alice', { timeout: TIMEOUTS.ASSERT });
      await guestChatPage.assertMessageVisible('Hi from Bob');

      await expect(
        unauthenticatedPage.getByTestId(TEST_IDS.sharedConversationError)
      ).not.toBeVisible();
    });

    await test.step('revoke the invite link', async () => {
      await sidebar.openLinkActions(linkId);
      await sidebar.clickRevokeLinkAction(linkId);

      const modal = authenticatedPage.getByTestId(TEST_IDS.revokeLinkModal);
      await expect(modal).toBeVisible();
      await authenticatedPage.getByTestId(TEST_IDS.revokeLinkConfirm).click();

      await sidebar.expectLinkNotVisible(linkId);
    });

    await test.step('revoked link shows error', async () => {
      // Fresh context to avoid TanStack Query cache from step 2
      const freshPage = await createPage();
      await freshPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      // Deliberate: after the invite link is revoked, the guest's fetch
      // of every per-conversation resource through that link 401s with
      // NOT_AUTHENTICATED.
      expectApiErrors(freshPage, [
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+(?:\/(?:budgets|keychain|members|links))?(?=\?|\s|$)/,
        /"code":"NOT_AUTHENTICATED"/,
        // Deliberate: the revoked link no longer authorizes the guest's funding and message
        // reads — the refusal the visible shared-conversation error proves.
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+\/(?:funding|messages)(?=\?|\s|$)/,
      ]);
      expectConsoleErrors(freshPage, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);
      await freshPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(freshPage.getByTestId(TEST_IDS.sharedConversationError)).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
    });
  });

  test('shared message link shows decrypted content', async ({
    authenticatedPage,
    unauthenticatedPage,
    groupConversation,
  }) => {
    await unauthenticatedPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    let shareUrl: string;

    await test.step('share AI message and capture URL', async () => {
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('unauthenticated user sees decrypted message', async () => {
      await unauthenticatedPage.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(unauthenticatedPage.getByTestId(TEST_IDS.sharedMessageLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      await expect(unauthenticatedPage.getByText('Echo:').first()).toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });

      await expect(unauthenticatedPage.getByTestId(TEST_IDS.sharedMessageError)).not.toBeVisible();
    });
  });

  /**
   * A share publishes the model's thoughts, not just its answer: the rung the
   * author's turn ran at and the trace itself both reach an unauthenticated
   * visitor, so the row a guest reads is the row its author reads.
   */
  test('shared message carries the reasoning row its author sees', async ({
    authenticatedPage,
    createPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.selectSingleModel(REASONING_MODEL_ID);
    await chatPage.selectReasoningEffort('High');

    const prompt = `Share this reasoning ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse('Echo:');

    let shareUrl = '';

    await test.step('share the reasoned assistant message', async () => {
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('guest sees the closed row wearing the rung, and opens the trace', async () => {
      const recipient = await createPage();
      await recipient.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(recipient.getByTestId(TEST_IDS.sharedMessageLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      const disclosure = recipient.getByTestId(TEST_IDS.thinkingDisclosure);
      const toggle = disclosure.getByTestId(TEST_IDS.thinkingDisclosureToggle);
      await expect(toggle).toHaveText(SETTLED_REASONING_LABEL, {
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // A closed row holds no trace: nothing rests under it until the reader asks.
      await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toHaveCount(0);

      await toggle.click();
      await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toContainText(
        'Reading the request'
      );
    });
  });

  test('invalid share links show error states', async ({ createPage }) => {
    // Deliberate: this test fetches `/share/{c,m}/nonexistent` URLs and
    // asserts the error state. The share-message param is uuid-validated at
    // the boundary, so the malformed token "nonexistent" returns
    // 400 VALIDATION before any lookup runs (a well-formed but unknown uuid
    // would return 404 SHARE_NOT_FOUND).
    //
    // Each invalid link gets its own page: leaving the `/share/c` route runs a
    // security-critical `location.reload()` (guest-exit plaintext wipe), so a
    // second `goto` on the same page can be interrupted by that reload. Fresh
    // pages remove the cross-route navigation race.
    const expectShareValidationErrors = (page: Page): void => {
      expectApiErrors(page, [
        /400 Bad Request GET .*\/conversations\/shared\/.*nonexistent/,
        /"code":"VALIDATION"/,
      ]);
      expectConsoleErrors(page, [
        /Failed to load resource: the server responded with a status of 400/,
      ]);
    };

    await test.step('invalid conversation link shows error', async () => {
      const cPage = await createPage();
      await cPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      expectShareValidationErrors(cPage);
      await cPage.goto('/share/c/nonexistent#invalidkey', {
        waitUntil: 'domcontentloaded',
      });

      await expect(cPage.getByTestId(TEST_IDS.sharedConversationError)).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
    });

    await test.step('invalid message link shows error', async () => {
      const mPage = await createPage();
      await mPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      expectShareValidationErrors(mPage);
      await mPage.goto('/share/m/nonexistent#invalidkey', {
        waitUntil: 'domcontentloaded',
      });

      await expect(mPage.getByTestId(TEST_IDS.sharedMessageError)).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
    });
  });

  /**
   * End-to-end share of a generated image.
   * Sender generates an image, shares the assistant message, and the recipient
   * (a fresh, unauthenticated browser context built via createPage()) sees the
   * rendered image. Using a fresh page avoids TanStack Query cache pollution
   * from previous unauthenticatedPage uses in the same fixture.
   *
   * Also intercepts the recipient's GET /conversations/shared/message/:shareId and asserts the
   * response body carries the `modelName` and `isSmartModel` keys and never a `cost` key —
   * a shared reply names the model that wrote it, but never what it cost.
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    let shareUrl = '';

    await test.step('share assistant image message and capture URL', async () => {
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('guest sees the rendered image at the share URL', async () => {
      const recipient = await createPage();
      await recipient.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

      // Intercept the share fetch to assert sensitive fields are stripped.
      let capturedShareBody: string | null = null;
      await recipient.route('**/conversations/shared/message/*', async (route) => {
        const response = await route.fetch();
        capturedShareBody = await response.text();
        await route.fulfill({ response });
      });

      await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(recipient.getByTestId(TEST_IDS.sharedMessageLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      // Image renders for the guest. The shared media renderer uses the same
      // MediaPreview component, so an `<img>` element appears once decryption
      // completes against the URL-fragment shareSecret.
      await expect(imagesOnPage(recipient).first()).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      await expect(recipient.getByTestId(TEST_IDS.sharedMessageError)).not.toBeVisible();

      // The share names the model; the billed cost never appears in the payload.
      expect(capturedShareBody, 'share response not captured').toBeTruthy();
      const body = capturedShareBody!;
      expect(body).toContain('"modelName"');
      expect(body).toContain('"isSmartModel"');
      expect(body).not.toContain('"cost"');
    });
  });

  /**
   * End-to-end share of a generated video. Sender generates a video,
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    let shareUrl = '';

    await test.step('share assistant video message and capture URL', async () => {
      shareUrl = await createMessageShareUrl(chatPage);
    });

    await test.step('guest sees the rendered video at the share URL', async () => {
      const recipient = await createPage();
      await recipient.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

      // Intercept the share fetch to assert sensitive fields are stripped from
      // the public payload (parity with the image-share test).
      let capturedShareBody: string | null = null;
      await recipient.route('**/conversations/shared/message/*', async (route) => {
        const response = await route.fetch();
        capturedShareBody = await response.text();
        await route.fulfill({ response });
      });

      await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });

      await expect(recipient.getByTestId(TEST_IDS.sharedMessageLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      const videoElement = videosOnPage(recipient).first();
      await expect(videoElement).toBeVisible({ timeout: TIMEOUTS.CONVERSATION_LOAD });

      await expect(recipient.getByTestId(TEST_IDS.sharedMessageError)).not.toBeVisible();

      // The share names the model; the billed cost never appears in the payload.
      expect(capturedShareBody, 'share response not captured').toBeTruthy();
      const body = capturedShareBody!;
      expect(body).toContain('"modelName"');
      expect(body).toContain('"isSmartModel"');
      expect(body).not.toContain('"cost"');
    });
  });

  /**
   * The share-create POST is tiny — never carries inline media bytes.
   * The encrypted media stays in R2; the share row only records a wrapped
   * key (`wrappedShareKey`). We intercept POST /conversations/:conversationId/shares, capture
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(`Share size check ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    let capturedBody: string | null = null;
    await authenticatedPage.route('**/conversations/*/shares', async (route) => {
      const data = route.request().postData();
      if (data !== null) capturedBody = data;
      await route.fallback();
    });

    const aiMessage = chatPage.messagesByRole('assistant').first();
    await openShareModalForMessage(authenticatedPage, aiMessage);
    await authenticatedPage.getByTestId(TEST_IDS.shareMessageCreateButton).click();
    await expect(authenticatedPage.getByTestId(TEST_IDS.shareMessageUrl)).toBeVisible();

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
   * Revoking a share makes subsequent fetches return 404. Uses the dev-only
   * `/dev/revoke-message-share` endpoint to delete the share row, then asserts
   * that GET /conversations/shared/message/:shareId responds with 404 and the share view surfaces the
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(`Revoke share ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    let shareUrl = '';
    let shareId = '';
    let createResponseBody: { shareId: string } | null = null;

    await authenticatedPage.route('**/conversations/*/shares', async (route) => {
      const response = await route.fetch();
      const json = (await response.json().catch(() => null)) as { shareId: string } | null;
      if (json) createResponseBody = json;
      await route.fulfill({ response });
    });

    const aiMessage = chatPage.messagesByRole('assistant').first();
    await openShareModalForMessage(authenticatedPage, aiMessage);
    await authenticatedPage.getByTestId(TEST_IDS.shareMessageCreateButton).click();

    const urlEl = authenticatedPage.getByTestId(TEST_IDS.shareMessageUrl);
    await expect(urlEl).toBeVisible();
    shareUrl = (await urlEl.textContent()) ?? '';
    expect(createResponseBody, 'share-create response body not captured').toBeTruthy();
    shareId = createResponseBody!.shareId;
    expect(shareId).toBeTruthy();

    await authenticatedPage.keyboard.press('Escape');

    const revoke = await idempotentPost(
      withRequestRetry(authenticatedPage.request),
      `${apiUrl}/dev/revoke-message-share`,
      { data: { shareId } }
    );
    await expectOkResponse(revoke, 'dev message-share revoke');

    const recipient = await createPage();
    await recipient.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

    expectApiErrors(recipient, [
      /404 Not Found GET .*\/conversations\/shared\/message\/[0-9a-f-]+/,
      /"code":"SHARE_NOT_FOUND"/,
    ]);
    expectConsoleErrors(recipient, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);

    // `page.setExtraHTTPHeaders` reaches the document and in-page fetches but not
    // `page.request`, whose context reads its header bag off the browser context
    // rather than the page. This node-side read needs the address passed per call.
    const fetchAfterRevoke = await withRequestRetry(recipient.request).get(
      `${apiUrl}/conversations/shared/message/${shareId}`,
      { headers: { 'cf-connecting-ip': guestIp() } }
    );
    expect(fetchAfterRevoke.status()).toBe(404);

    await recipient.goto(shareUrl, { waitUntil: 'domcontentloaded' });
    await expect(recipient.getByTestId(TEST_IDS.sharedMessageError)).toBeVisible({
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });
    await expect(imagesOnPage(recipient)).toHaveCount(0);
  });

  /**
   * A group-conversation invite link must surface generated image
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
      await chatPage.selectMode('image');
      await expect(authenticatedPage.getByRole('button', { name: '1:1' })).toBeVisible();

      const imageBaseline = await chatPage.captureStreamBaseline();
      await chatPage.sendFollowUpMessage(`Group image ${String(Date.now())}`);
      await chatPage.expectImageVisible(TIMEOUTS.MEDIA_DECODE);
      await chatPage.waitForStreamCycle(imageBaseline, TIMEOUTS.MEDIA_DECODE);
    });

    await test.step('owner generates a video inside the same group conversation', async () => {
      await chatPage.selectMode('video');
      await expect(authenticatedPage.getByRole('button', { name: /720p/i })).toBeVisible();

      const videoBaseline = await chatPage.captureStreamBaseline();
      await chatPage.sendFollowUpMessage(`Group video ${String(Date.now())}`);
      await chatPage.expectVideoVisible(TIMEOUTS.MEDIA_DECODE);
      await chatPage.waitForStreamCycle(videoBaseline, TIMEOUTS.MEDIA_DECODE);
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
      await guest.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      await guest.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(guest.getByTestId(TEST_IDS.sharedConversationLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
      await expect(guest.getByTestId(TEST_IDS.sharedConversationError)).not.toBeVisible();

      // expectImageVisible / expectVideoVisible park the relevant row in view
      // first, so iPhone-15 virtualization doesn't drop the tile from the DOM
      // before the assertion runs.
      const guestChatPage = new ChatPage(guest);
      await guestChatPage.expectImageVisible(TIMEOUTS.CONVERSATION_LOAD);
      const imageElement = guestChatPage.imagesIn(guestChatPage.messageList).first();
      await expect
        .poll(async () => imageElement.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
          timeout: TIMEOUTS.ASSERT,
        })
        .toBeGreaterThan(0);

      await guestChatPage.expectVideoVisible(TIMEOUTS.CONVERSATION_LOAD);
      const videoElement = guestChatPage.videosIn(guestChatPage.messageList).first();
      // Wait until the video reports a parseable duration (metadata loaded);
      // degrades to a "src bound" check on engines that can't decode.
      await expectVideoDecoded(videoElement, browserName, { timeout: TIMEOUTS.CONVERSATION_LOAD });
    });
  });
});
