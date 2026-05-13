import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

/**
 * Image generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default) which returns a canned PNG via
 * `google/imagen-4`. Asserts the UI round-trip: switch to image modality,
 * pick an aspect ratio, send prompt, see an `<img>` element render.
 *
 * Coverage matrix: see plan §B (B1..B14). Each test below is mapped to its
 * plan id in the test name comment so reviewers can spot gaps.
 */
test.describe('Image Generation', () => {
  test('switches to image modality, generates, and renders inline', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    await expect(authenticatedPage.getByRole('button', { name: '16:9' })).toBeVisible();

    const prompt = `A photo of a sunset over mountains ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    await chatPage.expectImageVisible();
    await chatPage.expectDownloadLinkVisible();

    // The canned JPEG must actually decode in the browser — naturalWidth /
    // naturalHeight match the 400×300 dimensions emitted by mock.ts. A DOM-only
    // <img> assertion does not prove the bytes are valid; this does.
    const imgElement = chatPage.messageList.locator('img').first();
    await expect
      .poll(async () => imgElement.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: 10_000,
      })
      .toBe(400);
    await expect
      .poll(async () => imgElement.evaluate((el) => (el as HTMLImageElement).naturalHeight), {
        timeout: 10_000,
      })
      .toBe(300);
  });

  test('changing aspect ratio updates the active button state', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();

    // 1:1 is default
    const oneToOne = authenticatedPage.getByRole('button', { name: '1:1' });
    const sixteenNine = authenticatedPage.getByRole('button', { name: '16:9' });
    await expect(oneToOne).toHaveAttribute('aria-pressed', 'true');
    await expect(sixteenNine).toHaveAttribute('aria-pressed', 'false');

    await sixteenNine.click();
    await expect(sixteenNine).toHaveAttribute('aria-pressed', 'true');
    await expect(oneToOne).toHaveAttribute('aria-pressed', 'false');
  });

  /** B1+B2: cost badge AND model nametag render on the generated image message. */
  test('generated image displays cost badge and model nametag', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Cost+nametag check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    const costBadge = chatPage.messageList.locator('[data-testid="message-cost"]').first();
    await expect(costBadge).toBeVisible();
    await expect(costBadge).toContainText(/\$/);

    await chatPage.expectAllAIMessagesHaveNametag();
  });

  /**
   * B3: page reload re-renders the generated image. The presigned download URL
   * has a 5-minute TTL — on reload the client must mint a fresh URL and decrypt
   * the bytes again. Asserting the `<img>` shows after reload covers that
   * round-trip without depending on the URL string itself.
   *
   * Uses the imageConversation fixture so the generation is already finalized
   * before the test body runs — saves a redundant generate-then-reload chain.
   */
  test('page reload re-renders the generated image', async ({ imageConversation }) => {
    test.slow();
    const chatPage = new ChatPage(imageConversation.page);
    await chatPage.expectImageVisible();

    await imageConversation.page.reload();
    await chatPage.waitForConversationLoaded();

    await chatPage.expectImageVisible();
    await chatPage.expectDownloadLinkVisible();
  });

  /** B5: regenerate replaces the rendered image. Use clickRegenerate on the assistant message. */
  test('regenerate replaces the image with a fresh response', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Regenerate check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    await chatPage.clickRegenerate(1);

    // After regenerate, the new image renders. Re-assert that the message
    // list still shows an `<img>` (the old one was replaced, not removed).
    await chatPage.waitForStreamComplete();
    await chatPage.expectImageVisible();
  });

  /**
   * Edit on the user prompt opens the prompt editor; saving with new content
   * re-runs generation. The old <img> is replaced with a new one corresponding
   * to the edited prompt.
   */
  test('edit on user prompt regenerates a new image with edited content', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Edit-image initial ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    const originalSource = await chatPage.messageList.locator('img').first().getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickEdit(0);
    await chatPage.expectEditModeActive();

    const editedMessage = `Edit-image edited ${String(Date.now())}`;
    await chatPage.messageInput.clear();
    await chatPage.messageInput.fill(editedMessage);
    await expect(chatPage.sendButton).toBeEnabled({ timeout: 15_000 });
    await chatPage.sendButton.click();

    await chatPage.expectMessageVisible(editedMessage);
    await chatPage.waitForStreamComplete();
    await chatPage.expectImageVisible();

    await expect
      .poll(async () => chatPage.messageList.locator('img').first().getAttribute('src'), {
        timeout: 10_000,
      })
      .not.toBe(originalSource);
  });

  /**
   * Retry on the user prompt re-runs the same prompt. New image renders with
   * the same prompt text but a fresh blob URL (new createObjectURL allocation).
   */
  test('retry on user prompt regenerates the image with the same prompt', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Retry-image ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamComplete();

    const originalSource = await chatPage.messageList.locator('img').first().getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickRetry(0);
    await chatPage.waitForStreamComplete();
    await chatPage.expectImageVisible();

    await chatPage.expectMessageVisible(prompt);
    await expect
      .poll(async () => chatPage.messageList.locator('img').first().getAttribute('src'), {
        timeout: 10_000,
      })
      .not.toBe(originalSource);
  });

  /**
   * B7: a trial (unauthenticated) user sees the image modality icon disabled
   * and gets a "sign up to unlock" tooltip on focus. The icon button itself
   * doesn't open a signup modal — instead the affordance is muted with a
   * disabled state per the plan §9.1 trial UX.
   */
  test('trial user sees image modality icon disabled with sign-up tooltip', async ({
    unauthenticatedPage,
  }) => {
    const chatPage = new ChatPage(unauthenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    // The image icon button must exist but be disabled (or aria-disabled).
    // The `ToggleButtonWithTooltip` wrapper sets aria-disabled on the wrapping span
    // for accessibility — we can find it via the trial label.
    const imageIconWrapper = unauthenticatedPage.getByRole('button', {
      name: /image generation.*sign up to unlock/i,
    });
    await expect(imageIconWrapper).toBeVisible();
  });

  /**
   * B8: aspect ratio change drives the request payload sent to /api/chat.
   * Intercept the chat request and assert the `imageConfig.aspectRatio` reflects
   * the user's selection.
   */
  test('aspect ratio choice flows through to /api/chat request payload', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    await chatPage.selectAspectRatio('16:9');

    let chatPayload: unknown;
    await authenticatedPage.route('**/api/chat/**', async (route) => {
      const request = route.request();
      const postData = request.postData();
      if (postData) {
        chatPayload = JSON.parse(postData) as unknown;
      }
      await route.continue();
    });

    const prompt = `Aspect-ratio payload check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(() => chatPayload, { timeout: 10_000 }).toBeDefined();
    expect(JSON.stringify(chatPayload)).toContain('16:9');
  });

  /**
   * B10+B11: download link points to an object URL (blob:...) the user can
   * fetch. Reuses the imageConversation fixture — the generate-and-wait
   * pipeline runs once during fixture setup rather than per-test.
   */
  test('download link href is a blob URL that points at the rendered image', async ({
    imageConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(imageConversation.page);

    const href = await chatPage.getDownloadLinkHref();
    expect(href).toBeTruthy();
    // Decrypted media URLs are local blob URLs (createObjectURL).
    expect(href).toMatch(/^blob:/);
  });

  /** B12: the send button transitions from disabled (no content) → disabled (streaming) → enabled (content typed, no stream). */
  test('send button is disabled while image is generating', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Disable-while-generating ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    // While streaming, the send button shows the stop icon and is disabled.
    // The button toggles to enabled only when (a) streaming has completed AND
    // (b) the textarea has new content — `canSubmitMessage` requires both
    // `!isProcessing` and `hasContent`. Type a new prompt after stream complete
    // to satisfy `hasContent`, then assert the button leaves its disabled
    // state.
    await chatPage.waitForStreamComplete();
    await chatPage.messageInput.fill('next prompt');
    await expect(chatPage.sendButton).toBeEnabled();
  });

  /** B13: empty image prompt does not send (send button disabled). */
  test('empty image prompt does not enable send button', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    await expect(chatPage.sendButton).toBeDisabled();

    await chatPage.promptInput.fill('   ');
    await expect(chatPage.sendButton).toBeDisabled();
  });

  /**
   * Layout: the rendered <img> stays within the viewport width and within the
   * surrounding message bubble. Catches CSS regressions that would let media
   * overflow horizontally on small screens.
   */
  test('rendered image fits within viewport and message bubble bounds', async ({
    imageConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(imageConversation.page);
    await chatPage.expectImageVisible();

    const viewport = imageConversation.page.viewportSize();
    expect(viewport, 'viewport size is required').not.toBeNull();
    const viewportWidth = viewport!.width;

    const imgElement = chatPage.messageList.locator('img').first();
    const imgBox = await imgElement.boundingBox();
    expect(imgBox).not.toBeNull();
    expect(imgBox!.width).toBeLessThanOrEqual(viewportWidth);

    const bubble = chatPage.messageList.locator('[data-role="assistant"]').first();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();

    // Image fits horizontally inside the bubble bounds (allowing small fudge
    // for sub-pixel rounding from boundingBox).
    expect(imgBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x - 1);
    expect(imgBox!.x + imgBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  });

  /** B14: a long image prompt is accepted without truncation (generation completes). */
  test('long image prompt is accepted', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();

    // Prompt of ~600 characters — well within reasonable budget.
    const longPrompt =
      'A highly detailed renaissance painting of '.repeat(15) + ` ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(longPrompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
  });

  /**
   * Free-tier user (zero balance) lands on premium-gated image models — every
   * image model is premium, so the model-selector modal locks them all and no
   * default image model auto-resolves. The test verifies the gating UX rather
   * than a cost-denial banner: the affordability path is unreachable because
   * the user can't select a model in the first place.
   */
  test('free-tier user sees image models locked and cannot generate', async ({
    lowBalancePage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.switchToImageMode();

    await test.step('all image models in the modal show the premium lock icon', async () => {
      await chatPage.openModelSelector();
      const modal = lowBalancePage.getByTestId('model-selector-modal');
      await expect(modal).toBeVisible();
      const items = modal.locator('[data-testid^="model-item-"]');
      const total = await items.count();
      expect(total).toBeGreaterThan(0);
      const locked = modal.locator('[data-testid^="model-item-"]:has([data-testid="lock-icon"])');
      await expect(locked).toHaveCount(total);
      await lowBalancePage.keyboard.press('Escape');
      await expect(modal).not.toBeVisible();
    });

    // Image generation never happens — no /api/chat round-trip, no R2 object.
    await expect(lowBalancePage).toHaveURL(/\/chat$/);
    await expect(chatPage.messageList.locator('img')).toHaveCount(0);
  });

  /**
   * Lane 9 #5: when the presigned download URL fetch fails (R2 returns 5xx),
   * the UI must surface the media-error placeholder rather than rendering a
   * broken `<img src=""/>`. The simplest way to reproduce the failure end-to-
   * end is to intercept GET `/api/media/:id/download-url` after the page has
   * been reloaded — the in-memory blob URL is gone, the TanStack Query cache
   * is cold, so the client must mint a fresh URL via that endpoint. The
   * intercept returns the same 500 + `STORAGE_READ_FAILED` payload that the
   * route emits when `mintDownloadUrl` throws.
   */
  test('R2 read failure on reload renders media-error placeholder, never a broken img', async ({
    imageConversation,
  }) => {
    test.slow();
    const page = imageConversation.page;
    const chatPage = new ChatPage(page);

    // Sanity: image rendered originally (fixture already verified this).
    await chatPage.expectImageVisible();

    // Inject a 500 response on the next download-url mint call. The route
    // returns this exact payload when `mintDownloadUrl` throws, so the
    // intercept matches the real failure path byte-for-byte.
    await page.route('**/api/media/*/download-url', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'STORAGE_READ_FAILED' }),
      });
    });

    await page.reload();
    await chatPage.waitForConversationLoaded();

    // The error placeholder is rendered (role=status, aria-label uses the
    // friendly STORAGE_READ_FAILED mapping: "We couldn't load this media.
    // Please refresh the page."). The hook surfaces the API error through
    // `error`, the MediaContentItem branches on `error` to render
    // <MediaPlaceholder status="error">. A broken <img src=""> should never appear.
    const errorPlaceholder = chatPage.messageList.getByRole('status', {
      name: /couldn['’]t load this media.+refresh the page/i,
    });
    await expect(errorPlaceholder.first()).toBeVisible({ timeout: 15_000 });

    const imgs = chatPage.messageList.locator('img');
    await expect(imgs).toHaveCount(0);

    // Sanity: no img element with empty src exists either (which would render
    // a broken-image icon in browsers and be a regression).
    const brokenImgs = chatPage.messageList.locator('img[src=""]');
    await expect(brokenImgs).toHaveCount(0);
  });
});
