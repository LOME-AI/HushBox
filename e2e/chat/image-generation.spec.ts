import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages';
import { assertCostAndNametagForFreshGeneration } from '../helpers/media-flows.js';
import { captureChatRoutePayload } from '../helpers/route-payload.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * Image generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default) which returns a canned PNG via
 * `bytedance-seed/seedream-4.5`. Asserts the UI round-trip: switch to image modality,
 * pick an aspect ratio, send prompt, see an `<img>` element render.
 */
test.describe('Image Generation', SPEC_MATRIX, () => {
  test('switches to image modality, generates, and renders inline', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    // The ratio tiles live in the "Aspect ratio" popover, a bottom sheet on
    // mobile. Open it from the ratio chip so the tile is reachable, then close
    // it so it doesn't block the composer.
    await chatPage.openGenerationSheetIfNeeded();
    await expect(
      authenticatedPage.getByRole('button', { name: '16:9', exact: true })
    ).toBeVisible();
    await chatPage.closeGenerationSheetIfOpen();

    const prompt = `A photo of a sunset over mountains ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    await chatPage.expectImageVisible();
    await chatPage.expectDownloadLinkVisible();

    // The canned PNG must actually decode in the browser. The mock now honors
    // the requested aspect ratio, scaling the long side to 1024: this flow uses
    // the default 1:1, so naturalWidth / naturalHeight are both 1024. A DOM-only
    // <img> assertion does not prove the bytes are valid; this does.
    const imgElement = chatPage.imagesIn(chatPage.messageList).first();
    await expect
      .poll(async () => imgElement.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: TIMEOUTS.ASSERT,
      })
      .toBe(1024);
    await expect
      .poll(async () => imgElement.evaluate((el) => (el as HTMLImageElement).naturalHeight), {
        timeout: TIMEOUTS.ASSERT,
      })
      .toBe(1024);
  });

  test('changing aspect ratio updates the active button state', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    // The tiles live in the "Aspect ratio" popover, opened from the ratio chip.
    // Exact match avoids matching that chip, whose accessible name embeds the
    // chosen ratio ("Aspect ratio: 1:1").
    await chatPage.openGenerationSheetIfNeeded();

    // 1:1 is default
    const oneToOne = authenticatedPage.getByRole('button', { name: '1:1', exact: true });
    const sixteenNine = authenticatedPage.getByRole('button', { name: '16:9', exact: true });
    await expect(oneToOne).toHaveAttribute('aria-pressed', 'true');
    await expect(sixteenNine).toHaveAttribute('aria-pressed', 'false');

    await sixteenNine.click();
    await expect(sixteenNine).toHaveAttribute('aria-pressed', 'true');
    await expect(oneToOne).toHaveAttribute('aria-pressed', 'false');
  });

  /**
   * Cost badge AND model nametag render on the generated image message — and
   * the badge is backed by an exact debit: the wallet loses the artifact's
   * catalog price plus what its bytes and the prompt cost to store.
   */
  test('generated image displays cost badge and model nametag', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await assertCostAndNametagForFreshGeneration(chatPage, 'image');
  });

  /**
   * Page reload re-renders the generated image. The presigned download URL
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

  /** Regenerate replaces the rendered image. Use clickRegenerate on the assistant message. */
  test('regenerate replaces the image with a fresh response', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Regenerate check ${String(Date.now())}`;
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    await chatPage.withStreamCycle(() => chatPage.clickRegenerate(1));

    // After regenerate, the new image renders. Re-assert that the message
    // list still shows an `<img>` (the old one was replaced, not removed).
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    const originalSource = await chatPage
      .imagesIn(chatPage.messageList)
      .first()
      .getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickEdit(0);
    await chatPage.expectEditModeActive();

    const editedMessage = `Edit-image edited ${String(Date.now())}`;
    await chatPage.messageInput.clear();
    await chatPage.messageInput.fill(editedMessage);
    await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    const editBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendButton.click();

    await chatPage.expectMessageVisible(editedMessage);
    await chatPage.waitForStreamCycle(editBaseline);
    await chatPage.expectImageVisible();

    // The re-sent turn regenerates the image; the first slot's blob src flips to
    // the new image only once that image decodes and renders, which is
    // media-decode-bound under the saturated matrix (firefox serializes the
    // decode behind every other worker). Budget for the decode, not a plain
    // assertion, so the swap isn't read before it lands.
    await expect
      .poll(async () => chatPage.imagesIn(chatPage.messageList).first().getAttribute('src'), {
        timeout: TIMEOUTS.MEDIA_DECODE,
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectImageVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    const originalSource = await chatPage
      .imagesIn(chatPage.messageList)
      .first()
      .getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.withStreamCycle(() => chatPage.clickRetry(0));
    await chatPage.expectImageVisible();

    await chatPage.expectMessageVisible(prompt);
    // The re-sent turn regenerates the image; the first slot's blob src flips to
    // the new image only once that image decodes and renders, which is
    // media-decode-bound under the saturated matrix (firefox serializes the
    // decode behind every other worker). Budget for the decode, not a plain
    // assertion, so the swap isn't read before it lands.
    await expect
      .poll(async () => chatPage.imagesIn(chatPage.messageList).first().getAttribute('src'), {
        timeout: TIMEOUTS.MEDIA_DECODE,
      })
      .not.toBe(originalSource);
  });

  /**
   * A trial (unauthenticated) user finds Image in the mode menu, locked, with
   * "sign up to unlock" as its reason. The item stays in the menu rather than
   * being hidden, keeping the mode discoverable for trial users.
   */
  test('trial user sees image mode locked with the sign-up reason', async ({
    unauthenticatedPage,
  }) => {
    const chatPage = new ChatPage(unauthenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.openModeMenu();
    const image = chatPage.modeMenuItem('image');
    await expect(image).toHaveAccessibleDescription(/sign up to unlock image generation/i);
    await expect(image).toBeDisabled();
  });

  /**
   * Aspect ratio change drives the request payload sent to /chat.
   * Intercept the chat request and assert the `imageConfig.aspectRatio` reflects
   * the user's selection.
   */
  test('aspect ratio choice flows through to /chat request payload', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    await chatPage.selectAspectRatio('16:9');
    // `selectAspectRatio` opens the "Aspect ratio" popover to reach the tile;
    // close it before sending so the composer is reachable.
    await chatPage.closeGenerationSheetIfOpen();

    const captured = await captureChatRoutePayload(authenticatedPage);

    const prompt = `Aspect-ratio payload check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
    expect(JSON.stringify(captured.get())).toContain('16:9');
  });

  /**
   * Download link points to an object URL (blob:...) the user can
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

  /** The send button transitions from disabled (no content) → disabled (streaming) → enabled (content typed, no stream). */
  test('send button is disabled while image is generating', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();
    const prompt = `Disable-while-generating ${String(Date.now())}`;
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    // While streaming, the send button shows the stop icon and is disabled.
    // The button toggles to enabled only when (a) streaming has completed AND
    // (b) the textarea has new content — `canSubmitMessage` requires both
    // `!isProcessing` and `hasContent`. Type a new prompt after stream complete
    // to satisfy `hasContent`, then assert the button leaves its disabled
    // state.
    await chatPage.waitForStreamCycle(streamBaseline);
    await chatPage.messageInput.fill('next prompt');
    await expect(chatPage.sendButton).toBeEnabled();
  });

  /** Empty image prompt does not send (send button disabled). */
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

    const imgElement = chatPage.imagesIn(chatPage.messageList).first();
    const imgBox = await imgElement.boundingBox();
    expect(imgBox).not.toBeNull();
    expect(imgBox!.width).toBeLessThanOrEqual(viewportWidth);

    const bubble = chatPage.messagesByRole('assistant').first();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();

    // Image fits horizontally inside the bubble bounds (allowing small fudge
    // for sub-pixel rounding from boundingBox).
    expect(imgBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x - 1);
    expect(imgBox!.x + imgBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  });

  /** A long image prompt is accepted without truncation (generation completes). */
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
   * A signed-in payer on the free tier may not enter image modality at all:
   * every image model is premium, and the composer gates the switch on the
   * payer's premium reach rather than on their merely being signed in. The
   * remedy the control names is that payer's own — credit, never signing up for
   * the account they already hold.
   */
  test('free-tier payer is refused image modality with the credit remedy', async ({
    lowBalancePage,
  }) => {
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // The remedy is awaited as the item's description, which retries until the
    // payer's funding read lands, so the wording shown while premium reach is
    // still unknown can never be mistaken for the blocked answer.
    await chatPage.openModeMenu();
    const image = chatPage.modeMenuItem('image');
    await expect(image).toHaveAccessibleDescription('Add credit to unlock image generation', {
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(image).toBeDisabled();
    await expect(chatPage.modeMenu.getByText(/sign up to unlock/i)).toHaveCount(0);

    // Dispatched rather than clicked: the locked item is aria-disabled, which
    // Playwright's actionability reads as disabled, so a click would wait for it
    // to become enabled instead of reaching the handler that has to refuse.
    await image.dispatchEvent('click');

    // A refused choice leaves the menu open with Text still checked, which is
    // what says the composer stayed on text.
    await expect(chatPage.modeMenuItem('text')).toHaveAttribute('aria-checked', 'true');
    await expect(image).toHaveAttribute('aria-checked', 'false');

    // Nothing generated: no conversation was created and no artifact rendered.
    await expect(lowBalancePage).toHaveURL(/\/chat$/);
    await expect(chatPage.imagesIn(chatPage.messageList)).toHaveCount(0);
  });

  /**
   * When the presigned download URL fetch fails (R2 returns 5xx),
   * the UI must surface the media-error placeholder rather than rendering a
   * broken `<img src=""/>`. The simplest way to reproduce the failure end-to-
   * end is to intercept GET `/media/:id/download-url` after the page has
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
    expectApiErrors(page, [
      /500 Internal Server Error GET .*\/media\/.*\/download-url/,
      /"code":"STORAGE_READ_FAILED"/,
    ]);
    expectConsoleErrors(page, [
      /Failed to load resource: the server responded with a status of 500/,
    ]);
    await page.route('**/media/*/download-url', async (route) => {
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
    await expect(errorPlaceholder.first()).toBeVisible({ timeout: TIMEOUTS.STREAM });

    const imgs = chatPage.imagesIn(chatPage.messageList);
    await expect(imgs).toHaveCount(0);

    // Sanity: no img element with empty src exists either (which would render
    // a broken-image icon in browsers and be a regression).
    const brokenImgs = chatPage.brokenImagesIn(chatPage.messageList);
    await expect(brokenImgs).toHaveCount(0);
  });
});
