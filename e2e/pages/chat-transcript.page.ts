import { type Locator } from '@playwright/test';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from '../helpers/env.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { getBrowserName, lacksMediaDecode } from '../helpers/webkit-media-decode.js';
import { ChatComposerPage } from './chat-composer.page.js';
import { escapeAttributeValue } from './chat-shell.page.js';

const apiUrl = requireEnv('VITE_API_URL');

const MESSAGE_ID_SELECTOR = `[${TEST_SIGNALS.messageId}]`;
const ROLE_ATTR = TEST_SIGNALS.role;
// On a conversation page the message list carries the stream counter too; the
// sign-out signal is what singles out the shell root.
const SHELL_ROOT_SELECTOR = `[${TEST_SIGNALS.signedOut}][${TEST_SIGNALS.streamsCompleted}]`;

/**
 * The transcript: the messages, the streaming turn and its stream cycles, the
 * media the messages carry, their costs and nametags, and their per-message
 * actions.
 */
export class ChatTranscriptPage extends ChatComposerPage {
  async expectMessageVisible(message: string, timeout: number = TIMEOUTS.ASSERT): Promise<void> {
    // Thin alias so existing call sites keep working. Prefer assertMessageVisible
    // for new code — it is virtualization-agnostic and auto-scrolls if needed.
    await this.assertMessageVisible(message, { exact: true, timeout });
  }

  /**
   * Count messages in the conversation. Gates on the app-emitted
   * `data-messages-ready="true"` signal first so we never read
   * `data-message-count` mid-decryption, where it sits at 0 momentarily on
   * fork-tab switch / fresh navigation and would be mistaken for an empty
   * conversation.
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
      .and(this.page.locator(`[${TEST_SIGNALS.messagesReady}="true"]`))
      .waitFor({ timeout: TIMEOUTS.ASSERT });

    const stateCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.messageCount));

    // A fork-switch (or fresh navigation) remounts the virtualized list; Virtuoso
    // mounts its rows asynchronously, so the DOM `[data-message-id]` count briefly
    // lags the authoritative `data-message-count`. Wait for the DOM to catch up
    // before comparing — otherwise the mismatch drops us into the scroll-collect
    // path below, which then reads a transient under-count mid-remount (the
    // fork-switch "0/0/1 instead of 3" flake). A long virtualized list never fully
    // mounts, so this times out and falls through to scroll-collect as before.
    if (stateCount > 0) {
      await expect(this.messageList.locator(MESSAGE_ID_SELECTOR))
        .toHaveCount(stateCount, { timeout: TIMEOUTS.SCROLL_STABLE })
        .catch(() => {
          // Long virtualized list never mounts all rows — fall through to scroll-collect.
        });
    }

    const domCount = await this.messageList.locator(MESSAGE_ID_SELECTOR).count();

    // Happy path: every message is already rendered, no scrolling needed.
    if (stateCount === domCount) {
      if (role === undefined) return stateCount;
      return await this.messageList.locator(`[${ROLE_ATTR}="${role}"]`).count();
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
    const timeout = options?.timeout ?? TIMEOUTS.ASSERT;
    const locator = this.messageList.getByText(text, { exact }).first();

    // Happy path: already visible, or appears within a short wait window.
    // The short wait covers normal async lag (decryption, streaming) without
    // needing to scroll. If the message is genuinely off-screen due to
    // virtualization, this wait returns fast (locator stays not-visible)
    // and we fall through to the scroll path.
    const happyWait = Math.min(TIMEOUTS.ASSERT, timeout);
    const appeared = await locator
      .waitFor({ state: 'visible', timeout: happyWait })
      .then(() => true)
      .catch(() => false);
    if (appeared) return;

    // Slow path: the row is mounted but clipped/virtualized out of view. Reveal
    // it by parking each Virtuoso row and re-checking the text locator.
    const remaining = Math.max(TIMEOUTS.QUICK, timeout - happyWait);
    await this.revealByRowScan(locator, remaining);
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
      .and(this.page.locator(`[${TEST_SIGNALS.messagesReady}="true"]`))
      .waitFor({ timeout: TIMEOUTS.ASSERT });

    const stateCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.messageCount));
    const domCount = await this.messageList.locator(MESSAGE_ID_SELECTOR).count();

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
      role === undefined ? MESSAGE_ID_SELECTOR : `[${ROLE_ATTR}="${role}"]${MESSAGE_ID_SELECTOR}`;

    let done = false;
    while (!done) {
      const ids = await this.messageList
        .locator(selector)
        .evaluateAll(
          (els, attribute: string) => els.map((el) => el.getAttribute(attribute)),
          TEST_SIGNALS.messageId
        );
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
   * Wait for an assistant row containing `expectedContent`, then for the stream
   * cycle that rendered it to commit. The content is the only thing that ties
   * this wait to one turn, so it must be text no earlier answer carries — the
   * mock echoes the prompt, so the prompt is the usual choice.
   */
  async waitForAIResponse(
    expectedContent: string,
    // STREAM_SATURATED, not STREAM: a first message to a fresh conversation cold-
    // starts its ConversationRoom DO, and under the saturated matrix that first
    // token is starved (the stream POST sits open, not dropped) well past the
    // warm-path budget. Callers wanting the tighter warm bound pass it explicitly.
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    const target = this.messageList
      .locator(`[${ROLE_ATTR}="assistant"]`)
      .getByText(expectedContent, { exact: false })
      .first();
    await expect(target).toBeVisible({ timeout });
    await this.settleRenderedCycle(timeout);
  }

