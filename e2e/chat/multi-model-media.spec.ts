import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';
import { requireEnv } from '../helpers/env.js';

const apiUrl = requireEnv('VITE_API_URL');

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
      await chatPage.openModelSelector();
      const modal = authenticatedPage.getByTestId('model-selector-modal');
      const clearButton = modal.getByTestId('clear-selection-button');
      if (await clearButton.isVisible()) {
        await clearButton.click();
      }
      for (const id of IMAGE_MODELS) {
        const item = modal.getByTestId(`model-item-${id}`);
        await expect(item).toBeVisible();
        await item.getByTestId('model-checkbox').click();
        await expect(item).toHaveAttribute('data-selected', 'true');
      }
      await chatPage.confirmModelSelection();
    });

    const prompt = `Multi-image ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();

    // Wait for both assistant messages to land (cost-count = 2 + user = expected total).
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
    await expect(assistantMessages).toHaveCount(2);
    await expect(assistantMessages.nth(0).locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(assistantMessages.nth(1).locator('img').first()).toBeVisible({ timeout: 30_000 });

    // Distinct nametags on the two responses.
    const tag1 = await assistantMessages.nth(0).getByTestId('model-nametag').textContent();
    const tag2 = await assistantMessages.nth(1).getByTestId('model-nametag').textContent();
    expect(tag1).not.toBe(tag2);

    // Distinct decrypted blob URLs — each <img> must have its own object URL,
    // not share a single source. Each render creates an independent
    // `URL.createObjectURL` allocation per assistant message.
    const source1 = await assistantMessages.nth(0).locator('img').first().getAttribute('src');
    const source2 = await assistantMessages.nth(1).locator('img').first().getAttribute('src');
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
      await chatPage.openModelSelector();
      const modal = authenticatedPage.getByTestId('model-selector-modal');
      const clearButton = modal.getByTestId('clear-selection-button');
      if (await clearButton.isVisible()) {
        await clearButton.click();
      }
      for (const id of IMAGE_MODELS) {
        const item = modal.getByTestId(`model-item-${id}`);
        await item.getByTestId('model-checkbox').click();
      }
      await chatPage.confirmModelSelection();

      const response = await authenticatedPage.request.post(`${apiUrl}/api/dev/fail-model`, {
        data: { modelId: failModel },
      });
      expect(response.ok()).toBe(true);
    });

    try {
      await chatPage.sendNewChatMessage(`Image partial failure ${String(Date.now())}`);
      await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(30_000);

      // Successful model rendered an image.
      const successImage = chatPage.messageList.locator('[data-role="assistant"] img');
      await expect(successImage.first()).toBeVisible({ timeout: 15_000 });

      // Failing model surfaced the model-error tile.
      const errorTile = authenticatedPage.getByTestId('model-error-message');
      await unsettledExpect(errorTile).toBeVisible({ timeout: 15_000 });

      // Lane 9 #6: server-side persistence parity with text partial-failure.
      // Query the conversation API: only the successful model's response has a
      // persisted content item with `cost > 0`; the failing model never wrote
      // any content_items rows.
      const conversationUrl = authenticatedPage.url();
      const conversationId = conversationUrl.split('/chat/')[1]?.split('?')[0];
      expect(conversationId, 'conversation id should be in URL').toBeTruthy();

      const apiResponse = await authenticatedPage.request.get(
        `${apiUrl}/api/conversations/${conversationId!}`
      );
      expect(apiResponse.ok()).toBe(true);
      const { messages } = (await apiResponse.json()) as {
        messages: {
          senderType: string;
          contentItems: { modelName: string | null; cost: string | null }[];
        }[];
      };

      const aiContentItems = messages
        .filter((m) => m.senderType === 'ai')
        .flatMap((m) => m.contentItems);

      const failedItems = aiContentItems.filter((ci) => ci.modelName === failModel);
      expect(failedItems.length).toBe(0);

      const succeededItems = aiContentItems.filter((ci) => ci.modelName === IMAGE_MODELS[0]);
      expect(succeededItems.length).toBeGreaterThan(0);
      // Cost is a numeric string. Persisted, positive, non-zero.
      for (const item of succeededItems) {
        expect(item.cost).not.toBeNull();
        expect(Number.parseFloat(item.cost ?? '0')).toBeGreaterThan(0);
      }
    } finally {
      await authenticatedPage.request.post(`${apiUrl}/api/dev/fail-model`, {
        data: { modelId: null },
      });
    }
  });

  /**
   * E3: mixed-modality selection — one image model + one text model. Both
   * responses render in their respective formats.
   */
  test('mixed image + text selection renders both modalities', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select 1 text model and 1 image model', async () => {
      await chatPage.openModelSelector();
      const modal = authenticatedPage.getByTestId('model-selector-modal');
      const clearButton = modal.getByTestId('clear-selection-button');
      if (await clearButton.isVisible()) {
        await clearButton.click();
      }

      // First non-premium text model.
      const textItem = modal
        .locator('[data-testid^="model-item-"]:not(:has([data-testid="lock-icon"]))')
        .first();
      await textItem.getByTestId('model-checkbox').click();

      // First image model — selectors expose every model regardless of active modality.
      const imageItem = modal.getByTestId(`model-item-${IMAGE_MODELS[0]}`);
      await imageItem.getByTestId('model-checkbox').click();

      await chatPage.confirmModelSelection();
    });

    await chatPage.sendNewChatMessage(`Mixed modality ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    // One <img> appears (image model) and one Echo: text response (text model).
    await expect(chatPage.messageList.locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(
      chatPage.messageList.locator('[data-role="assistant"]').filter({ hasText: 'Echo:' }).first()
    ).toBeVisible();
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

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) {
      await clearButton.click();
    }
    for (const id of IMAGE_MODELS) {
      await modal.getByTestId(`model-item-${id}`).getByTestId('model-checkbox').click();
    }
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Fork-multi-image ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    // Fork on the first assistant message (index 1 in DOM order: [user, ai1, ai2]).
    await chatPage.clickFork(1);
    await chatPage.expectForkTabCount(2);
    await chatPage.expectActiveForkTab('Fork 1');

    // Switch back to the original tab and verify both image responses persisted.
    await chatPage.clickForkTab('Main');
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 15_000,
    });
    const assistants = chatPage.messageList.locator('[data-role="assistant"]');
    await expect(assistants.nth(0).locator('img').first()).toBeVisible({ timeout: 15_000 });
    await expect(assistants.nth(1).locator('img').first()).toBeVisible({ timeout: 15_000 });
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

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) {
      await clearButton.click();
    }
    for (const id of VIDEO_MODELS) {
      const item = modal.getByTestId(`model-item-${id}`);
      await expect(item).toBeVisible();
      await item.getByTestId('model-checkbox').click();
      await expect(item).toHaveAttribute('data-selected', 'true');
    }
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Multi-video ${String(Date.now())}`);
    await chatPage.waitForConversation();

    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
    await expect(assistantMessages.nth(0).locator('video').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(assistantMessages.nth(1).locator('video').first()).toBeVisible({
      timeout: 30_000,
    });

    const tag1 = await assistantMessages.nth(0).getByTestId('model-nametag').textContent();
    const tag2 = await assistantMessages.nth(1).getByTestId('model-nametag').textContent();
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
      await chatPage.openModelSelector();
      const modal = authenticatedPage.getByTestId('model-selector-modal');
      const clearButton = modal.getByTestId('clear-selection-button');
      if (await clearButton.isVisible()) {
        await clearButton.click();
      }
      for (const id of VIDEO_MODELS) {
        const item = modal.getByTestId(`model-item-${id}`);
        await item.getByTestId('model-checkbox').click();
      }
      await chatPage.confirmModelSelection();

      const response = await authenticatedPage.request.post(`${apiUrl}/api/dev/fail-model`, {
        data: { modelId: failModel },
      });
      expect(response.ok()).toBe(true);
    });

    try {
      await chatPage.sendNewChatMessage(`Video partial failure ${String(Date.now())}`);
      await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(30_000);

      // Successful model rendered a video.
      const successVideo = chatPage.messageList.locator('[data-role="assistant"] video');
      await expect(successVideo.first()).toBeVisible({ timeout: 15_000 });

      // Failing model surfaced the model-error tile.
      const errorTile = authenticatedPage.getByTestId('model-error-message');
      await unsettledExpect(errorTile).toBeVisible({ timeout: 15_000 });

      // Lane 9 #6 (video): same server-side persistence parity check.
      const conversationUrl = authenticatedPage.url();
      const conversationId = conversationUrl.split('/chat/')[1]?.split('?')[0];
      expect(conversationId, 'conversation id should be in URL').toBeTruthy();

      const apiResponse = await authenticatedPage.request.get(
        `${apiUrl}/api/conversations/${conversationId!}`
      );
      expect(apiResponse.ok()).toBe(true);
      const { messages } = (await apiResponse.json()) as {
        messages: {
          senderType: string;
          contentItems: { modelName: string | null; cost: string | null }[];
        }[];
      };

      const aiContentItems = messages
        .filter((m) => m.senderType === 'ai')
        .flatMap((m) => m.contentItems);

      const failedItems = aiContentItems.filter((ci) => ci.modelName === failModel);
      expect(failedItems.length).toBe(0);

      const succeededItems = aiContentItems.filter((ci) => ci.modelName === VIDEO_MODELS[0]);
      expect(succeededItems.length).toBeGreaterThan(0);
      for (const item of succeededItems) {
        expect(item.cost).not.toBeNull();
        expect(Number.parseFloat(item.cost ?? '0')).toBeGreaterThan(0);
      }
    } finally {
      await authenticatedPage.request.post(`${apiUrl}/api/dev/fail-model`, {
        data: { modelId: null },
      });
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

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) {
      await clearButton.click();
    }
    for (const id of IMAGE_MODELS) {
      const item = modal.getByTestId(`model-item-${id}`);
      await expect(item).toBeVisible();
      await item.getByTestId('model-checkbox').click();
      await expect(item).toHaveAttribute('data-selected', 'true');
    }
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Multi-image reload ${String(Date.now())}`);
    await chatPage.waitForConversation();

    // Both responses fully streamed and persisted.
    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 30_000,
    });
    await chatPage.waitForStreamComplete(30_000);

    const assistantsBefore = chatPage.messageList.locator('[data-role="assistant"]');
    await expect(assistantsBefore.nth(0).locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(assistantsBefore.nth(1).locator('img').first()).toBeVisible({ timeout: 30_000 });

    // Reload the page and assert both images survive — each requires a fresh
    // download URL mint and decryption round-trip.
    await authenticatedPage.reload();
    await chatPage.waitForConversationLoaded();

    await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: 15_000,
    });
    const assistantsAfter = chatPage.messageList.locator('[data-role="assistant"]');
    await expect(assistantsAfter.nth(0).locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(assistantsAfter.nth(1).locator('img').first()).toBeVisible({ timeout: 30_000 });
  });
});
