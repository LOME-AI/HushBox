import { type Page, type Locator } from '@playwright/test';
import { expect, unsettledExpect } from '../helpers/settled-expect.js';
import { requireEnv } from '../helpers/env.js';
import { getBrowserName, lacksMediaDecode } from '../helpers/webkit-media-decode.js';

const apiUrl = requireEnv('VITE_API_URL');

export class ChatPage {
  readonly page: Page;
  readonly promptInput: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly newChatPage: Locator;
  readonly suggestionChips: Locator;
  readonly viewport: Locator;

  constructor(page: Page) {
    this.page = page;
    // Locate the prompt textarea by stable testid — the placeholder/aria-label
    // changes per modality (e.g. "Describe the image you want..." for image),
    // so name-based locators silently break after switchToImageMode/Video/Audio.
    this.promptInput = page.getByTestId('prompt-input');
    this.messageInput = page.locator('main').getByTestId('prompt-input');
    this.sendButton = page.getByTestId('send-button');
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId('new-chat-page');
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
    this.viewport = page.locator('[data-slot="scroll-area-viewport"]');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat', { waitUntil: 'domcontentloaded' });
  }

  async waitForAppStable(timeout = 15_000): Promise<void> {
    await this.page.locator('[data-app-stable="true"]').waitFor({ state: 'visible', timeout });
  }

  /** Wait for the group chat WebSocket to be connected. Use before actions that send events via WebSocket. */
  async waitForWebSocketConnected(timeout = 15_000): Promise<void> {
    await expect(this.page.locator('[data-ws-connected="true"]')).toBeVisible({ timeout });
  }

  /** Wait for the WebSocket server-side registration to complete (DO ready for fan-out). */
  async waitForWebSocketReady(timeout = 10_000): Promise<void> {
    await this.page.locator('[data-ws-ready="true"]').waitFor({ state: 'attached', timeout });
  }

  /** Wait for the message list to finish scrolling (layout stable). Use after programmatic scroll operations. */
  async waitForScrollStable(timeout = 5000): Promise<void> {
    await this.page
      .locator('[data-virtuoso-scrolling="false"]')
      .waitFor({ state: 'attached', timeout });
  }

  /**
   * Wait for a conversation page to load. Use instead of waitForAppStable on
   * conversation pages. Waits for the message list to mount, for either a
   * message-item or the empty state to render, and for every message to
   * finish decrypting (so a follow-up assertion can scroll to any message
   * without racing the decrypt result).
   */
  async waitForConversationLoaded(timeout = 15_000): Promise<void> {
    await this.messageList.waitFor({ state: 'visible', timeout });
    await this.messageList
      .locator('[data-testid="message-item"]')
      .first()
      .or(this.messageList.getByText('No messages yet'))
      .waitFor({ state: 'visible', timeout });
    await this.waitForDecryptionComplete(timeout);
  }

