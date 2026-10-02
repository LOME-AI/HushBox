import { ROUTES, TEST_IDS, isMobileWidth } from '@hushbox/shared';
import { test, expect } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import { TIMEOUTS } from './config/timeouts.js';
import type { Page, Locator } from './fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

// Fixtures re-exports the Playwright types specs may name, but not
// FrameLocator; derive it from Locator so this spec still sources every
// Playwright type through the fixtures module.
type DemoFrame = ReturnType<Locator['contentFrame']>;

/**
 * There is no top-level demo page: navigating to /demo outside an iframe
 * redirects to the marketing /welcome page (see demo/bootstrap.tsx — the demo
 * boots only when `top !== self`). The real demo runs inside the same-origin
 * iframe AppDemo.astro injects into the /welcome `#demo` section once it
 * scrolls into view, so land directly on the anchor (the IntersectionObserver
 * mounts the iframe) and drive everything through the frame.
 */
async function openDemo(page: Page): Promise<DemoFrame> {
  await page.goto(`${ROUTES.MARKETING}#demo`);
  return page.getByTitle('HushBox interactive demo').contentFrame();
}

/**
 * The demo runs under a memory-history router precisely so the iframe's
 * document URL never leaves /demo — blocked actions must nudge instead of
 * navigating the frame away. FrameLocator has no toHaveURL, so poll the
 * page's frame list for a frame whose document path is still /demo.
 */
async function expectDemoFrameUrl(page: Page): Promise<void> {
  await expect
    .poll(() => page.frames().map((frame) => new URL(frame.url()).pathname), {
      timeout: TIMEOUTS.ASSERT,
    })
    .toContain(ROUTES.DEMO);
}

/**
 * Opens the requested demo conversation. The demo runs the real app shell, so
 * on mobile viewports the conversation list lives in a sidebar Sheet that
 * starts closed and re-closes after navigation — it must be reopened before
 * each switch. On desktop the sidebar is always rendered, so this is a no-op.
 * Mirrors helpers/auth.ts openMobileSidebarIfNeeded, retargeted at the frame
 * (the helper takes a Page; the demo's sidebar lives inside the iframe).
 */
async function selectDemoConversation(page: Page, demo: DemoFrame, index: number): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport !== null && isMobileWidth(viewport.width)) {
    const sidebar = demo.getByTestId(TEST_IDS.sidebar);
    if (!(await sidebar.isVisible())) {
      await demo.getByTestId(TEST_IDS.hamburgerButton).click();
      await sidebar.waitFor({ state: 'visible' });
    }
  }
  await demo.getByTestId(TEST_IDS.chatLink).nth(index).click();
}

/**
 * Opens the member pane via the facepile. Mirrors
 * MemberSidebarPage.openViaFacepile, retargeted at the frame. On a phone the
 * pane fills the screen as a modal overlay; Playwright's actionability check
 * waits out its entrance before any subsequent interaction.
 */
async function openMemberSidebarViaFacepile(page: Page, demo: DemoFrame): Promise<void> {
  const isExpanded = await demo
    .getByTestId(TEST_IDS.memberSearchInput)
    .isVisible()
    .catch(() => false);
  if (!isExpanded) await demo.getByTestId(TEST_IDS.memberFacepile).click();
  await demo
    .getByTestId(TEST_IDS.memberSidebarContent)
    .waitFor({ state: 'visible', timeout: TIMEOUTS.ASSERT });
  const viewport = page.viewportSize();
  if (viewport !== null && isMobileWidth(viewport.width)) {
    await expect(demo.getByTestId(TEST_IDS.memberSidebar)).toBeVisible();
  }
}

/**
 * Smoke test for the interactive product demo embedded on /welcome. Guards the
 * whole demo stack: the real app boots in demo mode inside the iframe (seeded
 * session + network shim + real crypto), the typing director streams a reply,
 * conversation switching keeps the memory-router URL at /demo, and unsupported
 * actions are intercepted with a sign-up nudge instead of navigating away or
 * erroring.
 */
