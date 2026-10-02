import { type Page, type Locator, type APIRequestContext } from '@playwright/test';
import { TEST_IDS, TEST_SIGNALS, type KeyChainResponse } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { TIMEOUTS } from '../config/timeouts.js';

/** The values the conversation's key-chain verdict signal carries. */
export type EpochState = 'verified' | 'pending' | 'bad';

/**
 * The conversation's keychain as `request`'s caller receives it: the current
 * epoch, whether a departure awaits its rotation, and the epoch chain.
 */
export async function readKeyChain(
  request: APIRequestContext,
  conversationId: string
): Promise<KeyChainResponse> {
  const response = await request.get(`/conversations/${conversationId}/keychain`);
  await expectOkResponse(response, 'keychain read');
  return (await response.json()) as KeyChainResponse;
}

/**
 * The key-state surface of an open conversation: the banner above the thread
 * that carries the key-chain verdict, and the stand-in a message written under
 * keys that failed verification renders as.
 */
export class EpochIntegrityPage {
  readonly page: Page;

  readonly banner: Locator;

  readonly invalidKeysNotices: Locator;

  constructor(page: Page) {
    this.page = page;
    this.banner = page.getByTestId(TEST_IDS.epochIntegrityBanner);
    this.invalidKeysNotices = page.getByTestId(TEST_IDS.messageInvalidKeys);
  }

  /**
   * Wait for the conversation's verdict to read `state`. The banner mounts once
   * the keychain has loaded and stays mounted, hidden, while the verdict is
   * verified, so the wait never needs the banner to be visible. The default
   * budget is a conversation load's: reaching a state is a keychain read and a
   * verification pass, and after a rotation also the rotation's own round trip.
   */
  async waitForState(
    state: EpochState,
    timeout: number = TIMEOUTS.CONVERSATION_LOAD
  ): Promise<void> {
    await expect(this.banner).toHaveAttribute(TEST_SIGNALS.epochState, state, { timeout });
  }

  /**
   * Hold every key rotation this page submits for `conversationId` until the
   * returned release runs, then let each through to the real server. A client
   * rotates on its own the moment it sees a pending or bad verdict, so without
   * the hold the state that prompted the rotation can come and go before a spec
   * reads it. Register it before the page opens the conversation.
   */
  async holdRotations(conversationId: string): Promise<() => void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await this.page.route(
      new RegExp(String.raw`/conversations/${conversationId}/epochs(?:\?|$)`),
      async (route) => {
        if (route.request().method() === 'POST') await released;
        await route.fallback();
      }
    );
    return release;
  }
}