  /**
   * Settle the stream cycle whose output the caller has already seen render,
   * which proves the cycle started. A counter read beside a nonzero streaming
   * count is therefore a baseline taken inside that cycle; a zero count means
   * the cycle has already drained, and its commit is behind us.
   */
  private async settleRenderedCycle(timeout: number): Promise<void> {
    const { streaming, completed } = await this.messageList.evaluate(
      (list, names: { streaming: string; completed: string }) => ({
        streaming: Number(list.getAttribute(names.streaming)),
        completed: Number(list.getAttribute(names.completed)),
      }),
      { streaming: TEST_SIGNALS.streamingCount, completed: TEST_SIGNALS.streamsCompleted }
    );
    if (streaming > 0) {
      await this.waitForStreamCycle(completed, timeout);
      return;
    }
    await expect(this.messageList.getByTestId(TEST_IDS.messageActions).last()).toBeAttached({
      timeout: TIMEOUTS.ASSERT,
    });
  }

  async expectAssistantMessageContains(text: string): Promise<void> {
    await expect(this.messageList.getByText(text).first()).toBeVisible();
  }

  async expectMessageCostVisible(): Promise<void> {
    await expect(this.messageList.getByTestId(TEST_IDS.messageCost).first()).toBeVisible();
  }

  /**
   * Read the current value of `data-streams-completed` — a page-wide monotonic
   * count of completed stream cycles — from the shell root, which every route
   * renders, so a new-chat page has a baseline before its first send.
   *
   * Capture this BEFORE the action that triggers a stream, then pair with
   * `waitForStreamCycle(baseline)` (or use `withStreamCycle(action)`) to
   * deterministically wait for the cycle to complete: no gate can pass before
   * the turn it waits for has started, and there is no window in which the
   * stream can start and finish faster than a poller can observe it.
   */
  async captureStreamBaseline(): Promise<number> {
    return Number(
      (await this.page.locator(SHELL_ROOT_SELECTOR).getAttribute(TEST_SIGNALS.streamsCompleted)) ??
        '0'
    );
  }

  /**
   * Read the monotonic pre-inference-stage counter; capture before a Smart Model
   * send, then `waitForPreInferenceStage(baseline)` to prove the stage ran.
   */
  async capturePreInferenceBaseline(): Promise<number> {
    return Number(
      (await this.messageList.getAttribute(TEST_SIGNALS.preInferenceStagesSeen)) ?? '0'
    );
  }