test.describe('interactive demo (/welcome iframe)', SPEC_MATRIX, () => {
  test('boots the real shell, streams a director reply, switches, and nudges blocked actions', async ({
    unauthenticatedPage: page,
  }) => {
    // This journey awaits three separate director playbacks, each paced
    // token-by-token by the demo itself, so its floor is the pacing rather
    // than anything the harness can shorten. The three together sit close
    // enough to the default per-test budget that the slower engines overrun
    // it; the tripled budget is what the work costs, not slack.
    test.slow();

    const demo = await openDemo(page);

    // The director auto-opens the first conversation through the new-chat
    // welcome screen and streams a reply + follow-up through the real
    // token-by-token path. Assert BEFORE any sidebar interaction: a trusted
    // pointer tap (e.g. opening the mobile sidebar) aborts the director's
    // in-flight playback (see demo/director.ts), so the welcome stream must be
    // awaited first. The wider budget covers the welcome lead-in + two paced
    // turns.
    await expect(demo.getByText('decrypted just long enough')).toBeVisible({
      timeout: TIMEOUTS.STREAM_CLEAR,
    });

    // Switching conversations works and the iframe document URL stays /demo
    // (memory-history router — reload-safe). selectDemoConversation opens the
    // mobile sidebar as needed, which also proves the sidebar lists the fixtures.
    await selectDemoConversation(page, demo, 1);
    await expectDemoFrameUrl(page);

    // Let the director finish playing this conversation before switching again.
    // On mobile the sidebar is a Sheet that re-closes on every navigation, so a
    // switch issued while the director is still streaming (and navigating)
    // re-closes the Sheet mid-click and detaches the chat-link. The final
    // streamed reply means the director is idle, so the next sidebar open holds.
    await expect(demo.getByText('never a lock-in')).toBeVisible({
      timeout: TIMEOUTS.STREAM_CLEAR,
    });

    // Unsupported control (group member management) → sign-up nudge, no nav.
    await selectDemoConversation(page, demo, 0);
    // Wait for the welcome conversation to finish re-opening: its final streamed
    // reply means the director has stopped navigating (all of its navigation
    // happens before the first reply), so the member pane won't be torn down
    // mid-interaction.
    await expect(demo.getByText('decrypted just long enough')).toBeVisible({
      timeout: TIMEOUTS.STREAM_CLEAR,
    });
    // newMemberButton lives in the member pane, which leaves nothing on screen
    // while closed at any width, so open it via the facepile before reaching for
    // the add-member control.
    await openMemberSidebarViaFacepile(page, demo);
    await demo.getByTestId(TEST_IDS.newMemberButton).click();
    await expect(demo.getByText('Create a free account to invite people')).toBeVisible();
    await expectDemoFrameUrl(page);
  });

  // Conversation tiles carry no stable title text to filter on, so they're
  // selected positionally, in the listed order: 0 welcome, 1 smart-model,
  // 2 code/math, 3 image, 4 video, 5 group.
  const CONVERSATION = { codeMath: 2, image: 3, video: 4, group: 5 } as const;

  test('decrypts generated image and video media from ciphertext', async ({
    unauthenticatedPage: page,
  }) => {
    const demo = await openDemo(page);

    // The AI image is served as ciphertext (a data: URL), fetched, and decrypted
    // in-browser through the real media path — the lightbox affordance only
    // renders once the blob URL resolves, so its presence proves the decrypt
    // succeeded against the fake backend.
    await selectDemoConversation(page, demo, CONVERSATION.image);
    // The shim emits synthetic `model:media:start` frames, so the real
    // optimistic UI shows the "Generating image…" placeholder during the
    // generation pause before the bytes land — proving the media-generation UX
    // (not just a generic loader) runs against the fake backend.
    await expect(demo.getByRole('status', { name: /Generating image/ })).toBeVisible({
      timeout: TIMEOUTS.STREAM,
    });
    await expect(demo.getByRole('button', { name: 'Open image in lightbox' })).toBeVisible({
      timeout: TIMEOUTS.MEDIA_DECODE,
    });

    // An encrypted MP4 clip decrypts the same way into a real <video>; its
    // fullscreen affordance likewise only renders after the blob URL resolves.
    await selectDemoConversation(page, demo, CONVERSATION.video);
    await expect(demo.getByRole('button', { name: 'Expand video to fullscreen' })).toBeVisible({
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
  });

  test('locks the composer: a real modality-switch click nudges instead of switching', async ({
    unauthenticatedPage: page,
  }) => {
    const demo = await openDemo(page);

    // Open the image conversation: the director auto-switches to image modality
    // and renders the generated image (its lightbox proves the run finished and
    // image is the active modality, so its own icon is omitted).
    await selectDemoConversation(page, demo, CONVERSATION.image);
    await expect(demo.getByRole('button', { name: 'Open image in lightbox' })).toBeVisible({
      timeout: TIMEOUTS.MEDIA_DECODE,
    });

    // A real (trusted) user choice of a mode is intercepted with a sign-up nudge
    // and does NOT switch: the mode never becomes active, so no chip names it.
    await demo.getByRole('button', { name: 'Change mode' }).click();
    await demo.getByRole('menuitemradio', { name: 'Video', exact: true }).click();
    await expect(demo.getByText('Create a free account to switch modes')).toBeVisible();
    await expect(demo.getByRole('button', { name: 'Mode: video' })).toHaveCount(0);
  });

  test('renders a group conversation with per-member sender labels', async ({
    unauthenticatedPage: page,
  }) => {
    const demo = await openDemo(page);

    // A group conversation (members > 1) opens a WebSocket — the fake keeps it
    // ready with no server. It starts empty and the director replays the
    // transcript live: each message is appended and broadcast as `message:new`
    // over the fake socket, which the real refetch path renders, decrypted under
    // the shared epoch with per-sender labels (group mode).
    await selectDemoConversation(page, demo, CONVERSATION.group);
    await expect(
      demo.getByText('Every message here is end-to-end encrypted, even in a group like this one.')
    ).toBeVisible({ timeout: TIMEOUTS.STREAM_CLEAR });
    await expect(demo.getByText('sana', { exact: true })).toBeVisible();
  });

  test('regenerate re-streams a reply in place without breaking the thread', async ({
    unauthenticatedPage: page,
  }) => {
    const demo = await openDemo(page);
    await selectDemoConversation(page, demo, CONVERSATION.codeMath);

    const reply = demo.getByText('Binary search halves the range');
    await expect(reply).toBeVisible({ timeout: TIMEOUTS.STREAM_CLEAR });

    // Regenerate is supported in the demo — it re-streams against the fake
    // backend, replacing the assistant message in place. The thread stays
    // intact: still exactly one assistant reply (one Regenerate affordance),
    // its content present, and no sign-up nudge.
    await demo.getByRole('button', { name: 'Regenerate' }).click();
    await expect(demo.getByRole('button', { name: 'Regenerate' })).toHaveCount(1, {
      timeout: TIMEOUTS.STREAM,
    });
    await expect(reply).toBeVisible();
  });
});
