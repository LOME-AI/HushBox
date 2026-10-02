import { TEST_IDS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import {
  E2E_SEEDED_IMAGE_MODEL_ID,
  E2E_SEEDED_VIDEO_MODEL_IDS,
} from '../../scripts/lib/playwright/model-ids.js';
import { ChatPage } from '../pages/index.js';
import { expectExactCharge, storedTextCharge, sumOfCharges } from '../helpers/exact-money.js';
import { generatedArtifactCharge, readGeneratedMedia } from '../helpers/media-flows.js';
import { assertPartialFailurePersistence } from '../helpers/partial-failure.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { DerivedNanoUsd } from '../helpers/exact-money.js';
import type { APIRequestContext } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

// Each pair is two genuinely distinct exposed strict-family models, so the
// picker selects two and the media fan-out is non-vacuous (`buildMediaTurn`
// builds N sibling media modelCalls; the mock send-provider renders a canned
// PNG or VP9 WebM for any id). The two modalities are sourced differently, and the
// difference is not cosmetic — see `scripts/lib/playwright/seeded-image-model.ts` and
// `scripts/lib/playwright/seeded-video-model.ts`:
// image pairs the one live ZDR model the refresh exposes with a synthetic
// partner (every other ZDR image model is token-priced and never exposed), while
// video is synthetic on both sides because no gateway video model is
// ZDR-reachable and the live catalog therefore exposes none at all.
const IMAGE_MODELS = ['bytedance-seed/seedream-4.5', E2E_SEEDED_IMAGE_MODEL_ID] as const;
const VIDEO_MODELS = E2E_SEEDED_VIDEO_MODEL_IDS;

/**
 * Multi-model media (image + video) coverage.
 *
 * Targets the mock-served image/video models declared in `mock.ts`. Each
 * selection opens the model selector modal directly addressing items by id
 * (`model-item-<id>`) so the tests do not rely on the default-sort ordering.
 */
/**
 * What a media turn settled, derived: every persisted artifact at its own
 * family's rate plus its stored bytes, and the user's prompt stored once for
 * the whole turn. `artifacts` is what the turn is expected to have PERSISTED —
 * on a partial failure that is the survivor alone, which is what makes this
 * fail if the failed sibling is billed anyway.
 */
async function expectMediaTurnCharge(
  request: APIRequestContext,
  conversationId: string,
  turn: { readonly kind: 'image' | 'video'; readonly prompt: string; readonly artifacts: number }
): Promise<void> {
  const items = await readGeneratedMedia(request, conversationId, turn.artifacts);
  const charges: DerivedNanoUsd[] = [];
  for (const item of items) {
    charges.push(await generatedArtifactCharge(request, turn.kind, item));
  }
  await expectExactCharge(
    request,
    conversationId,
    sumOfCharges(...charges, storedTextCharge(turn.prompt.length))
  );
}

test.describe('Multi-Model Media', SPEC_MATRIX, () => {
  /** Two image models selected, one prompt sent → both `<img>` elements render with distinct nametags. */
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
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    const conversationId = await chatPage.waitForConversation();

    // Wait for both assistant messages to land (cost-count = 2 + user = expected total).
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

    // Conversation is [user, ai1, ai2]. Address by Virtuoso row index so the
    // assertions don't depend on which messages are currently rendered.
    await chatPage.expectMediaVisibleAt(1, 'img', TIMEOUTS.MEDIA_DECODE);
    const tag1 = chatPage.getMessage(1).getByTestId(TEST_IDS.modelNametag);
    const image1 = chatPage.imagesIn(chatPage.getMessage(1)).first();
    const source1 = await image1.getAttribute('src');

    await chatPage.expectMediaVisibleAt(2, 'img', TIMEOUTS.MEDIA_DECODE);
    const tag2 =
      (await chatPage.getMessage(2).getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';
    const source2 = await chatPage.imagesIn(chatPage.getMessage(2)).first().getAttribute('src');

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

    // Two tiles displaying a cost is not two charges: this is what the wallet
    // was actually asked for, both models priced at their own catalog rate.
    await expectMediaTurnCharge(authenticatedPage.request, conversationId, {
      kind: 'image',
      prompt,
      artifacts: 2,
    });
  });

  /**
   * With 2 image models selected, one is marked failing via the `x-mock-failing-models`
   * header. The successful model renders an image; the failing model surfaces the
   * standard model-error tile.
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

    const prompt = `Image partial failure ${String(Date.now())}`;

    try {
      const streamBaseline = await chatPage.captureStreamBaseline();
      await chatPage.sendNewChatMessage(prompt);
      const conversationId = await chatPage.waitForConversation();
      await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

      const successImage = chatPage.imagesIn(chatPage.messagesByRole('assistant'));
      await expect(successImage.first()).toBeVisible({ timeout: TIMEOUTS.STREAM });

      const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
      // Scroll into view before asserting. Virtuoso's overscan keeps the row
      // mounted (see message-list.tsx `increaseViewportBy`), but post-stream
      // layout shift (media bytes resolving) can land it just outside the
      // visible area. The scroll is a no-op when the row is already visible.
      await errorTile.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.STREAM });
      await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.STREAM });

      // Server-side persistence parity with text partial-failure. Only the
      // successful model's response has a persisted content item with
      // `cost > 0`; the failing model never wrote any content_items rows.
      await assertPartialFailurePersistence(authenticatedPage, {
        succeededModelId: IMAGE_MODELS[0],
        failedModelId: failModel,
      });

      // The turn cost exactly the surviving artifact. A billed failure would
      // land here and nowhere else: it writes no content, so it shows up in no
      // tile and in no displayed total.
      await expectMediaTurnCharge(authenticatedPage.request, conversationId, {
        kind: 'image',
        prompt,
        artifacts: 1,
      });
    } finally {
      await authenticatedPage.setExtraHTTPHeaders({});
    }
  });

  /**
   * Forking a multi-model image conversation preserves both sibling responses
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

    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(`Fork-multi-image ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

    // Fork on the first assistant message (row index 1: [user, ai1, ai2]).
    await chatPage.clickFork(1);
    await chatPage.expectBranchCount(2);
    await chatPage.expectCurrentBranch('Fork 1');

    await chatPage.openBranch('Main');
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.STREAM,
    });
    await chatPage.expectMediaVisibleAt(1, 'img', TIMEOUTS.STREAM);
    await chatPage.expectMediaVisibleAt(2, 'img', TIMEOUTS.STREAM);
  });

  /**
   * Two video models selected — both <video> elements visible after streams
   * complete (race-free finalization between modalities).
   */
  test('two video models render distinct videos race-free', async ({ authenticatedPage }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await chatPage.switchToVideoMode();

    await chatPage.selectModelsByIds(VIDEO_MODELS);

    const prompt = `Multi-video ${String(Date.now())}`;
    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(prompt);
    const conversationId = await chatPage.waitForConversation();

    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

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

    // Both generations, at the inline cost the provider returned for each.
    await expectMediaTurnCharge(authenticatedPage.request, conversationId, {
      kind: 'video',
      prompt,
      artifacts: 2,
    });
  });

  /**
   * The partial-failure case for video: with two video models selected, the second
   * is marked failing via the `x-mock-failing-models` header. The successful model
   * renders a <video> element; the failing one surfaces the standard model-error tile.
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

    const prompt = `Video partial failure ${String(Date.now())}`;

    try {
      const streamBaseline = await chatPage.captureStreamBaseline();
      await chatPage.sendNewChatMessage(prompt);
      const conversationId = await chatPage.waitForConversation();
      await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

      const successVideo = chatPage.videosIn(chatPage.messagesByRole('assistant'));
      await expect(successVideo.first()).toBeVisible({ timeout: TIMEOUTS.STREAM });

      const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
      // Scroll into view before asserting. Virtuoso's overscan keeps the row
      // mounted (see message-list.tsx `increaseViewportBy`), but post-stream
      // layout shift (media bytes resolving) can land it just outside the
      // visible area. The scroll is a no-op when the row is already visible.
      await errorTile.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.STREAM });
      await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.STREAM });

      // The same server-side persistence parity check, for video.
      await assertPartialFailurePersistence(authenticatedPage, {
        succeededModelId: VIDEO_MODELS[0],
        failedModelId: failModel,
      });

      // And the same money statement: the surviving generation, nothing else.
      await expectMediaTurnCharge(authenticatedPage.request, conversationId, {
        kind: 'video',
        prompt,
        artifacts: 1,
      });
    } finally {
      await authenticatedPage.setExtraHTTPHeaders({});
    }
  });

  /**
   * A page reload preserves multi-model image responses, mirroring
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

    const streamBaseline = await chatPage.captureStreamBaseline();
    await chatPage.sendNewChatMessage(`Multi-image reload ${String(Date.now())}`);
    await chatPage.waitForConversation();

    // Both responses fully streamed and persisted.
    await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
    await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

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