  /**
   * Wait until every message in the conversation has been decrypted, using
   * the `data-decrypted-count` attribute exposed by `MessageList`. Resolves
   * immediately when the conversation is empty.
   */
  async waitForDecryptionComplete(timeout = 15_000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const list = document.querySelector<HTMLElement>(
          '[data-testid="message-list"], [data-testid="message-list-empty"]'
        );
        if (!list) return false;
        const messageCount = Number(list.dataset['messageCount']);
        const decryptedCount = Number(list.dataset['decryptedCount']);
        if (Number.isNaN(messageCount) || Number.isNaN(decryptedCount)) return false;
        return decryptedCount >= messageCount;
      },
      undefined,
      { timeout }
    );
  }

  async gotoTrialChat(): Promise<void> {
    await this.page.goto('/chat/trial', { waitUntil: 'domcontentloaded' });
  }

  async gotoConversation(conversationId: string): Promise<void> {
    await this.page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Trap for tests asserting on transient streaming UI (classifier indicator,
   * first tokens, etc.): this method triggers a /chat → /chat/<new-id>
   * navigation that remounts MessageList. react-virtuoso applies
   * `visibility: hidden` to its item-list during its initial measure-and-scroll,
   * so content is in DOM but invisible during that ~1s window. Prefer a seeded
   * conversation (testConversation fixture) + sendFollowUpMessage instead.
   */
  async sendNewChatMessage(message: string): Promise<void> {
    await this.waitForAppStable();
    await this.promptInput.fill(message);
    await expect(this.sendButton).toBeEnabled({ timeout: 15_000 });
    await this.sendButton.click();
  }

  async sendFollowUpMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
    // Wait for streaming to complete (button enabled means canSubmit = true)
    await expect(this.sendButton).toBeEnabled({ timeout: 15_000 });
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async waitForConversation(timeout = 20_000): Promise<string> {
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout });
    const url = new URL(this.page.url());
    return url.pathname.split('/').pop() ?? '';
  }

  async expectMessageVisible(message: string, timeout = 10_000): Promise<void> {
    // Thin alias so existing call sites keep working. Prefer assertMessageVisible
    // for new code — it is virtualization-agnostic and auto-scrolls if needed.
    await this.assertMessageVisible(message, { exact: true, timeout });
  }

  /**
   * Count messages in the conversation. Gates on the app-emitted
   * `data-messages-ready="true"` signal first so we never read
   * `data-message-count` mid-decryption (where it sits at 0 momentarily on
   * fork-tab switch / fresh navigation and the old "stable count" polling
   * would mistake that for "stable empty").
   *
   * Happy path: returns `stateCount` when it matches the DOM count of
   * `[data-message-id]` (every message currently mounted). Otherwise scrolls
   * top→bottom once collecting unique `data-message-id` values — covers
   * virtualized chats where Virtuoso unmounts off-screen rows.
   *
   * @param role - optional filter ('user' | 'assistant'); when set, counts only
   *               messages of that role (still scrolling through all to collect
   *               them reliably).
   */
  async countMessages(role?: 'user' | 'assistant'): Promise<number> {
    await this.messageList
      .and(this.page.locator('[data-messages-ready="true"]'))
      .waitFor({ timeout: 10_000 });

    const stateCount = Number(await this.messageList.getAttribute('data-message-count'));

    // A fork-switch (or fresh navigation) remounts the virtualized list; Virtuoso
    // mounts its rows asynchronously, so the DOM `[data-message-id]` count briefly
    // lags the authoritative `data-message-count`. Wait for the DOM to catch up
    // before comparing — otherwise the mismatch drops us into the scroll-collect
    // path below, which then reads a transient under-count mid-remount (the
    // fork-switch "0/0/1 instead of 3" flake). A long virtualized list never fully
    // mounts, so this times out and falls through to scroll-collect as before.
    if (stateCount > 0) {
      await unsettledExpect(this.messageList.locator('[data-message-id]'))
        .toHaveCount(stateCount, { timeout: 3000 })
        .catch(() => {
          // Long virtualized list never mounts all rows — fall through to scroll-collect.
        });
    }

    const domCount = await this.messageList.locator('[data-message-id]').count();

    // Happy path: every message is already rendered, no scrolling needed.
    if (stateCount === domCount) {
      if (role === undefined) return stateCount;
      return await this.messageList.locator(`[data-role="${role}"]`).count();
    }

    // Slow path: scroll through and collect unique ids.
    const seen = await this.collectMessagesByScrolling(role);
    return seen.size;
  }

  /**
   * Assert a message containing the given text exists somewhere in the
   * conversation. Happy path: already visible in the current DOM, optionally
   * after a short wait to cover decryption lag. Otherwise scrolls to find
   * it, auto-detecting direction from the current scroll position (closer
   * to top → scroll down first; closer to bottom → scroll up first). Falls
   * back to the opposite direction if the first direction exhausts.
   */
  async assertMessageVisible(
    text: string,
    options?: { exact?: boolean; timeout?: number }
  ): Promise<void> {
    const exact = options?.exact ?? false;
    const timeout = options?.timeout ?? 10_000;
    const locator = this.messageList.getByText(text, { exact }).first();

    // Happy path: already visible, or appears within a short wait window.
    // The short wait covers normal async lag (decryption, streaming) without
    // needing to scroll. If the message is genuinely off-screen due to
    // virtualization, this wait returns fast (locator stays not-visible)
    // and we fall through to the scroll path.
    const happyWait = Math.min(3000, timeout);
    const appeared = await locator
      .waitFor({ state: 'visible', timeout: happyWait })
      .then(() => true)
      .catch(() => false);
    if (appeared) return;

    // Slow path: scroll to find it with the remaining time budget.
    const remaining = Math.max(1000, timeout - happyWait);
    await this.scrollUntilLocatorVisible(locator, text, remaining);
  }

  /**
   * Assert no message containing the given text exists anywhere in the
   * conversation. Happy path (instant): every message is already in the DOM
   * (`data-message-count` === DOM `[data-message-id]` count), so a single
   * negative check is definitive. Otherwise scrolls top→bottom confirming the
   * text never appears at any scroll position.
   */
  async assertMessageNotVisible(text: string, options?: { exact?: boolean }): Promise<void> {
    const exact = options?.exact ?? false;
    const locator = this.messageList.getByText(text, { exact });

    // Same gate as countMessages: don't read `data-message-count` until the
    // app has finished its decryption pass, or the negative check could
    // succeed against a transient "messages.length=0" render.
    await this.messageList
      .and(this.page.locator('[data-messages-ready="true"]'))
      .waitFor({ timeout: 10_000 });

    const stateCount = Number(await this.messageList.getAttribute('data-message-count'));
    const domCount = await this.messageList.locator('[data-message-id]').count();

    // Happy path: all messages are rendered — one negative check is definitive.
    if (stateCount === domCount) {
      await expect(locator).not.toBeVisible();
      return;
    }

    // Slow path: scroll top→bottom, confirm text never appears.
    await this.scrollToTop();
    await this.waitForScrollStable();
    let done = false;
    while (!done) {
      if (
        await locator
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        throw new Error(`assertMessageNotVisible: found message with text "${text}"`);
      }
      if (await this.isAtScrollBottom()) {
        done = true;
      } else {
        await this.scrollByViewportFraction(0.8);
        await this.waitForScrollStable();
      }
    }
  }

  /**
   * Scroll top→bottom collecting unique `data-message-id` values that enter
   * the DOM. Used internally by `countMessages` and the nametag assertion.
   */
  private async collectMessagesByScrolling(role?: 'user' | 'assistant'): Promise<Set<string>> {
    const seen = new Set<string>();
    await this.scrollToTop();
    await this.waitForScrollStable();

    const selector =
      role === undefined ? '[data-message-id]' : `[data-role="${role}"][data-message-id]`;

    let done = false;
    while (!done) {
      const ids = await this.messageList
        .locator(selector)
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['messageId'] ?? null));
      for (const id of ids) {
        if (id !== null) seen.add(id);
      }

      if (await this.isAtScrollBottom()) {
        done = true;
      } else {
        await this.scrollByViewportFraction(0.8);
        await this.waitForScrollStable();
      }
    }
    return seen;
  }

  /**
   * Scroll to find `locator`, auto-detecting direction from the current
   * scroll position. If the first direction exhausts, tries the opposite.
   */
  private async scrollUntilLocatorVisible(
    locator: Locator,
    text: string,
    timeout: number
  ): Promise<void> {
    const start = Date.now();
    const { scrollTop, scrollHeight, clientHeight } = await this.getScrollPosition();

    // Auto-detect: if we're in the upper half, missing message is likely
    // below. If we're in the lower half, it's likely above.
    const maxScroll = Math.max(1, scrollHeight - clientHeight);
    const relativePos = scrollTop / maxScroll;
    const firstDir: 1 | -1 = relativePos < 0.5 ? 1 : -1;

    if (await this.scanDirection(locator, firstDir, Math.floor(timeout / 2))) return;

    const remaining = Math.max(1000, timeout - (Date.now() - start));
    const secondDir: 1 | -1 = firstDir === 1 ? -1 : 1;
    if (await this.scanDirection(locator, secondDir, remaining)) return;

    throw new Error(
      `assertMessageVisible: no message matching "${text}" found after scrolling both directions`
    );
  }

  private async scanDirection(locator: Locator, dir: 1 | -1, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await locator.isVisible().catch(() => false)) return true;
      const atEdge = dir === 1 ? await this.isAtScrollBottom() : await this.isAtScrollTop();
      if (atEdge) return false;
      await this.scrollByViewportFraction(0.8 * dir);
      await this.waitForScrollStable();
    }
    return false;
  }

  private async scrollByViewportFraction(frac: number): Promise<void> {
    await this.viewport.evaluate((el, f) => {
      el.scrollTop += el.clientHeight * f;
    }, frac);
  }

  private async isAtScrollBottom(): Promise<boolean> {
    const { scrollTop, scrollHeight, clientHeight } = await this.getScrollPosition();
    return scrollTop + clientHeight >= scrollHeight - 10;
  }

  private async isAtScrollTop(): Promise<boolean> {
    const { scrollTop } = await this.getScrollPosition();
    return scrollTop <= 10;
  }

  async expectNewChatPageVisible(): Promise<void> {
    await expect(this.newChatPage).toBeVisible();
  }

  async expectPromptInputVisible(): Promise<void> {
    await expect(this.promptInput).toBeVisible();
  }

  async expectSuggestionChipsVisible(): Promise<void> {
    await expect(this.suggestionChips).toBeVisible();
  }

  async waitForAIResponse(expectedContent?: string, timeout = 10_000): Promise<void> {
    const assistantMessages = this.messageList.locator('[data-role="assistant"]');

    const target = expectedContent
      ? assistantMessages.getByText(expectedContent, { exact: false }).first()
      : assistantMessages.getByText(/^Echo:/).first();

    await unsettledExpect(target).toBeVisible({ timeout });
    await this.waitForStreamComplete();
  }

  async expectAssistantMessageContains(text: string): Promise<void> {
    await expect(this.messageList.getByText(text).first()).toBeVisible();
  }

  async expectMessageCostVisible(): Promise<void> {
    await expect(this.messageList.locator('[data-testid="message-cost"]').first()).toBeVisible();
  }

  /**
   * Wait for the active streaming turn (text or media) to complete and persist.
   * Gates on the message list's live `data-streaming-count` — the size of the
   * client's `streamingMessageIds`, which only returns to 0 after the SSE `done`
   * event, i.e. after the turn's messages are persisted server-side.
   *
   * The previous implementation waited for the LAST `[data-testid="message-cost"]`
   * badge to be visible; a prior reply's badge already satisfied that, so a
   * second message in the same conversation resolved instantly — before its
   * reply was persisted — and a reader fetching from another context (a link
   * guest) saw an empty thread.
   */
  async waitForStreamComplete(timeout = 15_000): Promise<void> {
    const streamingCount = async (): Promise<number> =>
      Number((await this.messageList.getAttribute('data-streaming-count')) ?? '0');

    // A send/regenerate starts its stream a tick after submit (inside the async
    // send path), so a bare drain check could read the pre-start 0 and return
    // early. Wait briefly for the stream to register; if it never does (the turn
    // already finished before this call), fall through — the drain assertion
    // below is then already satisfied.
    await expect
      .poll(streamingCount, { timeout: 2000 })
      .toBeGreaterThan(0)
      .catch(() => {
        // No stream registered within the grace window — the turn already
        // finished before this call; the drain assertion below is satisfied.
      });

    await unsettledExpect(this.messageList).toHaveAttribute('data-streaming-count', '0', {
      timeout,
    });
  }

  /** Switch the prompt input to image generation modality. Click the image icon button. */
  async switchToImageMode(): Promise<void> {
    await this.waitForAppStable();
    const imageIcon = this.page.getByRole('button', { name: /switch to image/i });
    await expect(imageIcon).toBeVisible();
    await imageIcon.click();
    // Confirmation: the aspect ratio toggle pill is rendered (1:1 default).
    await expect(this.page.getByRole('button', { name: '1:1' })).toBeVisible();
  }

  /** Switch the prompt input to video generation modality. Click the video icon button. */
  async switchToVideoMode(): Promise<void> {
    await this.waitForAppStable();
    const videoIcon = this.page.getByRole('button', { name: /switch to video/i });
    await expect(videoIcon).toBeVisible();
    await videoIcon.click();
    // Confirmation: video resolution buttons render (720p default for mock Veo 3.1).
    await expect(this.page.getByRole('button', { name: /720p/i })).toBeVisible();
  }

  /** Click an aspect-ratio toggle pill ('1:1' | '16:9' | '9:16' | '4:5' etc). */
  async selectAspectRatio(ratio: string): Promise<void> {
    const pill = this.page.getByRole('button', { name: ratio });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }

  /** Click a video resolution toggle pill (label starts with the resolution followed by inline price). */
  async selectResolution(resolution: '720p' | '1080p' | '4k'): Promise<void> {
    const pill = this.page.getByRole('button', {
      name: new RegExp(String.raw`^${resolution}\s+\$`, 'i'),
    });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }

  /** Drag the video duration slider to N seconds (uses keyboard for determinism). */
  async setVideoDuration(seconds: number): Promise<void> {
    const slider = this.page.getByRole('slider', { name: /video duration in seconds/i });
    await expect(slider).toBeVisible();
    await slider.focus();
    // Range inputs are controlled by React state; setting `input.value` alone
    // is overwritten on the next render. Use the native HTMLInputElement value
    // setter so React's onChange synthetic event picks up the new value.
    await slider.evaluate((el, value) => {
      const input = el as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      // eslint-disable-next-line @typescript-eslint/unbound-method -- descriptor.set is invoked via .call(input)
      const setter = descriptor?.set;
      setter?.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, seconds);
    await expect(slider).toHaveValue(String(seconds));
  }

  /**
   * Wait until the matched media element has decoded bytes — `naturalWidth > 0`
   * for `<img>`, `readyState >= HAVE_METADATA` (with no `el.error`) for
   * `<video>`. `toBeVisible()` alone is insufficient on iPhone-15: a
   * freshly-mounted lazy `<img>` with no `width`/`height` attributes can be
   * in the DOM with a 0×0 bounding box and report as "hidden" until the bytes
   * actually decode.
   *
   * The video branch one-shot-nudges `el.load()` on first poll because
   * WebKitGTK's GStreamer pipeline doesn't always fire `loadedmetadata` for
   * `<video src=blob: preload="metadata">` without a programmatic kick. The
   * sentinel keeps it idempotent so we don't restart the load on every poll.
   * `el.error === null` is checked first so corrupt bytes still fail fast
   * instead of being papered over by the nudge.
   *
   * On engines where Playwright cannot decode video (Linux WebKit — see
   * `../helpers/webkit-media-decode.ts`), the video branch downgrades to a
   * "non-empty src" check so the rest of the test still runs end-to-end.
   * Production Safari decodes the same bytes natively.
   */
  private async expectMediaLoaded(media: Locator, timeout = 15_000): Promise<void> {
    const skipVideoDecode = lacksMediaDecode(getBrowserName(this.page));
    await unsettledExpect
      .poll(
        async () =>
          media.evaluate((el, skipDecode: boolean) => {
            if (el instanceof HTMLImageElement) return el.naturalWidth;
            if (!(el instanceof HTMLVideoElement)) return 0;
            const v = el as HTMLVideoElement & { __pwLoadNudged?: boolean };
            if (v.error !== null) return 0;
            if (skipDecode) return v.currentSrc || v.src ? 1 : 0;
            if (v.readyState >= 1) return 1;
            if (!v.__pwLoadNudged) {
              v.__pwLoadNudged = true;
              v.load();
            }
            return 0;
          }, skipVideoDecode),
        { timeout }
      )
      .toBeGreaterThan(0);
  }

  /**
   * Wait for an inline media element to render anywhere in the message
   * list. Each poll iteration re-walks rows bottom→top so a late-arriving
   * row (post-`waitForStreamComplete` refetch) gets visited. Success
   * requires decoded bytes — `naturalWidth > 0` or a playable duration —
   * to avoid passing on a `MediaPlaceholder` or a still-decrypting `<img>`
   * with a 0×0 bounding box.
   */
  async expectMediaVisible(kind: 'img' | 'video', timeout = 30_000): Promise<void> {
    const media = this.messageList.locator(kind).first();
    const skipVideoDecode = lacksMediaDecode(getBrowserName(this.page));
    try {
      await expect
        .poll(
          async () => {
            const rowsCount = Number(await this.messageList.getAttribute('data-rows-count'));
            if (!Number.isFinite(rowsCount) || rowsCount <= 0) return false;
            for (let index = rowsCount - 1; index >= 0; index--) {
              try {
                await this.scrollMessageIntoView(index);
              } catch {
                return false;
              }
              if (!(await media.isVisible().catch(() => false))) continue;
              const decoded = await media
                .evaluate((el, skipDecode: boolean) => {
                  if (el instanceof HTMLImageElement) return el.naturalWidth > 0;
                  if (el instanceof HTMLVideoElement) {
                    // Mirrors expectMediaLoaded: one-shot `el.load()` nudge
                    // for WebKitGTK's lazy-metadata-on-blob behavior, sentinel
                    // prevents repeated cancel/restart cycles. Real corrupt
                    // bytes still surface via `el.error`. On engines that
                    // can't decode (Linux WebKit — see
                    // `../helpers/webkit-media-decode.ts`), pass as soon as
                    // the element has a non-empty src.
                    const v = el as HTMLVideoElement & { __pwLoadNudged?: boolean };
                    if (v.error !== null) return false;
                    if (skipDecode) return Boolean(v.currentSrc || v.src);
                    if (v.readyState >= 1) return true;
                    if (!v.__pwLoadNudged) {
                      v.__pwLoadNudged = true;
                      v.load();
                    }
                    return false;
                  }
                  return false;
                }, skipVideoDecode)
                .catch(() => false);
              if (decoded) return true;
            }
            return false;
          },
          { timeout }
        )
        .toBe(true);
    } catch {
      // Surface Playwright's rich locator error (attached/visible state) on
      // failure instead of `expect.poll`'s opaque boolean mismatch.
      await unsettledExpect(media).toBeVisible({ timeout: 0 });
    }
    await this.expectMediaLoaded(media);
  }

  /**
   * Park the message at `index` in Virtuoso's mounted window and assert
   * that an `<img>` (or `<video>`) inside that row is visible and
   * dimensionally settled. Use this when a test needs media at a specific
   * row; use `expectImageVisible` / `expectVideoVisible` for "anywhere".
   *
   * Polls scroll-then-check (not scroll-once-then-poll): on iPhone-15
   * Virtuoso can re-virtualize the row between our scroll and the
   * visibility check; re-anchoring each iteration recovers from that.
   */
  async expectMediaVisibleAt(
    index: number,
    kind: 'img' | 'video',
    timeout = 30_000
  ): Promise<void> {
    const media = this.getMessage(index).locator(kind).first();
    try {
      await expect
        .poll(
          async () => {
            try {
              await this.scrollMessageIntoView(index);
            } catch {
              return false;
            }
            return media.isVisible().catch(() => false);
          },
          { timeout }
        )
        .toBe(true);
    } catch {
      // Surface Playwright's rich locator error (attached/visible state) on
      // failure instead of `expect.poll`'s opaque boolean mismatch.
      await unsettledExpect(media).toBeVisible({ timeout: 0 });
    }
    await this.expectMediaLoaded(media);
  }

  async expectImageVisible(timeout = 30_000): Promise<void> {
    await this.expectMediaVisible('img', timeout);
  }

  async expectVideoVisible(timeout = 30_000): Promise<void> {
    await this.expectMediaVisible('video', timeout);
  }

  /** Confirm the "Download media" link is rendered alongside the inline media element. */
  async expectDownloadLinkVisible(): Promise<void> {
    const downloadLink = this.messageList.getByRole('link', { name: /download media/i }).first();
    await expect(downloadLink).toBeVisible();
  }

  /** Returns the href of the first download media link in the assistant message list. */
  async getDownloadLinkHref(): Promise<string | null> {
    const downloadLink = this.messageList.getByRole('link', { name: /download media/i }).first();
    return downloadLink.getAttribute('href');
  }

  getSenderLabels(): Locator {
    return this.messageList.locator('[data-testid="sender-label"]');
  }

  getAiToggleButton(): Locator {
    return this.page.getByRole('button', { name: /AI response/ });
  }

  getTypingIndicator(): Locator {
    return this.page.getByTestId('typing-indicator');
  }

  getMessageGroups(): Locator {
    return this.messageList.locator('[data-testid="message-item"]');
  }

  async getScrollPosition(): Promise<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }> {
    return this.viewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  }

  async scrollToTop(): Promise<void> {
    await this.viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
  }

  async scrollUp(pixels: number): Promise<void> {
    await this.viewport.evaluate((el, px) => {
      el.scrollTop = Math.max(0, el.scrollTop - px);
    }, pixels);
  }

  async isInputFocused(): Promise<boolean> {
    return this.messageInput.evaluate((el) => el === document.activeElement);
  }

  async selectNonPremiumModel(): Promise<void> {
    await this.selectModels(1);
  }

  async findOverflowingElements(): Promise<string[]> {
    return this.page.evaluate(() => {
      const skipPattern = /sr-only|truncate|overflow-hidden/;
      return [...document.querySelectorAll('*')]
        .map((element) => {
          const el = element as HTMLElement;
          const overflow = el.scrollWidth - el.clientWidth;
          return { el, overflow };
        })
        .filter(({ el, overflow }) => overflow > 100 && el.clientWidth > 0)
        .filter(({ el }) => !skipPattern.test(el.className))
        .map(({ el, overflow }) => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${el.className.replaceAll(/\s+/g, '.')}` : '';
          const testId = el.dataset['testid'] ? `[data-testid="${el.dataset['testid']}"]` : '';
          const slot = el.dataset['slot'] ? `[data-slot="${el.dataset['slot']}"]` : '';
          return `${tag}${id}${testId}${slot} overflow:${String(overflow)} scrollW:${String(el.scrollWidth)} clientW:${String(el.clientWidth)}\n  classes: ${cls.slice(0, 200)}`;
        });
    });
  }

  async getViewportWidth(): Promise<number> {
    return this.page.evaluate(() => window.innerWidth);
  }

  async getDocumentDimensions(): Promise<{ scrollWidth: number; clientWidth: number }> {
    return this.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
  }

  async scrollToBottom(): Promise<void> {
    await this.viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }

  async getMessageCountViaAPI(): Promise<number> {
    const conversationId = this.getConversationIdFromUrl();
    const url = `${apiUrl}/api/conversations/${conversationId}`;
    const response = await this.page.request.get(url);
    if (!response.ok()) {
      throw new Error(`Failed to get conversation: ${String(response.status())}`);
    }
    const data = (await response.json()) as { messages: unknown[] };
    return data.messages.length;
  }

  /**
   * Get the message-item at Virtuoso row index N (0-indexed). Addresses by
   * `data-item-index` (Virtuoso's per-row attribute) rather than by DOM
   * position, so callers don't get the wrong message when some rows are
   * virtualized out of the DOM.
   */
  getMessage(index: number): Locator {
    return this.messageList.locator(
      `[data-item-index="${String(index)}"] [data-testid="message-item"]`
    );
  }

  /** Get the last message item. */
  getLastMessage(): Locator {
    return this.messageList.locator('[data-testid="message-item"]').last();
  }

  /** Get message count in the visible list. */
  async getMessageCount(): Promise<number> {
    return this.messageList.locator('[data-testid="message-item"]').count();
  }

  /**
   * Read the current Virtuoso row count from `data-rows-count` and return
   * the index of the last row. Throws if no rows exist — callers that
   * capture an index for later use should fail loudly here rather than
   * silently propagate a sentinel.
   */
  async getLastRowIndex(): Promise<number> {
    const rowsCount = Number(await this.messageList.getAttribute('data-rows-count'));
    if (!Number.isFinite(rowsCount) || rowsCount <= 0) {
      throw new Error(
        `getLastRowIndex: data-rows-count is ${String(rowsCount)}; expected at least one row`
      );
    }
    return rowsCount - 1;
  }

  /**
   * Deterministically park a virtualized row in view. Uses Virtuoso's native
   * `scrollIntoView({ index, done })` via the dev/E2E-gated window backdoor in
   * `MessageList`. Resolves when the target row is measured and mounted —
   * `getMessage(index)` is guaranteed to resolve afterwards. Avoids the
   * iPhone-15 virtualization failure mode where `scrollTop = 0` alone leaves
   * the target unmounted because a tall media tile dominates the viewport.
   *
   * `index` is a Virtuoso row index, NOT a message index. In group chats
   * consecutive same-sender messages are collapsed into a single row, so
   * `rowsCount < messageCount`. Use `data-rows-count` (exposed by the
   * MessageList component) to bound the index.
   */
  async scrollMessageIntoView(index: number): Promise<void> {
    const rowsCount = Number(await this.messageList.getAttribute('data-rows-count'));
    if (Number.isNaN(rowsCount) || index < 0 || index >= rowsCount) {
      throw new Error(
        `scrollMessageIntoView: index ${String(index)} out of range [0, ${String(rowsCount)})`
      );
    }
    await this.page.evaluate(async (index_) => {
      const function_ = (
        globalThis as unknown as { __virtuosoScrollToIndex?: (n: number) => Promise<void> }
      ).__virtuosoScrollToIndex;
      if (typeof function_ !== 'function') {
        throw new TypeError(
          '__virtuosoScrollToIndex not exposed — check env.isLocalDev or env.isE2E is true'
        );
      }
      await function_(index_);
    }, index);
    // Short deadline so the outer poll can retry on re-virtualize.
    await expect(this.getMessage(index)).toBeAttached({ timeout: 500 });
  }

  /**
   * Park the row at `index` in Virtuoso's mounted window so its action buttons
   * are reachable. Polls to survive Virtuoso remount on fork-tab switch.
   * The predicate is not wrapped in try/catch — expect.poll retries on thrown
   * errors and surfaces the last one on timeout, so genuine "index out of range"
   * bugs are reported with their original message instead of "expected true,
   * received false".
   */
  async prepareMessage(index: number): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.scrollMessageIntoView(index);
          return true;
        },
        { timeout: 3000, intervals: [100, 250, 500, 500, 500, 500] }
      )
      .toBe(true);
  }

  /**
   * Park the last row. `getLastRowIndex()` is intentionally inside the poll —
   * during streaming the last index can grow between attempts.
   */
  async prepareLastMessage(): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.scrollMessageIntoView(await this.getLastRowIndex());
          return true;
        },
        { timeout: 3000, intervals: [100, 250, 500, 500, 500, 500] }
      )
      .toBe(true);
  }

  /** Get action button on a specific message by aria-label. */
  private getActionButton(messageIndex: number, label: string): Locator {
    return this.getMessage(messageIndex).getByRole('button', { name: label });
  }

  /** Get action button on the last message by aria-label. */
  private getLastMessageActionButton(label: string): Locator {
    return this.getLastMessage().getByRole('button', { name: label });
  }

  getRetryButton(index: number): Locator {
    return this.getActionButton(index, 'Retry');
  }

  getEditButton(index: number): Locator {
    return this.getActionButton(index, 'Edit');
  }

  getRegenerateButton(index: number): Locator {
    return this.getActionButton(index, 'Regenerate');
  }

  getForkButton(index: number): Locator {
    return this.getActionButton(index, 'Fork');
  }

  async clickRetry(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getRetryButton(index).click();
  }

  async clickEdit(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getEditButton(index).click();
  }

  async clickRegenerate(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getRegenerateButton(index).click();
  }

  async clickFork(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getForkButton(index).click();
  }

  async clickForkOnLastMessage(): Promise<void> {
    await this.prepareLastMessage();
    await this.getLastMessageActionButton('Fork').click();
  }

  getForkTabList(): Locator {
    return this.page.getByRole('tablist', { name: 'Conversation forks' });
  }

  getForkTab(name: string): Locator {
    return this.getForkTabList().getByRole('tab', { name });
  }

  async clickForkTab(name: string): Promise<void> {
    await this.getForkTab(name).click();
  }

  async expectForkTabCount(count: number): Promise<void> {
    await expect(this.getForkTabList().getByRole('tab')).toHaveCount(count);
  }

  async expectActiveForkTab(name: string): Promise<void> {
    await expect(this.getForkTab(name)).toHaveAttribute('aria-selected', 'true');
  }

  async expectNoForkTabs(): Promise<void> {
    await expect(this.getForkTabList()).not.toBeVisible();
  }

  /** Open the three-dot menu on a fork tab by name, then click an action. */
  async clickForkTabMenuAction(tabName: string, action: 'Rename' | 'Delete'): Promise<void> {
    const tabWrapper = this.getForkTabList().locator(`[data-testid^="fork-tab-"]`, {
      has: this.page.getByRole('tab', { name: tabName }),
    });
    await tabWrapper.getByRole('button', { name: 'More options' }).click();
    await this.page.getByRole('menuitem', { name: action }).click();
  }

  async expectEditModeActive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).toBeVisible();
  }

  async expectEditModeInactive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).not.toBeVisible();
  }

  async cancelEdit(): Promise<void> {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  getForkIdFromUrl(): string | null {
    const url = new URL(this.page.url());
    return url.searchParams.get('fork');
  }

  // --- Rename / Delete modals (shared with sidebar) ---

  async confirmRename(newName: string): Promise<void> {
    await expect(this.page.getByText('Rename conversation', { exact: true })).toBeVisible();
    const input = this.page.locator('input[placeholder="Conversation title"]');
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId('save-rename-button').click();
    await expect(this.page.getByText('Rename conversation', { exact: true })).not.toBeVisible();
  }

  async confirmDelete(): Promise<void> {
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId('confirm-delete-button').click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }

  /** Open the model selector modal by clicking the header button. */
  async openModelSelector(): Promise<void> {
    await this.page.getByTestId('model-selector-button').click();
    await expect(this.page.getByTestId('model-selector-modal')).toBeVisible();
  }

  /**
   * Switch the picker between single and multi modes by clicking the
   * appropriate option in the segmented PickerModeToggle. The toggle renders
   * twice (once per responsive layout); click the first visible option.
   */
  async switchPickerMode(mode: 'single' | 'multi'): Promise<void> {
    const modal = this.page.getByTestId('model-selector-modal');
    const targetTestId = mode === 'single' ? 'picker-mode-single' : 'picker-mode-multi';
    await modal.getByTestId(targetTestId).first().click();
    await expect(modal).toHaveAttribute('data-picker-mode', mode);
  }

  /**
   * Toggle a model in the picker. In single mode this commits + closes; in
   * multi mode it toggles a checkbox in the local pending selection. Either
   * way, the row body is the click target now (no more checkbox-only zone).
   */
  async toggleModelInModal(modelId: string): Promise<void> {
    const item = this.page.getByTestId(`model-item-${modelId}`);
    // Click the row's main button (the part that holds the model name + checkbox).
    await item.locator('button').first().click();
  }

  /**
   * Confirm the multi-mode pending selection via the footer Use button. In
   * single mode, row clicks commit + close immediately so this helper is
   * unnecessary — it falls through to closing via X if the modal is still
   * open with no Use button.
   */
  async confirmModelSelection(): Promise<void> {
    const modal = this.page.getByTestId('model-selector-modal');
    const useButton = modal.getByTestId('use-models-button');
    const isUseVisible = await useButton.isVisible().catch(() => false);
    if (isUseVisible) {
      await useButton.click();
    } else if (await modal.isVisible().catch(() => false)) {
      // Single mode after a row click already closed the modal; nothing to do.
      // If it's still open (no row was clicked), close via X.
      const closeButton = modal.getByRole('button', { name: 'Close' }).first();
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
      }
    }
    await unsettledExpect(modal).not.toBeVisible({ timeout: 5000 });
  }

  /**
   * Select a single model by name in single mode. Opens the picker, makes
   * sure single mode is active, clicks the row → commits + closes.
   */
  async selectSingleModel(modelId: string): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('single');
    const item = this.page.getByTestId(`model-item-${modelId}`);
    await item.locator('button').first().click();
    const modal = this.page.getByTestId('model-selector-modal');
    await unsettledExpect(modal).not.toBeVisible({ timeout: 5000 });
  }

  /**
   * Select N non-premium models via the modal in multi mode. Opens, switches
   * to multi mode, clears any pending state, clicks the first N non-premium
   * rows, and confirms via Use.
   */
  async selectModels(count: number): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId('model-selector-modal');

    const nonPremiumItems = modal.locator(
      '[data-testid^="model-item-"]:not([data-testid="model-item-smart-model"]):not(:has([data-testid="lock-icon"]))'
    );

    // Clear all pending selections to start from a known state.
    const clearButton = modal.getByTestId('clear-selection-button').first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    const available = await nonPremiumItems.count();
    const toSelect = Math.min(count, available);
    for (let index = 0; index < toSelect; index++) {
      const item = nonPremiumItems.nth(index);
      const isSelected = (await item.getAttribute('data-selected')) === 'true';
      if (!isSelected) {
        await item.locator('button').first().click();
        await expect(item).toHaveAttribute('data-selected', 'true');
      }
    }

    await this.confirmModelSelection();
  }

  /**
   * Select an explicit list of models by id in multi mode (used by tests that
   * need a specific model combination, e.g. multi-model media). Opens the
   * picker, switches to multi mode, clears any pending selection, clicks each
   * model id, then confirms via Use.
   */
  async selectModelsByIds(ids: readonly string[]): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId('model-selector-modal');

    const clearButton = modal.getByTestId('clear-selection-button').first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    for (const id of ids) {
      const item = modal.getByTestId(`model-item-${id}`);
      await expect(item).toBeVisible();
      await item.locator('button').first().click();
      await expect(item).toHaveAttribute('data-selected', 'true');
    }

    await this.confirmModelSelection();
  }

  /**
   * Select 2 models for partial failure testing:
   * - First non-premium model (will succeed)
   * - LAST non-premium model (will be configured to fail)
   * Returns { successModelId, failModelId }.
   * The fail model is never picked by selectModels(N) since that picks from the front.
   */
  async selectModelsWithFailTarget(): Promise<{ successModelId: string; failModelId: string }> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId('model-selector-modal');
    const nonPremiumItems = modal.locator(
      '[data-testid^="model-item-"]:not([data-testid="model-item-smart-model"]):not(:has([data-testid="lock-icon"]))'
    );

    const clearButton = modal.getByTestId('clear-selection-button').first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    const available = await nonPremiumItems.count();

    const firstItem = nonPremiumItems.nth(0);
    await firstItem.locator('button').first().click();
    await expect(firstItem).toHaveAttribute('data-selected', 'true');
    const firstTestId = await firstItem.getAttribute('data-testid');
    const successModelId = (firstTestId ?? '').replace('model-item-', '');

    // Select LAST model (fail target) — never picked by selectModels(N)
    const lastItem = nonPremiumItems.nth(available - 1);
    await lastItem.locator('button').first().click();
    await expect(lastItem).toHaveAttribute('data-selected', 'true');
    const lastTestId = await lastItem.getAttribute('data-testid');
    const failModelId = (lastTestId ?? '').replace('model-item-', '');

    await this.confirmModelSelection();
    return { successModelId, failModelId };
  }

  /** Count selected (checked) models in the open modal. */
  async getSelectedModelCount(): Promise<number> {
    const modal = this.page.getByTestId('model-selector-modal');
    return modal.locator('[data-testid^="model-item-"][data-selected="true"]').count();
  }

  /** Assert the comparison bar (multi-model pill bar) is visible. */
  async expectComparisonBarVisible(): Promise<void> {
    await expect(this.page.getByTestId('selected-models-bar')).toBeVisible();
  }

  /** Assert the comparison bar is not visible (single model or none). */
  async expectComparisonBarHidden(): Promise<void> {
    await expect(this.page.getByTestId('selected-models-bar')).not.toBeVisible();
  }

  /** Count model pills in the comparison bar. */
  async getComparisonBarModelCount(): Promise<number> {
    const bar = this.page.getByTestId('selected-models-bar');
    return bar.locator('button[aria-label^="Remove "]').count();
  }

  /** Remove a model from the comparison bar by clicking its X button. */
  async removeModelFromBar(modelName: string): Promise<void> {
    await this.page
      .getByTestId('selected-models-bar')
      .getByRole('button', { name: `Remove ${modelName}` })
      .click();
  }

  /** Assert the nametag text on the nth message item (0-indexed). */
  async expectModelNametag(messageIndex: number, expectedName: string): Promise<void> {
    const message = this.getMessage(messageIndex);
    await expect(message.getByTestId('model-nametag')).toContainText(expectedName);
  }

  /**
   * Assert every assistant message in the conversation has a model nametag.
   * Uses an atomic negative selector ("zero assistants lack a nametag") so
   * there is no TOCTOU gap between counting and per-item checks — the bug
   * that caused the WebKit flake in the first place. We check the items
   * Virtuoso has currently rendered rather than scrolling through every
   * virtualised row, because (a) nametag visibility is a per-item render
   * concern (if rendered, the nametag is there), and (b) scrolling through
   * a long conversation on mobile burns too much test time.
   */
  async expectAllAIMessagesHaveNametag(): Promise<void> {
    const assistantsWithoutNametag = this.messageList.locator(
      '[data-role="assistant"]:not(:has([data-testid="model-nametag"]))'
    );
    // Atomic: Playwright re-queries the locator each poll.
    await expect(assistantsWithoutNametag).toHaveCount(0, { timeout: 5000 });

    const renderedAssistants = await this.messageList.locator('[data-role="assistant"]').count();
    if (renderedAssistants === 0) {
      throw new Error('expectAllAIMessagesHaveNametag: no assistant messages rendered');
    }
  }

  /**
   * Wait for N AI response messages to appear after sending.
   * Waits for all N to have visible content (not just thinking indicators).
   */
  async waitForMultiModelResponses(count: number, timeout = 15_000): Promise<void> {
    const assistantMessages = this.messageList.locator('[data-role="assistant"]');
    await expect(assistantMessages).toHaveCount(count, { timeout });
    for (let index = 0; index < count; index++) {
      await expect(
        assistantMessages
          .nth(index)
          .getByText(/^Echo:/)
          .first()
      ).toBeVisible({
        timeout,
      });
    }
  }

  /** Get the message content text for an AI response identified by its nametag model name. */
  async getAIResponseByModel(modelName: string): Promise<string> {
    const assistantMessages = this.messageList.locator('[data-role="assistant"]');
    const count = await assistantMessages.count();
    for (let index = 0; index < count; index++) {
      const nametag = assistantMessages.nth(index).getByTestId('model-nametag');
      const nametagText = await nametag.textContent();
      if (nametagText?.includes(modelName)) {
        const messageText = await assistantMessages.nth(index).textContent();
        return messageText ?? '';
      }
    }
    throw new Error(`No AI response found with model nametag "${modelName}"`);
  }

  private getConversationIdFromUrl(): string {
    const url = new URL(this.page.url());
    const id = url.pathname.split('/').pop();
    if (!id || id === 'chat' || id === 'trial') {
      throw new Error('Not on a conversation page');
    }
    return id;
  }
}
