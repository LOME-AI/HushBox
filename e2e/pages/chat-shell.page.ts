import { type Page, type Locator } from '@playwright/test';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';

/** Escape a value for safe interpolation into a `[attr="…"]` CSS selector. */
export function escapeAttributeValue(value: string): string {
  return value.replaceAll(/["\\]/g, String.raw`\$&`);
}

declare global {
  // Exposed by the message list under local-dev and E2E builds only, which is
  // why the caller checks for it rather than assuming it.
  var __virtuosoScrollToIndex: ((index: number) => Promise<void>) | undefined;
}

/**
 * The chat page's shell: its locators, navigation, readiness signals, and the
 * scrolling and row addressing every other section of the page object stands on.
 */
export class ChatShellPage {
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
    this.promptInput = page.getByTestId(TEST_IDS.promptInput);
    this.messageInput = page.locator('main').getByTestId(TEST_IDS.promptInput);
    this.sendButton = page.getByTestId(TEST_IDS.sendButton);
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId(TEST_IDS.newChatPage);
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
    this.viewport = page.locator('[data-slot="scroll-area-viewport"]');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat', { waitUntil: 'domcontentloaded' });
  }

  async waitForAppStable(timeout: number = TIMEOUTS.APP_STABLE): Promise<void> {
    await this.page
      .locator(`[${TEST_SIGNALS.appStable}="true"]`)
      .waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for the composer's affordability producer to report resolved: the
   * payer's funding snapshot is served (or terminally unavailable, or the
   * caller holds no funding door) and the model catalog has landed.
   *
   * Every affordability readout renders neutral until then, and neutral is the
   * same DOM a passing assertion sees — so a spec that grades a greyed option,
   * a refused send, or an empty refusal set gates on this. `data-app-stable`
   * does not cover it: that gate spans the session and the balance read, while
   * the turn's verdict rides the payer's spendable read and the catalog.
   *
   * Scoped to `main` for the same reason the send helpers are: a composer can
   * also be mounted outside it.
   */
  async waitForAffordabilitySettled(timeout: number = TIMEOUTS.APP_STABLE): Promise<void> {
    await expect(
      this.page.locator('main').locator(`[${TEST_SIGNALS.affordabilitySettled}]`)
    ).toHaveAttribute(TEST_SIGNALS.affordabilitySettled, 'true', { timeout });
  }

  /**
   * Wait for the effort chip's slide wrapper to reach a state that answers
   * which selection the chip belongs to — `present` or `absent`, never the
   * `collapsing` middle value. An outgoing chip keeps rendering under the SAME
   * test id until its collapse transition ends, so a point-in-time visibility
   * read taken mid-collapse grades the ladder of the model that was replaced.
   *
   * `absent` is only a verdict once the catalog has landed, so a caller reading
   * the ladder gates on `waitForAffordabilitySettled` as well.
   */
  async waitForEffortControlSettled(timeout: number = TIMEOUTS.APP_STABLE): Promise<void> {
    await expect(
      this.page.locator('main').locator(`[${TEST_SIGNALS.effortControl}]`)
    ).toHaveAttribute(TEST_SIGNALS.effortControl, /^(?:present|absent)$/u, { timeout });
  }

  /** Wait for the group chat WebSocket to be connected. Use before actions that send events via WebSocket. */
  async waitForWebSocketConnected(timeout: number = TIMEOUTS.WS_HANDSHAKE): Promise<void> {
    await expect(this.page.locator(`[${TEST_SIGNALS.wsConnected}="true"]`)).toBeVisible({
      timeout,
    });
  }

  /** Wait for the WebSocket server-side registration to complete (DO ready for fan-out). */
  async waitForWebSocketReady(timeout: number = TIMEOUTS.WS_HANDSHAKE): Promise<void> {
    await this.page
      .locator(`[${TEST_SIGNALS.wsReady}="true"]`)
      .waitFor({ state: 'attached', timeout });
  }

  /** Wait for the message list to finish scrolling (layout stable). Use after programmatic scroll operations. */
  async waitForScrollStable(timeout: number = TIMEOUTS.SCROLL_STABLE): Promise<void> {
    await this.page
      .locator(`[${TEST_SIGNALS.virtuosoScrolling}="false"]`)
      .waitFor({ state: 'attached', timeout });
  }

  /**
   * Assert the message list is pinned at the bottom (auto-scroll settled). Gates
   * on the app's `data-at-bottom` signal, which flips false while post-stream
   * layout (code-block highlight, controls bar) grows and back to true once
   * auto-scroll re-pins — so this verifies the final settled state rather than a
   * one-shot pixel read taken mid-layout.
   *
   * Budgeted at STREAM_SATURATED, not SCROLL_STABLE/ASSERT: the re-pin waits on
   * an async layout pass (Shiki highlighting a code block, then a controls bar
   * mounting) whose ResizeObserver lands late on WebKit, and on a saturated
   * mobile engine that settle can run past 10s — the same saturated-stream tier
   * the turn it follows uses, so a loaded machine still observes the final pin.
   */
  async waitForAtBottom(timeout: number = TIMEOUTS.STREAM_SATURATED): Promise<void> {
    await expect(this.messageList).toHaveAttribute(TEST_SIGNALS.atBottom, 'true', { timeout });
  }

  async gotoTrialChat(): Promise<void> {
    await this.page.goto('/chat/trial', { waitUntil: 'domcontentloaded' });
  }

  async gotoConversation(conversationId: string): Promise<void> {
    await this.page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Reveal a clipped/virtualized row: walk Virtuoso's rows bottom→top, parking
   * each via the imperative `scrollMessageIntoView` backdoor, until `check`
   * passes. `scrollMessageIntoView` resolves only once the row is measured and
   * painted, so this reveals a clipped row deterministically regardless of host
   * load (no wall-clock scroll loop). Re-anchors every poll iteration because a
   * row can re-virtualize between the scroll and the check. On timeout, surfaces
   * Playwright's rich locator error against `locator` instead of `expect.poll`'s
   * opaque boolean mismatch (the poll already consumed the budget, so the
   * re-assertion needs only a short window).
   */
  protected async revealByRowScan(
    locator: Locator,
    timeout: number,
    check?: () => Promise<boolean>
  ): Promise<void> {
    const matches =
      check ??
      (async (): Promise<boolean> => {
        try {
          return await locator.isVisible();
        } catch {
          return false;
        }
      });
    try {
      await expect
        .poll(
          async () => {
            const rowsCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.rowsCount));
            if (!Number.isFinite(rowsCount) || rowsCount <= 0) return false;
            for (let index = rowsCount - 1; index >= 0; index--) {
              try {
                await this.scrollMessageIntoView(index);
              } catch {
                return false;
              }
              if (await matches()) return true;
            }
            return false;
          },
          { timeout }
        )
        .toBe(true);
    } catch {
      await expect(locator).toBeVisible({ timeout: TIMEOUTS.QUICK });
    }
  }

  protected async scrollByViewportFraction(frac: number): Promise<void> {
    await this.viewport.evaluate((el, f) => {
      el.scrollTop += el.clientHeight * f;
    }, frac);
  }

  protected async isAtScrollBottom(): Promise<boolean> {
    const { scrollTop, scrollHeight, clientHeight } = await this.getScrollPosition();
    return scrollTop + clientHeight >= scrollHeight - 10;
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
      // Dispatch the wheel gesture the app's break-away listener keys off (see
      // scrollUp) BEFORE moving the scroller. A bare `scrollTop = 0` fires no
      // user-scroll event, so auto-follow never disengages and re-pins the list
      // to the bottom on the next post-stream re-render — under a saturated
      // mobile engine that snaps the just-revealed top message back off-screen.
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -el.scrollHeight }));
      el.scrollTop = 0;
    });
  }

  async scrollUp(pixels: number): Promise<void> {
    // The app disengages auto-follow ("break away from bottom") only on a real
    // wheel/touchmove/keydown event (message-list markUserScroll); a bare
    // scrollTop write fires no such event, so the list re-pins to bottom and the
    // breakaway never registers. Dispatch the wheel event the breakaway listener
    // keys off (the same gesture the app's own unit tests use), then move the
    // scroller. markUserScroll does not check isTrusted, so the synthetic event
    // counts and this stays engine-portable (WebKit mouse-wheel support varies).
    await this.viewport.evaluate((el, px) => {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -px }));
      el.scrollTop = Math.max(0, el.scrollTop - px);
    }, pixels);
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

  /**
   * Get the message-item at Virtuoso row index N (0-indexed). Addresses by
   * `data-item-index` (Virtuoso's per-row attribute) rather than by DOM
   * position, so callers don't get the wrong message when some rows are
   * virtualized out of the DOM.
   */
  getMessage(index: number): Locator {
    // `data-item-index` is Virtuoso's own per-row attribute, not an app signal.
    return this.messageList
      .locator(`[data-item-index="${String(index)}"]`)
      .getByTestId(TEST_IDS.messageItem);
  }

  /** Get the last message item. */
  getLastMessage(): Locator {
    return this.messageList.getByTestId(TEST_IDS.messageItem).last();
  }

  /**
   * Read the current Virtuoso row count from `data-rows-count` and return
   * the index of the last row. Throws if no rows exist — callers that
   * capture an index for later use should fail loudly here rather than
   * silently propagate a sentinel.
   */
  async getLastRowIndex(): Promise<number> {
    const rowsCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.rowsCount));
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
    const rowsCount = Number(await this.messageList.getAttribute(TEST_SIGNALS.rowsCount));
    if (Number.isNaN(rowsCount) || index < 0 || index >= rowsCount) {
      throw new Error(
        `scrollMessageIntoView: index ${String(index)} out of range [0, ${String(rowsCount)})`
      );
    }
    await this.page.evaluate(async (index_) => {
      const function_ = globalThis.__virtuosoScrollToIndex;
      if (typeof function_ !== 'function') {
        throw new TypeError(
          '__virtuosoScrollToIndex not exposed — check env.isLocalDev or env.isE2E is true'
        );
      }
      await function_(index_);
    }, index);
    // Short deadline so the outer poll can retry on re-virtualize.
    await expect(this.getMessage(index)).toBeAttached({ timeout: TIMEOUTS.QUICK });
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
        { timeout: TIMEOUTS.SCROLL_STABLE, intervals: [100, 250, 500, 500, 500, 500] }
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
        { timeout: TIMEOUTS.SCROLL_STABLE, intervals: [100, 250, 500, 500, 500, 500] }
      )
      .toBe(true);
  }
}
