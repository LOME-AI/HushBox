import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';
import { assertPartialFailurePersistence } from '../helpers/partial-failure.js';

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
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    // Conversation is [user, ai1, ai2]. Address by Virtuoso row index so the
    // assertions don't depend on which messages are currently rendered.
    await chatPage.expectMediaVisibleAt(1, 'img', 30_000);
    const tag1 = await chatPage.getMessage(1).getByTestId('model-nametag').textContent();
    const source1 = await chatPage.getMessage(1).locator('img').first().getAttribute('src');

    await chatPage.expectMediaVisibleAt(2, 'img', 30_000);
    const tag2 = await chatPage.getMessage(2).getByTestId('model-nametag').textContent();
    const source2 = await chatPage.getMessage(2).locator('img').first().getAttribute('src');

    expect(tag1).not.toBe(tag2);
    // Distinct decrypted blob URLs — each <img> must have its own object URL,
    // not share a single source.
    expect(source1).toMatch(/^blob:/);
    expect(source2).toMatch(/^blob:/);
    expect(source1).not.toBe(source2);

    // Cost row count must mirror the assistant count (one cost per response).
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
      timeout: 15_000,
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
      await chatPage.waitForStreamComplete(30_000);

      const successImage = chatPage.messageList.locator('[data-role="assistant"] img');
      await expect(successImage.first()).toBeVisible({ timeout: 15_000 });

      const errorTile = authenticatedPage.getByTestId('model-error-message');
      await unsettledExpect(errorTile).toBeVisible({ timeout: 15_000 });

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
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    // Fork on the first assistant message (row index 1: [user, ai1, ai2]).
    await chatPage.clickFork(1);
    await chatPage.expectForkTabCount(2);
    await chatPage.expectActiveForkTab('Fork 1');

    await chatPage.clickForkTab('Main');
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 15_000,
    });
    await chatPage.expectMediaVisibleAt(1, 'img', 15_000);
    await chatPage.expectMediaVisibleAt(2, 'img', 15_000);
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

    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    await chatPage.expectMediaVisibleAt(1, 'video', 30_000);
    const tag1 = await chatPage.getMessage(1).getByTestId('model-nametag').textContent();
    await chatPage.expectMediaVisibleAt(2, 'video', 30_000);
    const tag2 = await chatPage.getMessage(2).getByTestId('model-nametag').textContent();
    expect(tag1).not.toBe(tag2);

    // Cost row count must mirror the assistant count (one cost per response).
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
      timeout: 15_000,
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
      await chatPage.waitForStreamComplete(30_000);

      const successVideo = chatPage.messageList.locator('[data-role="assistant"] video');
      await expect(successVideo.first()).toBeVisible({ timeout: 15_000 });

      const errorTile = authenticatedPage.getByTestId('model-error-message');
      await unsettledExpect(errorTile).toBeVisible({ timeout: 15_000 });

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
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    await chatPage.expectMediaVisibleAt(1, 'img', 30_000);
    await chatPage.expectMediaVisibleAt(2, 'img', 30_000);

    // Reload the page and assert both images survive — each requires a fresh
    // download URL mint and decryption round-trip.
    await authenticatedPage.reload();
    await chatPage.waitForConversationLoaded();

    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 15_000,
    });
    await chatPage.expectMediaVisibleAt(1, 'img', 30_000);
    await chatPage.expectMediaVisibleAt(2, 'img', 30_000);
  });
});
