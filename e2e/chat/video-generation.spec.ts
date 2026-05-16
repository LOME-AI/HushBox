import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';
import { assertCostAndNametagForFreshGeneration } from '../helpers/media-flows.js';

/**
 * Video generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default) which returns a canned MP4 via
 * `google/veo-3.1`. The test asserts the UI round-trip: switch modality,
 * configure video, send prompt, see a `<video>` element render with a download
 * button. Doesn't assert playback — the canned bytes aren't enough frames.
 *
 * Coverage matrix: see plan §C (C1..C17). Each test below is mapped to its
 * plan id in the test name comment.
 */
test.describe('Video Generation', () => {
  test('switches to video modality, generates, and renders inline', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();

    await expect(authenticatedPage.getByRole('button', { name: '16:9' })).toBeVisible();
    await expect(authenticatedPage.getByRole('button', { name: '9:16' })).toBeVisible();
    const durationSlider = authenticatedPage.getByRole('slider', {
      name: /video duration in seconds/i,
    });
    await expect(durationSlider).toBeVisible();

    const prompt = `Generate a clip of a cat surfing ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    await chatPage.expectVideoVisible();
    await chatPage.expectDownloadLinkVisible();

    // The canned MP4 must actually decode in the browser — a positive finite
    // duration proves the browser parsed the moov atom. We don't assert the
    // exact value because short-clip duration varies across decoders
    // (Chromium/WebKit/Firefox disagree on the same MP4 by hundreds of ms).
    // DOM-only <video> assertions don't prove the bytes are valid; this does.
    const videoElement = chatPage.messageList.locator('video').first();
    await expect
      .poll(
        async () =>
          videoElement.evaluate((el) => {
            const v = el as HTMLVideoElement;
            return Number.isFinite(v.duration) ? v.duration : 0;
          }),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);
  });

  test('resolution button labels include per-second price', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();

    // Mock Veo 3.1 prices 720p/1080p — labels should render as "720p $0.10/s" etc.
    const resButton = authenticatedPage.getByRole('button', { name: /720p\s+\$\d+\.\d+\/s/i });
    await expect(resButton).toBeVisible();
  });

  /** C1+C2: cost AND nametag visible on the generated video message. */
  test('generated video displays cost badge and model nametag', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await assertCostAndNametagForFreshGeneration(chatPage, 'video');
  });

  /**
   * C3: page reload re-renders the generated video (presigned URL re-mint).
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

  /** C5: regenerate replaces the video with a fresh response. */
  test('regenerate replaces the video with a fresh response', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const prompt = `Regenerate video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    await chatPage.clickRegenerate(1);
    await chatPage.waitForStreamComplete();
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
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    const originalSource = await chatPage.messageList.locator('video').first().getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickEdit(0);
    await chatPage.expectEditModeActive();

    const editedMessage = `Edit-video edited ${String(Date.now())}`;
    await chatPage.messageInput.clear();
    await chatPage.messageInput.fill(editedMessage);
    await expect(chatPage.sendButton).toBeEnabled({ timeout: 15_000 });
    await chatPage.sendButton.click();

    await chatPage.expectMessageVisible(editedMessage);
    await chatPage.waitForStreamComplete();
    await chatPage.expectVideoVisible();

    await expect
      .poll(async () => chatPage.messageList.locator('video').first().getAttribute('src'), {
        timeout: 10_000,
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
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectVideoVisible();
    await chatPage.waitForStreamComplete();

    const originalSource = await chatPage.messageList.locator('video').first().getAttribute('src');
    expect(originalSource).toMatch(/^blob:/);

    await chatPage.clickRetry(0);
    await chatPage.waitForStreamComplete();
    await chatPage.expectVideoVisible();

    await chatPage.expectMessageVisible(prompt);
    await expect
      .poll(async () => chatPage.messageList.locator('video').first().getAttribute('src'), {
        timeout: 10_000,
      })
      .not.toBe(originalSource);
  });

  /** C7: trial user sees the video modality icon disabled with sign-up tooltip. */
  test('trial user sees video modality icon disabled with sign-up tooltip', async ({
    unauthenticatedPage,
  }) => {
    const chatPage = new ChatPage(unauthenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    const videoIconWrapper = unauthenticatedPage.getByRole('button', {
      name: /video generation.*sign up to unlock/i,
    });
    await expect(videoIconWrapper).toBeVisible();
  });

  /** C13: resolution choice flows through to the /api/chat request payload. */
  test('resolution choice flows through to /api/chat request payload', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectResolution('1080p');

    let chatPayload: unknown;
    await authenticatedPage.route('**/api/chat/**', async (route) => {
      const postData = route.request().postData();
      if (postData) {
        chatPayload = JSON.parse(postData) as unknown;
      }
      await route.continue();
    });

    const prompt = `Resolution payload check ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(() => chatPayload, { timeout: 10_000 }).toBeDefined();
    expect(JSON.stringify(chatPayload)).toContain('1080p');
  });

  /**
   * C14: duration slider drives both request payload AND the live cost preview.
   * The preview shows `≈ $X.YYY` based on duration × per-second price.
   */
  test('duration slider drives the live cost preview', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    const slider = authenticatedPage.getByRole('slider', { name: /video duration in seconds/i });
    const initialValue = await slider.inputValue();
    expect(Number(initialValue)).toBeGreaterThanOrEqual(1);

    const costLine = authenticatedPage.locator(String.raw`text=/^≈\s+\$\d+\.\d{3}$/`).first();
    await expect(costLine).toBeVisible({ timeout: 10_000 });
    const initialCost = await costLine.textContent();

    // Bump duration up to its max (8 seconds for video on the mock).
    await chatPage.setVideoDuration(8);

    await expect(async () => {
      const updatedCost = await costLine.textContent();
      expect(updatedCost).not.toBe(initialCost);
    }).toPass({ timeout: 5000 });
  });

  /** C15: 9:16 aspect ratio choice flows through to the /api/chat request. */
  test('9:16 aspect ratio choice flows through to /api/chat request', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectAspectRatio('9:16');

    let chatPayload: unknown;
    await authenticatedPage.route('**/api/chat/**', async (route) => {
      const postData = route.request().postData();
      if (postData) {
        chatPayload = JSON.parse(postData) as unknown;
      }
      await route.continue();
    });

    const prompt = `Portrait video ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    await expect.poll(() => chatPayload, { timeout: 10_000 }).toBeDefined();
    expect(JSON.stringify(chatPayload)).toContain('9:16');
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

    const videoElement = chatPage.messageList.locator('video').first();
    const videoBox = await videoElement.boundingBox();
    expect(videoBox).not.toBeNull();
    expect(videoBox!.width).toBeLessThanOrEqual(viewportWidth);

    const bubble = chatPage.messageList.locator('[data-role="assistant"]').first();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();

    expect(videoBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x - 1);
    expect(videoBox!.x + videoBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
  });

  /** C16: <video> element has the `controls` attribute (per MediaPreview). */
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

    const videoElement = chatPage.messageList.locator('video').first();
    // The `controls` HTML attribute is present (any value, including empty string).
    const hasControls = await videoElement.evaluate((el) => (el as HTMLVideoElement).controls);
    expect(hasControls).toBe(true);
  });

  /**
   * C17: cost reflects duration × resolution multiplier. We don't assert exact
   * values (those come from server-side billing); we assert that switching from
   * 1080p to 4k strictly increases the live cost preview at the same duration.
   *
   * Pinned to Veo 3.1 Fast because Veo 3.0 Fast prices 720p and 1080p the same
   * (real Google pricing — not a mock bug), so a per-resolution differential
   * only shows up against models that surface 4k. Veo 3.1 supports `[4, 6, 8]s`.
   */
  test('cost preview increases when switching from 1080p to 4k at fixed duration', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();
    await chatPage.selectSingleModel('google/veo-3.1-fast-generate-001');
    await chatPage.setVideoDuration(6);

    const costLine = authenticatedPage.locator(String.raw`text=/^≈\s+\$\d+\.\d{3}$/`).first();
    await expect(costLine).toBeVisible({ timeout: 10_000 });

    await chatPage.selectResolution('1080p');
    await expect(costLine).toBeVisible();
    const lower = await costLine.textContent();

    await chatPage.selectResolution('4k');
    // Re-fetch text — the same locator targets the updated DOM.
    await expect(async () => {
      const higher = await costLine.textContent();
      expect(higher).not.toBe(lower);
      const lowerCents = Number((lower ?? '').replaceAll(/[^0-9.]/g, ''));
      const higherCents = Number((higher ?? '').replaceAll(/[^0-9.]/g, ''));
      expect(higherCents).toBeGreaterThan(lowerCents);
    }).toPass({ timeout: 5000 });
  });

  /**
   * C10: download link href is a blob URL (the user can save it locally).
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
   * Free-tier user (zero balance) in video mode: every video model is premium
   * so no model auto-resolves and the resolution panel renders its empty-state
   * hint ("Select a video model to see resolution options"). Model selector
   * shows the lock icon on every video model. Cost preflight is unreachable
   * by design — the test verifies the gating UX, not a cost-denial banner.
   */
  test('free-tier user sees video models locked and cannot generate', async ({
    lowBalancePage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // Don't use `switchToVideoMode()` — that helper asserts the 720p button is
    // visible, which only happens once a video model is selected. Free-tier
    // users can enter the modality but the resolution panel stays empty.
    const videoIcon = lowBalancePage.getByRole('button', { name: /switch to video/i });
    await expect(videoIcon).toBeVisible();
    await videoIcon.click();

    await expect(
      lowBalancePage.getByText(/Select a video model to see resolution options/i)
    ).toBeVisible({ timeout: 10_000 });
    await expect(lowBalancePage.getByRole('button', { name: /720p/i })).toHaveCount(0);

    await test.step('all video models in the modal show the premium lock icon', async () => {
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

    await expect(lowBalancePage).toHaveURL(/\/chat$/);
    await expect(chatPage.messageList.locator('video')).toHaveCount(0);
  });
});
