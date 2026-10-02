import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from './env.js';
import {
  catalogPerImageCharge,
  expectBalanceDelta,
  expectExactCharge,
  mockGenerationCharge,
  readMockChargeBasis,
  readMoneyState,
  readServedModelPricing,
  spendOf,
  storedMediaCharge,
  storedTextCharge,
  sumOfCharges,
} from './exact-money.js';
import { expect } from './expect.js';
import { expectOkResponse } from './ok-response.js';
import { withRequestRetry } from './resilient-request.js';
import type { DerivedNanoUsd } from './exact-money.js';
import type { ChatPage } from '../pages/index.js';
import type { APIRequestContext } from '@playwright/test';

type MediaKind = 'image' | 'video';

const API_BASE = requireEnv('VITE_API_URL');

const PROMPT_PREFIX: Record<MediaKind, string> = {
  image: 'Cost+nametag check',
  video: 'Cost+nametag video',
};

/** One generated artifact, as the conversation's own history serves it. */
interface GeneratedMediaItem {
  /** The model that produced it — the catalog row an image charge prices from. */
  readonly modelName: string;
  /**
   * The stored byte length settlement charged the media storage fee on
   * (`content_items.sizeBytes`, the ciphertext the mapper measured). Read
   * rather than written down: the mock builds its artifact programmatically at
   * the requested aspect ratio, so there is no byte count to state.
   */
  readonly byteLength: number;
}

interface HistoryContentItem {
  readonly contentType: string;
  readonly byteLength: number | null;
  readonly modelName: string | null;
}

function generatedMediaItem(item: HistoryContentItem): GeneratedMediaItem {
  if (item.modelName === null || item.byteLength === null) {
    throw new Error(
      `readGeneratedMedia: a ${item.contentType} item carries no model name or byte length`
    );
  }
  return { modelName: item.modelName, byteLength: item.byteLength };
}

async function fetchGeneratedMedia(
  request: APIRequestContext,
  conversationId: string
): Promise<GeneratedMediaItem[]> {
  const response = await withRequestRetry(request).get(
    `${API_BASE}/conversations/${conversationId}/messages`
  );
  await expectOkResponse(response, 'readGeneratedMedia');
  const body = (await response.json()) as {
    messages: { contentItems: HistoryContentItem[] }[];
  };
  return body.messages
    .flatMap((message) => message.contentItems)
    .filter((item) => item.contentType === 'image' || item.contentType === 'video')
    .map((item) => generatedMediaItem(item));
}

/**
 * The conversation's generated artifacts, once `expected` of them have been
 * persisted. Polled because the content item lands with the settlement
 * transaction, which commits after the stream ends — reading once would size a
 * derivation off a turn that has not been written yet.
 */
export async function readGeneratedMedia(
  request: APIRequestContext,
  conversationId: string,
  expected: number
): Promise<GeneratedMediaItem[]> {
  await expect
    .poll(
      async () => {
        const items = await fetchGeneratedMedia(request, conversationId);
        return items.length;
      },
      {
        timeout: TIMEOUTS.ASSERT,
        message: 'the generated media should be persisted',
      }
    )
    .toBe(expected);
  return fetchGeneratedMedia(request, conversationId);
}

/**
 * What one generated artifact was billed: the generation at the rate its own
 * call-shape family charges, plus the storage fee on the bytes persisted.
 *
 * The two families price from different sources, and that is the product's
 * rule rather than a testing convenience: an image call carries no inline
 * provider cost, so settlement bills the deterministic catalog rate, while a
 * video call bills the inline cost the provider returned — which for the E2E
 * mock is the cost it declares.
 */
export async function generatedArtifactCharge(
  request: APIRequestContext,
  kind: MediaKind,
  item: GeneratedMediaItem
): Promise<DerivedNanoUsd> {
  const generation =
    kind === 'image'
      ? catalogPerImageCharge(await readServedModelPricing(request, item.modelName), 1)
      : mockGenerationCharge(await readMockChargeBasis(request), 1);
  return sumOfCharges(generation, storedMediaCharge(item.byteLength));
}

/**
 * Switch the prompt input to the given media modality, send a fresh one-shot
 * prompt, wait for the inline media to render and the stream to finalize, then
 * assert that the turn charged EXACTLY what its artifact and its stored prompt
 * price to, that the payer's wallet lost exactly that, and that the assistant
 * message carries a cost badge and a model nametag.
 *
 * The amount is derived, never written: the artifact's rate comes from the
 * served catalog row or the mock's declared cost, its storage from the byte
 * length the conversation reports, and the prompt's storage from the prompt the
 * helper itself sent. A badge that merely renders a `$` proves none of that,
 * which is what this replaced.
 *
 * Used by the image and video cost tests so the two share one source of truth.
 */
export async function assertCostAndNametagForFreshGeneration(
  chatPage: ChatPage,
  kind: MediaKind
): Promise<void> {
  const request = chatPage.page.request;

  if (kind === 'image') {
    await chatPage.switchToImageMode();
  } else {
    await chatPage.switchToVideoMode();
  }

  // Read before the send: the delta below is what this turn took, not what the
  // wallet happens to hold.
  const before = await readMoneyState(request);

  const prompt = `${PROMPT_PREFIX[kind]} ${String(Date.now())}`;
  const streamBaseline = await chatPage.captureStreamBaseline();
  await chatPage.sendNewChatMessage(prompt);
  const conversationId = await chatPage.waitForConversation();

  if (kind === 'image') {
    await chatPage.expectImageVisible();
  } else {
    await chatPage.expectVideoVisible();
  }
  await chatPage.waitForStreamCycle(streamBaseline);

  const [item] = await readGeneratedMedia(request, conversationId, 1);
  if (item === undefined) {
    throw new Error('the generation persisted no media item');
  }

  // The prompt is stored once for the whole turn, so its fee rides this single
  // charge alongside the artifact's own.
  const expected = sumOfCharges(
    await generatedArtifactCharge(request, kind, item),
    storedTextCharge(prompt.length)
  );
  await expectExactCharge(request, conversationId, expected);
  await expectBalanceDelta(request, before, { purchased: spendOf(expected) });

  const costBadge = chatPage.messageList.getByTestId(TEST_IDS.messageCost).first();
  await expect(costBadge).toBeVisible();

  await chatPage.expectAllAIMessagesHaveNametag();
}
