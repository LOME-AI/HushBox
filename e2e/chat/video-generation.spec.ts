import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages';
import { assertCostAndNametagForFreshGeneration } from '../helpers/media-flows.js';
import { captureChatRoutePayload } from '../helpers/route-payload.js';
import { expectVideoDecoded } from '../helpers/webkit-media-decode.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { E2E_SEEDED_VIDEO_MODEL_IDS } from '../../scripts/lib/playwright/model-ids.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * Video generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default), which returns a canned VP9 WebM for
 * any video model — real decodable media, not a header stub. The catalog's
 * video models are all seeded synthetics
 * (`scripts/lib/playwright/seeded-video-model.ts`): no gateway video model is
 * zero-data-retention reachable, so the live refresh admits none. The test
 * asserts the UI round-trip: switch modality, configure video, send prompt, see
 * a `<video>` element render with a download button. Doesn't assert playback.
 */
test.describe('Video Generation', SPEC_MATRIX, () => {
  test('switches to video modality, generates, and renders inline', async ({
    authenticatedPage,
    browserName,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    // Aspect-ratio pills, resolution pills, and the duration slider live
    // inline on desktop and inside the bottom sheet on mobile. Open the
    // sheet to make them reachable on both layouts, then close it so the
    // composer isn't obscured.
    await chatPage.openGenerationSheetIfNeeded();

    await expect(
      authenticatedPage.getByRole('button', { name: '16:9', exact: true })
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole('button', { name: '9:16', exact: true })
    ).toBeVisible();
    const durationSlider = authenticatedPage.getByRole('slider', {
      name: /video duration in seconds/i,
    });
    await expect(durationSlider).toBeVisible();

    await chatPage.closeGenerationSheetIfOpen();

    const prompt = `Generate a clip of a cat surfing ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    await chatPage.expectVideoVisible();
    await chatPage.expectDownloadLinkVisible();

    // Proves the browser parsed the bytes (positive finite duration => moov
    // atom / EBML header read). expectVideoDecoded degrades to a "src bound"
    // check on engines that can't decode — see helper for the why.
    const videoElement = chatPage.videosIn(chatPage.messageList).first();
    await expectVideoDecoded(videoElement, browserName, { timeout: TIMEOUTS.ASSERT });
  });

  test('resolution buttons render with quality-tier label and pixel row', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.openGenerationSheetIfNeeded();

    // Mock Veo 3.1 supports 720p and 1080p. Each pill renders the quality
    // tier (HD/FHD) above the pixel row (720p/1080p). The accessible name is
    // the pixel row alone — price lives on `MediaCostLine`, not the button.
    const hdPill = authenticatedPage.getByRole('button', { name: '720p', exact: true });
    await expect(hdPill).toBeVisible();
    await expect(hdPill).toContainText('HD');
    await expect(hdPill).toContainText('720p');

    const fhdPill = authenticatedPage.getByRole('button', { name: '1080p', exact: true });
    await expect(fhdPill).toBeVisible();
    await expect(fhdPill).toContainText('FHD');
    await expect(fhdPill).toContainText('1080p');
  });

  /**
   * Cost AND nametag are visible on the generated video message — and the badge
   * is backed by an exact debit: the wallet loses the inline cost the provider
   * returned plus what the artifact's bytes and the prompt cost to store.
   */
  test('generated video displays cost badge and model nametag', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await assertCostAndNametagForFreshGeneration(chatPage, 'video');
  });

  /**
   * Page reload re-renders the generated video (presigned URL re-mint).
   * Uses the videoConversation fixture so the generation is already finalized
   * before the test body runs.
   */
  test('page reload re-renders the generated video', async ({ videoConversation }) => {
    test.slow();
    const chatPage = new ChatPage(videoConversation.page);
    await chatPage.expectVideoVisible();

    await videoConversation.page.reload();
    await chatPage.waitForConversationLoaded();

    await chatPage.expectVideoVisible();
    await chatPage.expectDownloadLinkVisible();
  });

  /** Regenerate replaces the video with a fresh response. */
  test('regenerate replaces the video with a fresh response', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Regenerate video ${String(Date.now())}`;
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    await chatPage.withStreamCycle(() => chatPage.clickRegenerate(1));
    await chatPage.expectVideoVisible();
  });

  /**
   * Edit on the user prompt opens the prompt editor; saving with new content
   * re-runs generation. The rendered <video> blob URL changes.
   */
  test('edit on user prompt regenerates a new video with edited content', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Edit-video initial ${String(Date.now())}`;
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    const originalSource = await chatPage
      .videosIn(chatPage.messageList)
      .first()
      .getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickEdit(0);
    await chatPage.expectEditModeActive();

    const editedMessage = `Edit-video edited ${String(Date.now())}`;
    await chatPage.messageInput.clear();
    await chatPage.messageInput.fill(editedMessage);
    await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    const editBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendButton.click();

    // Optimistic prune: the pre-edit user message and its AI reply both
    // disappear in the same React commit as the new edited message lands,
    // matching the state of a fresh send at the end of the conversation.
    await expect(chatPage.messageList.getByText(prompt, { exact: true })).toHaveCount(0, {
      timeout: TIMEOUTS.MODAL,
    });
    await expect(chatPage.videosWithSrcIn(chatPage.messageList, originalSource ?? '')).toHaveCount(
      0,
      { timeout: TIMEOUTS.MODAL }
    );

    await chatPage.expectMessageVisible(editedMessage);
    await chatPage.waitForStreamCycle(editBaseline);
    await chatPage.expectVideoVisible();

    await expect
      .poll(async () => chatPage.videosIn(chatPage.messageList).first().getAttribute('src'), {
        timeout: TIMEOUTS.ASSERT,
      })
      .not.toBe(originalSource);
  });

  /** Retry on the user prompt re-runs the same prompt and yields a fresh video. */
  test('retry on user prompt regenerates the video with the same prompt', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Retry-video ${String(Date.now())}`;
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamCycle(streamBaseline);

    const originalSource = await chatPage
      .videosIn(chatPage.messageList)
      .first()
      .getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.withStreamCycle(() => chatPage.clickRetry(0));
    await chatPage.expectVideoVisible();

    await chatPage.expectMessageVisible(prompt);
    await expect
      .poll(async () => chatPage.videosIn(chatPage.messageList).first().getAttribute('src'), {
        timeout: TIMEOUTS.ASSERT,
      })
      .not.toBe(originalSource);
  });

  /** A trial user finds Video in the mode menu, locked, with the sign-up reason. */
  test('trial user sees video mode locked with the sign-up reason', async ({
    unauthenticatedPage,
  }) => {
    const chatPage = new ChatPage(unauthenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.openModeMenu();
    const video = chatPage.modeMenuItem('video');
    await expect(video).toHaveAccessibleDescription(/sign up to unlock video generation/i);
    await expect(video).toBeDisabled();
  });

  /** The resolution choice flows through to the /chat request payload. */
  test('resolution choice flows through to /chat request payload', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectResolution('1080p');
    // `selectResolution` opens the bottom sheet on mobile; close it before
    // sending so the composer is interactive.
    await chatPage.closeGenerationSheetIfOpen();

    const captured = await captureChatRoutePayload(authenticatedPage);

    const prompt = `Resolution payload check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
    expect(JSON.stringify(captured.get())).toContain('1080p');
  });

  /**
   * The duration slider drives both the request payload AND the live cost preview.
   * The preview shows `≈ $X.YYY` based on duration × per-second price.
   */
  test('duration slider drives the live cost preview', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    // Both the slider and the cost preview live in the bottom sheet on mobile.
    // Open it once for the whole test; no need to close — the test never
    // sends a prompt.
    await chatPage.openGenerationSheetIfNeeded();

    const slider = authenticatedPage.getByRole('slider', { name: /video duration in seconds/i });
    const initialValue = await slider.inputValue();
    expect(Number(initialValue)).toBeGreaterThanOrEqual(1);

    const costLine = authenticatedPage.getByText(/^≈\s+\$\d+\.\d{3}$/).first();
    await expect(costLine).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    const initialCost = await costLine.textContent();

    // Bump duration up to its max (8 seconds for video on the mock).
    await chatPage.setVideoDuration(8);

    await expect(costLine).not.toHaveText(initialCost ?? '', { timeout: TIMEOUTS.MODAL });
  });

  /** The 9:16 aspect-ratio choice flows through to the /chat request. */
  test('9:16 aspect ratio choice flows through to /chat request', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectAspectRatio('9:16');
    // `selectAspectRatio` opens the bottom sheet on mobile; close it before
    // sending so the composer is reachable.
    await chatPage.closeGenerationSheetIfOpen();

    const captured = await captureChatRoutePayload(authenticatedPage);

    const prompt = `Portrait video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
    expect(JSON.stringify(captured.get())).toContain('9:16');
  });

  /**
   * Layout: the rendered <video> stays within the viewport width and within
   * the surrounding message bubble. Catches CSS regressions that would let
   * media overflow horizontally.
   */
  test('rendered video fits within viewport and message bubble bounds', async ({
    videoConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(videoConversation.page);
    await chatPage.expectVideoVisible();

    const viewport = videoConversation.page.viewportSize();
    expect(viewport, 'viewport size is required').not.toBeNull();
    const viewportWidth = viewport!.width;

    const videoElement = chatPage.videosIn(chatPage.messageList).first();
    const videoBox = await videoElement.boundingBox();
    expect(videoBox).not.toBeNull();
    expect(videoBox!.width).toBeLessThanOrEqual(viewportWidth);

    const bubble = chatPage.messagesByRole('assistant').first();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();

    expect(videoBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x - 1);
    expect(videoBox!.x + videoBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  });

  /** The <video> element has the `controls` attribute (per MediaPreview). */
  test('rendered video has playback controls', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Controls check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();

    const videoElement = chatPage.videosIn(chatPage.messageList).first();
    // The `controls` HTML attribute is present (any value, including empty string).
    const hasControls = await videoElement.evaluate((el) => (el as HTMLVideoElement).controls);
    expect(hasControls).toBe(true);
  });

  /**
   * Cost reflects the duration × resolution multiplier. We don't assert exact
   * values (those come from server-side billing); we assert that switching from
   * 720p to 1080p strictly increases the live cost preview at the same duration
   * — the differential the two resolutions are actually priced at.
   *
   * The preview is `pricePerSecondByResolution[resolution] × duration`
   * (use-prompt-budget.ts), so a tier priced higher per second must raise the
   * preview. Pinned to one seeded video model, whose catalog row surfaces both
   * 720p and 1080p and prices the second strictly above the first.
   */
  test('cost preview increases when switching from 720p to 1080p at fixed duration', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectSingleModel(E2E_SEEDED_VIDEO_MODEL_IDS[0]);
    // Open the sheet once; setVideoDuration / selectResolution rely on the
    // controls being mounted and the cost line lives in the sheet on mobile.
    await chatPage.openGenerationSheetIfNeeded();
    await chatPage.setVideoDuration(6);

    const costLine = authenticatedPage.getByText(/^≈\s+\$\d+\.\d{3}$/).first();
    await expect(costLine).toBeVisible({ timeout: TIMEOUTS.ASSERT });

    await chatPage.selectResolution('720p');
    await expect(costLine).toBeVisible();
    const lower = await costLine.textContent();

    await chatPage.selectResolution('1080p');
    // Re-fetch text — the same locator targets the updated DOM.
    await expect(costLine).not.toHaveText(lower ?? '', { timeout: TIMEOUTS.MODAL });
    const higher = await costLine.textContent();
    const lowerCents = Number((lower ?? '').replaceAll(/[^0-9.]/g, ''));
    const higherCents = Number((higher ?? '').replaceAll(/[^0-9.]/g, ''));
    expect(higherCents).toBeGreaterThan(lowerCents);
  });

  /**
   * The download link href is a blob URL (the user can save it locally).
   * Reuses the videoConversation fixture so the generate-and-wait pipeline
   * runs once during fixture setup rather than per-test.
   */
  test('download link href is a blob URL for the generated video', async ({
    videoConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(videoConversation.page);

    const href = await chatPage.getDownloadLinkHref();
    expect(href).toBeTruthy();
    expect(href).toMatch(/^blob:/);
  });

  /**
   * A signed-in payer on the free tier may not enter video modality at all:
   * every video model is premium, and the composer gates the switch on the
   * payer's premium reach rather than on their merely being signed in. The
   * remedy the control names is that payer's own — credit, never signing up for
   * the account they already hold.
   */
  test('free-tier payer is refused video modality with the credit remedy', async ({
    lowBalancePage,
  }) => {
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // The remedy is awaited as the item's description, which retries until the
    // payer's funding read lands, so the wording shown while premium reach is
    // still unknown can never be mistaken for the blocked answer.
    await chatPage.openModeMenu();
    const video = chatPage.modeMenuItem('video');
    await expect(video).toHaveAccessibleDescription('Add credit to unlock video generation', {
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(video).toBeDisabled();
    await expect(chatPage.modeMenu.getByText(/sign up to unlock/i)).toHaveCount(0);

    // Dispatched rather than clicked: the locked item is aria-disabled, which
    // Playwright's actionability reads as disabled, so a click would wait for it
    // to become enabled instead of reaching the handler that has to refuse.
    await video.dispatchEvent('click');

    // A refused choice leaves the menu open with Text still checked, which is
    // what says the composer stayed on text.
    await expect(chatPage.modeMenuItem('text')).toHaveAttribute('aria-checked', 'true');
    await expect(video).toHaveAttribute('aria-checked', 'false');

    // Nothing generated: no conversation was created and no artifact rendered.
    await expect(lowBalancePage).toHaveURL(/\/chat$/);
    await expect(chatPage.videosIn(chatPage.messageList)).toHaveCount(0);
  });
});