  /** Wait for at least one pre-inference stage to be observed since `baseline`. */
  async waitForPreInferenceStage(
    baseline: number,
    timeout: number = TIMEOUTS.STREAM
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.preInferenceStagesSeen)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThan(baseline);
  }

  /**
   * Wait for at least one stream cycle to complete since `baseline`. Pair with
   * `captureStreamBaseline()` taken before the action that triggers the stream.
   *
   * The assertion is over the cycle counter (a fact: "a cycle finished"), never
   * over `data-streaming-count` alone: before a turn's stream starts that count
   * is already 0 and the user's own row already carries its toolbar, so a
   * drained-state check passes before the turn has begun.
   */
  async waitForStreamCycle(
    baseline: number,
    // STREAM_SATURATED, not STREAM: a stream cycle (including a regeneration that
    // deletes then re-streams) completes far slower when the conversation DO is
    // CPU-starved under the saturated matrix. The cycle counter still advances —
    // it is delayed, not lost.
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThan(baseline);
    // After the cycle counter increments, streaming-count is by definition 0;
    // a short deadline catches any incoherent state.
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '0', {
      timeout: TIMEOUTS.QUICK,
    });
    // The assistant's toolbar is already in the DOM once streaming has drained —
    // isStreaming cleared earlier, at the model:done flip. Assert attachment, not
    // viewport visibility: the toolbar sits at the foot of its message, so
    // `.last()` can sit below the scroll fold (short mobile viewports, or after a
    // deliberate scroll-up), and scrolling it into view here would corrupt the
    // caller's scroll-position assertions. This still catches a frozen UI whose
    // toolbar never renders; tests that click the toolbar gate its visibility
    // explicitly via prepareMessage() + a polled scroll-into-view.
    const lastToolbar = this.messageList.getByTestId(TEST_IDS.messageActions).last();
    await expect(lastToolbar).toBeAttached({ timeout: TIMEOUTS.ASSERT });
  }

  /**
   * Strict cycle-bounded helper: capture baseline, run `action`, wait for one
   * stream cycle to complete. Prefer this for tests that submit a turn and
   * then assert on the post-turn state.
   */
  async withStreamCycle<T>(
    action: () => Promise<T>,
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<T> {
    const baseline = await this.captureStreamBaseline();
    const result = await action();
    await this.waitForStreamCycle(baseline, timeout);
    return result;
  }

  /**
   * Wait until a run is actively streaming — the message list's
   * `data-streaming-count` signal is above zero. Pairs with a send to gate on
   * the run being in-flight without waiting for it to finish.
   */
  async waitForStreamingActive(timeout: number = TIMEOUTS.STREAM_SATURATED): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.streamingCount)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThan(0);
  }

  /**
   * Wait for `count` stream cycles to complete since `baseline`
   * (`data-streams-completed` advanced by at least `count`) and for streaming to
   * be fully drained. Use to gate an auto-draining queue where one run's settle
   * chains into the next send: asserting the intermediate `streaming-count === 0`
   * (as `waitForStreamCycle` does) would race the next cycle starting.
   */
  async waitForStreamCyclesCompleted(
    baseline: number,
    count: number,
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          Number((await this.messageList.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0'),
        { timeout }
      )
      .toBeGreaterThanOrEqual(baseline + count);
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '0', {
      timeout: TIMEOUTS.ASSERT,
    });
  }

  /**
   * Assert no message with `text` is present in the conversation list. Unlike
   * `assertMessageNotVisible`, it skips the `data-messages-ready` gate so it can
   * run mid-stream — where a queued (not sent) message must be absent.
   */
  async expectMessageAbsent(text: string): Promise<void> {
    await expect(this.messageList.getByText(text, { exact: true })).not.toBeVisible();
  }

  /**
   * Arm the dev/E2E-only "hold primary stream" mock for every subsequent chat
   * send: the mocked stream parks (streaming stays observably active) until
   * `releaseHeldStream` resolves the barrier. This lets a test pin the stream
   * open and assert against a live run with zero wall-clock racing.
   *
   * **Where it parks is decided by the turn, not by the caller.** A turn
   * carrying an active reasoning wire parks after its whole reasoning trace and
   * BEFORE the first answer delta, which is the only phase the live reasoning
   * window renders in; a turn with no reasoning wire has no earlier observable
   * signal, so it emits the first answer chunk and parks there. Effort defaults
   * to `auto` and rides every text send, so which of the two a spec gets follows
   * from its model selection and effort pin rather than from the word
   * "reasoning" appearing in it (`e2e/helpers/text-turn-shape.ts`).
   *
   * The header rides on every in-page fetch, including sends the test does not
   * issue itself, so clear it via `stopHoldingStreams()` before any send that
   * must stream to completion on its own (e.g. a queue's auto-drain) —
   * otherwise that send parks with no release. It does NOT reach `page.request`,
   * which takes its defaults from the browser context's `extraHTTPHeaders` and
   * never the page's.
   *
   * `stride` is how many further chunks one `releaseHeldStream` lets through
   * before the stream parks again, which is what lets a test walk a run forward
   * a known distance at a time. Without it a release drains the rest of the
   * stream, so the run parks exactly once.
   */
  async holdPrimaryStreamForNextSends(stride?: number): Promise<void> {
    await this.page.setExtraHTTPHeaders({
      'x-mock-hold-primary-stream': 'true',
      ...(stride === undefined ? {} : { 'x-mock-hold-primary-stream-stride': String(stride) }),
    });
  }

  /** Clear the hold header so subsequent sends stream to completion normally. */
  async stopHoldingStreams(): Promise<void> {
    await this.page.setExtraHTTPHeaders({});
  }

  /**
   * Release a stream parked by the hold mock via the dev-only Worker route,
   * letting the held run advance. Releasing when nothing is held is a harmless
   * no-op. Uses the same request context as the other API-backed helpers so it
   * shares the page's auth/base URL.
   *
   * One release frees one park. It returns only once the run has reached its
   * next park (the stride's chunks already emitted) or has finished, so a test
   * never waits on a clock to know the stream advanced.
   */
  async releaseHeldStream(conversationId: string): Promise<void> {
    const url = `${apiUrl}/chat/mock/release-stream?conversationId=${conversationId}`;
    const response = await withRequestRetry(this.page.request).get(url);
    await expectOkResponse(response, 'held-stream release');
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
  private async expectMediaLoaded(
    media: Locator,
    timeout: number = TIMEOUTS.MEDIA_DECODE
  ): Promise<void> {
    const skipVideoDecode = lacksMediaDecode(getBrowserName(this.page));
    await expect
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
   * row (a refetch after the turn settles) gets visited. Success
   * requires decoded bytes — `naturalWidth > 0` or a playable duration —
   * to avoid passing on a `MediaPlaceholder` or a still-decrypting `<img>`
   * with a 0×0 bounding box.
   */
  async expectMediaVisible(
    kind: 'img' | 'video',
    timeout: number = TIMEOUTS.MEDIA_DECODE
  ): Promise<void> {
    const media = this.messageList.locator(kind).first();
    const skipVideoDecode = lacksMediaDecode(getBrowserName(this.page));
    await this.revealByRowScan(media, timeout, async () => {
      if (!(await media.isVisible().catch(() => false))) return false;
      return media
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
    });
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
    timeout: number = TIMEOUTS.MEDIA_DECODE
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
      // failure instead of `expect.poll`'s opaque boolean mismatch. The poll
      // above already consumed the real budget, so this re-assertion only needs
      // a short window to render the rich error against the still-failing
      // locator.
      await expect(media).toBeVisible({ timeout: TIMEOUTS.QUICK });
    }
    await this.expectMediaLoaded(media);
  }

  async expectImageVisible(timeout: number = TIMEOUTS.MEDIA_DECODE): Promise<void> {
    await this.expectMediaVisible('img', timeout);
  }

  async expectVideoVisible(timeout: number = TIMEOUTS.MEDIA_DECODE): Promise<void> {
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

  /** Message items carrying the given role signal (`data-role`). */
  messagesByRole(role: 'assistant' | 'user'): Locator {
    return this.messageList.locator(`[${ROLE_ATTR}="${role}"]`);
  }

  /** A message item addressed by its message-id signal. */
  messageById(messageId: string): Locator {
    return this.messageList.locator(
      `[${TEST_SIGNALS.messageId}="${escapeAttributeValue(messageId)}"]`
    );
  }

  /** A role-tagged message within a specific Virtuoso row (`data-item-index`). */
  messageAtRow(rowIndex: number, role: 'assistant' | 'user'): Locator {
    return this.messageList.locator(
      `[data-item-index="${String(rowIndex)}"] [${ROLE_ATTR}="${role}"]`
    );
  }

  /** Persisted assistant tiles — assistant messages carrying a message-id. */
  assistantTilesWithId(): Locator {
    return this.messageList.locator(`[${ROLE_ATTR}="assistant"][${TEST_SIGNALS.messageId}]`);
  }

  /** `<video>` elements within a scope. `<video>` has no ARIA role, so a raw element locator is required. */
  videosIn(scope: Locator): Locator {
    return scope.locator('video');
  }

  /** `<video>` elements with a specific `src` within a scope. */
  videosWithSrcIn(scope: Locator, source: string): Locator {
    return scope.locator(`video[src="${escapeAttributeValue(source)}"]`);
  }

  /** `<img>` elements within a scope. Selected by element since generated images may carry an empty alt (presentation role). */
  imagesIn(scope: Locator): Locator {
    return scope.locator('img');
  }

  /** `<img>` elements with an empty `src` (would render as a broken image). */
  brokenImagesIn(scope: Locator): Locator {
    return scope.locator('img[src=""]');
  }

  async getMessageCountViaAPI(): Promise<number> {
    const conversationId = this.getConversationIdFromUrl();
    const url = `${apiUrl}/conversations/${conversationId}/messages`;
    const response = await withRequestRetry(this.page.request).get(url);
    await expectOkResponse(response, 'conversation messages read');
    const data = (await response.json()) as { messages: unknown[] };
    return data.messages.length;
  }

  /** Get message count in the visible list. */
  async getMessageCount(): Promise<number> {
    return this.messageList.getByTestId(TEST_IDS.messageItem).count();
  }

  /**
   * A control on one message, by its accessible name, scoped to the message's
   * controls group: a reply's body carries buttons of its own (a code block's
   * Copy, a document card's Open) that a message-wide role query would also match.
   */
  private getActionButton(messageIndex: number, label: string): Locator {
    return this.getMessage(messageIndex)
      .getByTestId(TEST_IDS.messageActions)
      .getByRole('button', { name: label });
  }

  /** A control on the last message, scoped to its controls group as above. */
  private getLastMessageActionButton(label: string): Locator {
    return this.getLastMessage()
      .getByTestId(TEST_IDS.messageActions)
      .getByRole('button', { name: label });
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

  /**
   * Gate a retry/regenerate dispatch on the decrypted message set being ready —
   * the app no-ops a regenerate whose anchor content isn't decrypted yet, so an
   * early click would never start a stream.
   */
  async waitForMessagesReady(): Promise<void> {
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.messagesReady, 'true', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });
  }

  async clickRetry(index: number): Promise<void> {
    await this.waitForMessagesReady();
    await this.prepareMessage(index);
    await this.getRetryButton(index).click();
  }

  async clickEdit(index: number): Promise<void> {
    await this.prepareMessage(index);
    await this.getEditButton(index).click();
  }

  async clickRegenerate(index: number): Promise<void> {
    await this.waitForMessagesReady();
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

  async expectEditModeActive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).toBeVisible();
  }

  async expectEditModeInactive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).not.toBeVisible();
  }

  async cancelEdit(): Promise<void> {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  /**
   * The thinking disclosure inside one assistant message (per-message, like
   * the nametag assertions — never a page-global testid query, so a
   * multi-message conversation can't satisfy the assertion with the wrong
   * message's disclosure).
   */
  thinkingDisclosureFor(assistantMessage: Locator): Locator {
    return assistantMessage.getByTestId(TEST_IDS.thinkingDisclosure);
  }

  /** Assert the nametag text on the nth message item (0-indexed). */
  async expectModelNametag(messageIndex: number, expectedName: string): Promise<void> {
    const message = this.getMessage(messageIndex);
    await expect(message.getByTestId(TEST_IDS.modelNametag)).toContainText(expectedName);
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
      `[${ROLE_ATTR}="assistant"]:not(:has([data-testid="${TEST_IDS.modelNametag}"]))`
    );
    // Atomic: Playwright re-queries the locator each poll.
    await expect(assistantsWithoutNametag).toHaveCount(0, { timeout: TIMEOUTS.ASSERT });

    const renderedAssistants = await this.messageList.locator(`[${ROLE_ATTR}="assistant"]`).count();
    if (renderedAssistants === 0) {
      throw new Error('expectAllAIMessagesHaveNametag: no assistant messages rendered');
    }
  }

  /**
   * Wait for N AI response messages to appear after sending.
   * Waits for all N to have visible content (not just thinking indicators).
   */
  async waitForMultiModelResponses(
    count: number,
    timeout: number = TIMEOUTS.STREAM_SATURATED
  ): Promise<void> {
    const assistantMessages = this.messageList.locator(`[${ROLE_ATTR}="assistant"]`);
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
    // Token visibility (DOM) runs ahead of the server-side settle: the streamed
    // text appears before `saveChatTurn` commits. Callers that then read the
    // conversation via the API (e.g. getMessageCountViaAPI) would race the
    // commit, so gate on persistence here. The `Echo:` rows prove this turn's
    // stream ran only while `count` is every assistant row the conversation
    // holds, as on a fresh conversation's first send.
    await this.settleRenderedCycle(timeout);
  }

  /** Get the message content text for an AI response identified by its nametag model name. */
  async getAIResponseByModel(modelName: string): Promise<string> {
    const assistantMessages = this.messageList.locator(`[${ROLE_ATTR}="assistant"]`);
    const count = await assistantMessages.count();
    for (let index = 0; index < count; index++) {
      const nametag = assistantMessages.nth(index).getByTestId(TEST_IDS.modelNametag);
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
