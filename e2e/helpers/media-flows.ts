import { TEST_IDS } from '@hushbox/shared';
import { expect } from './expect.js';
import type { ChatPage } from '../pages/index.js';

type MediaKind = 'image' | 'video';

const PROMPT_PREFIX: Record<MediaKind, string> = {
  image: 'Cost+nametag check',
  video: 'Cost+nametag video',
};

/**
 * Switch the prompt input to the given media modality, send a fresh
 * one-shot prompt, wait for the inline media to render and the stream to
 * finalize, then assert that the assistant message carries (a) a cost badge
 * with a `$` value and (b) a model nametag.
 *
 * Used by the cost-badge + nametag B1/B2 (image) and C1/C2 (video)
 * coverage tests so the two test bodies share one source of truth.
 */
export async function assertCostAndNametagForFreshGeneration(
  chatPage: ChatPage,
  kind: MediaKind
): Promise<void> {
  if (kind === 'image') {
    await chatPage.switchToImageMode();
  } else {
    await chatPage.switchToVideoMode();
  }

  const prompt = `${PROMPT_PREFIX[kind]} ${String(Date.now())}`;
  await chatPage.sendNewChatMessage(prompt);
  await chatPage.waitForConversation();

  if (kind === 'image') {
    await chatPage.expectImageVisible();
  } else {
    await chatPage.expectVideoVisible();
  }
  await chatPage.waitForStreamComplete();

  const costBadge = chatPage.messageList.getByTestId(TEST_IDS.messageCost).first();
  await expect(costBadge).toBeVisible();
  await expect(costBadge).toContainText(/\$/);

  await chatPage.expectAllAIMessagesHaveNametag();
}
