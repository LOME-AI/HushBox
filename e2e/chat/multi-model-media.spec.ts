import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';
import { assertPartialFailurePersistence } from '../helpers/partial-failure.js';
import { TIMEOUTS } from '../config/timeouts.js';

const IMAGE_MODELS = [
  'google/imagen-4.0-generate-001',
  'google/imagen-4.0-fast-generate-001',
] as const;
const VIDEO_MODELS = ['google/veo-3.1-generate-001', 'google/veo-3.1-fast-generate-001'] as const;

/**
 * Multi-model media (image + video) coverage (plan §E1-E5).
 *
 * Targets the mock-served image/video models declared in `mock.ts`. Each
 * selection opens the model selector modal directly addressing items by id
 * (`model-item-<id>`) so the tests do not rely on the default-sort ordering.
 */
test.describe('Multi-Model Media', () => {
  /** E1: select 2 image models, send prompt → both `<img>` elements render with distinct nametags. */
  test('two image models render distinct images and nametags', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();

    await test.step('select two image models in the modal', async () => {
      await chatPage.selectModelsByIds(IMAGE_MODELS);
    });

    const prompt = `Multi-image ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    // Wait for both assistant messages to land (cost-count = 2 + user = expected total).
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

    // Conversation is [user, ai1, ai2]. Address by Virtuoso row index so the
    // assertions don't depend on which messages are currently rendered.
    await chatPage.expectMediaVisibleAt(1, 'img', TIMEOUTS.MEDIA_DECODE);
    const tag1 = chatPage.getMessage(1).getByTestId(TEST_IDS.modelNametag);
    const image1 = chatPage.getMessage(1).locator('img').first();
    const source1 = await image1.getAttribute('src');

    await chatPage.expectMediaVisibleAt(2, 'img', TIMEOUTS.MEDIA_DECODE);
    const tag2 =
      (await chatPage.getMessage(2).getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';
    const source2 = await chatPage.getMessage(2).locator('img').first().getAttribute('src');

    await expect(tag1).not.toHaveText(tag2);
    // Distinct decrypted blob URLs — each <img> must have its own object URL,
    // not share a single source.
    expect(source1).toMatch(/^blob:/);
    expect(source2).toMatch(/^blob:/);
    await expect(image1).not.toHaveAttribute('src', source2 ?? '');

    // Cost row count must mirror the assistant count (one cost per response).
    await expect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
      timeout: TIMEOUTS.STREAM,
    });
  });

  /**
   * E2: with 2 image models selected, mark one as failing via /api/dev/fail-model.
   * The successful model renders an image; the failing model surfaces the standard
   * model-error tile.
   */
  test('failing image model shows error tile while successful one renders', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();

    const failModel = IMAGE_MODELS[1];

    await test.step('select 2 image models and mark the second as failing', async () => {
      await chatPage.selectModelsByIds(IMAGE_MODELS);
      await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModel });
    });

    try {
      await chatPage.sendNewChatMessage(`Image partial failure ${String(Date.now())}`);
      await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

      const successImage = chatPage.messageList.locator('[data-role="assistant"] img');
      await expect(successImage.first()).toBeVisible({ timeout: TIMEOUTS.STREAM });

      const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
      // Scroll into view before asserting. Virtuoso's overscan keeps the row
      // mounted (see message-list.tsx `increaseViewportBy`), but post-stream
      // layout shift (media bytes resolving) can land it just outside the
      // visible area. The scroll is a no-op when the row is already visible.
      await errorTile.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.STREAM });
      await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.STREAM });

      // Lane 9 #6: server-side persistence parity with text partial-failure.
      // Only the successful model's response has a persisted content item with
      // `cost > 0`; the failing model never wrote any content_items rows.
      await assertPartialFailurePersistence(authenticatedPage, {
        succeededModelId: IMAGE_MODELS[0],
        failedModelId: failModel,
      });
    } finally {
      await authenticatedPage.setExtraHTTPHeaders({});
    }
  });

  /**
   * E4: forking a multi-model image conversation preserves both sibling responses
   * on the original branch (the fork creates a new branch with the user message
   * but the previous branch still has both image responses).
   */
  test('fork from multi-model image branch keeps both siblings on the source branch', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();

    await chatPage.selectModelsByIds(IMAGE_MODELS);

    await chatPage.sendNewChatMessage(`Fork-multi-image ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

    // Fork on the first assistant message (row index 1: [user, ai1, ai2]).
    await chatPage.clickFork(1);
    await chatPage.expectForkTabCount(2);
    await chatPage.expectActiveForkTab('Fork 1');

    await chatPage.clickForkTab('Main');
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.STREAM,
    });
    await chatPage.expectMediaVisibleAt(1, 'img', TIMEOUTS.STREAM);
    await chatPage.expectMediaVisibleAt(2, 'img', TIMEOUTS.STREAM);
  });

  /**
   * E5: 2 video models selected — both <video> elements visible after streams
   * complete (race-free finalization between modalities).
   */
  test('two video models render distinct videos race-free', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();

    await chatPage.selectModelsByIds(VIDEO_MODELS);

    await chatPage.sendNewChatMessage(`Multi-video ${String(Date.now())}`);
    await chatPage.waitForConversation();

    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

    await chatPage.expectMediaVisibleAt(1, 'video', TIMEOUTS.MEDIA_DECODE);
    const tag1 = chatPage.getMessage(1).getByTestId(TEST_IDS.modelNametag);
    await chatPage.expectMediaVisibleAt(2, 'video', TIMEOUTS.MEDIA_DECODE);
    const tag2 =
      (await chatPage.getMessage(2).getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';
    await expect(tag1).not.toHaveText(tag2);

    // Cost row count must mirror the assistant count (one cost per response).
    await expect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
      timeout: TIMEOUTS.STREAM,
    });
  });

  /**
   * E2-equivalent for video: with two video models selected, mark the second as
   * failing via /api/dev/fail-model. The successful model renders a <video>
   * element; the failing one surfaces the standard model-error tile.
   */
  test('failing video model shows error tile while successful one renders', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();

    const failModel = VIDEO_MODELS[1];

    await test.step('select 2 video models and mark the second as failing', async () => {
      await chatPage.selectModelsByIds(VIDEO_MODELS);
      await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModel });
    });

    try {
      await chatPage.sendNewChatMessage(`Video partial failure ${String(Date.now())}`);
      await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

      const successVideo = chatPage.messageList.locator('[data-role="assistant"] video');
      await expect(successVideo.first()).toBeVisible({ timeout: TIMEOUTS.STREAM });

      const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
      // Scroll into view before asserting. Virtuoso's overscan keeps the row
      // mounted (see message-list.tsx `increaseViewportBy`), but post-stream
      // layout shift (media bytes resolving) can land it just outside the
      // visible area. The scroll is a no-op when the row is already visible.
      await errorTile.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.STREAM });
      await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.STREAM });

      // Lane 9 #6 (video): same server-side persistence parity check.
      await assertPartialFailurePersistence(authenticatedPage, {
        succeededModelId: VIDEO_MODELS[0],
        failedModelId: failModel,
      });
    } finally {
      await authenticatedPage.setExtraHTTPHeaders({});
    }
  });

  /**
   * Lane 9 #7: page reload preserves multi-model image responses, mirroring
   * `multi-model.spec.ts` test at "page reload preserves all responses on
   * fork". Two image models, send prompt, both `<img>` render, reload —
   * both `<img>` survive the reload (proves persistence + decryption +
   * presigned URL re-mint round-trip for each model's content).
   */
  test('multi-model image responses survive a page reload', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToImageMode();

    await chatPage.selectModelsByIds(IMAGE_MODELS);

    await chatPage.sendNewChatMessage(`Multi-image reload ${String(Date.now())}`);
    await chatPage.waitForConversation();

    // Both responses fully streamed and persisted.
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

    await chatPage.expectMediaVisibleAt(1, 'img', TIMEOUTS.MEDIA_DECODE);
    await chatPage.expectMediaVisibleAt(2, 'img', TIMEOUTS.MEDIA_DECODE);

    // Reload the page and assert both images survive — each requires a fresh
    // download URL mint and decryption round-trip.
    await authenticatedPage.reload();
    await chatPage.waitForConversationLoaded();

    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.STREAM,
    });
    await chatPage.expectMediaVisibleAt(1, 'img', TIMEOUTS.MEDIA_DECODE);
    await chatPage.expectMediaVisibleAt(2, 'img', TIMEOUTS.MEDIA_DECODE);
  });
});
