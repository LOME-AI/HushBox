import { test, expect } from '@playwright/test';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from './config/timeouts.js';

/**
 * Smoke test for the interactive product demo (`/demo`). Guards the whole demo
 * stack: the real app boots in demo mode (seeded session + network shim + real
 * crypto), the typing director streams a reply, conversation switching keeps
 * the memory-router URL at /demo, and unsupported actions are intercepted with
 * a sign-up nudge instead of navigating away or erroring.
 */
test.describe('interactive demo (/demo)', () => {
  test('boots the real shell, streams a director reply, switches, and nudges blocked actions', async ({
    page,
  }) => {
    await page.goto(ROUTES.DEMO);

    // Real app shell: the sidebar lists the fixture conversations.
    await expect(page.getByTestId(TEST_IDS.chatLink).first()).toBeVisible();

    // The director opens the first conversation through the new-chat welcome
    // screen (types the prompt there, fakes the send), then streams the reply and
    // a follow-up through the real token-by-token path. Wider budget covers the
    // welcome lead-in + two paced turns.
    await expect(page.getByText('decrypted just long enough')).toBeVisible({
      timeout: TIMEOUTS.STREAM_CLEAR,
    });

    // Switching conversations works and the iframe document URL stays /demo
    // (memory-history router — reload-safe).
    await page.getByTestId(TEST_IDS.chatLink).nth(1).click();
    await expect(page).toHaveURL(new RegExp(`${ROUTES.DEMO}$`));

    // Unsupported control (group member management) → sign-up nudge, no nav.
    await page.getByTestId(TEST_IDS.chatLink).first().click();
    await page.getByTestId(TEST_IDS.newMemberButton).click();
    await expect(page.getByText('Create a free account to invite people')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${ROUTES.DEMO}$`));
  });

  // The demo's sidebar renders as a collapsed icon rail, so conversation tiles
  // carry no title text to filter on — they're selected positionally, in the
  // listed order: 0 welcome, 1 smart-model, 2 code/math, 3 image, 4 video, 5 group.
  const CONVERSATION = { codeMath: 2, image: 3, video: 4, group: 5 } as const;

  test('decrypts generated image and video media from ciphertext', async ({ page }) => {
    await page.goto(ROUTES.DEMO);
    const conversations = page.getByTestId(TEST_IDS.chatLink);

    // The AI image is served as ciphertext (a data: URL), fetched, and decrypted
    // in-browser through the real media path — the lightbox affordance only
    // renders once the blob URL resolves, so its presence proves the decrypt
    // succeeded against the fake backend.
    await conversations.nth(CONVERSATION.image).click();
    // The shim emits synthetic `model:media:start` frames, so the real
    // optimistic UI shows the "Generating image…" placeholder during the
    // generation pause before the bytes land — proving the media-generation UX
    // (not just a generic loader) runs against the fake backend.
    await expect(page.getByRole('status', { name: /Generating image/ })).toBeVisible({
      timeout: TIMEOUTS.STREAM,
    });
    await expect(page.getByRole('button', { name: 'Open image in lightbox' })).toBeVisible({
      timeout: TIMEOUTS.MEDIA_DECODE,
    });

    // An encrypted MP4 clip decrypts the same way into a real <video>; its
    // fullscreen affordance likewise only renders after the blob URL resolves.
    await conversations.nth(CONVERSATION.video).click();
    await expect(page.getByRole('button', { name: 'Expand video to fullscreen' })).toBeVisible({
      timeout: TIMEOUTS.MEDIA_DECODE,
    });
  });

  test('locks the composer: a real modality-switch click nudges instead of switching', async ({
    page,
  }) => {
    await page.goto(ROUTES.DEMO);

    // Open the image conversation: the director auto-switches to image modality
    // and renders the generated image (its lightbox proves the run finished and
    // image is the active modality, so its own icon is omitted).
    await page.getByTestId(TEST_IDS.chatLink).nth(CONVERSATION.image).click();
    await expect(page.getByRole('button', { name: 'Open image in lightbox' })).toBeVisible({
      timeout: TIMEOUTS.MEDIA_DECODE,
    });

    // A real (trusted) user click on a modality icon is intercepted with a
    // sign-up nudge and does NOT switch — the icon stays present because its
    // modality never became active. The director's own (untrusted) switch above
    // still worked, which is what made the image render.
    const switchToText = page.getByRole('button', { name: 'Switch to text' });
    await switchToText.click();
    await expect(page.getByText('Create a free account to switch modes')).toBeVisible();
    await expect(switchToText).toBeVisible();
  });

  test('renders a group conversation with per-member sender labels', async ({ page }) => {
    await page.goto(ROUTES.DEMO);

    // A group conversation (members > 1) opens a WebSocket — the fake keeps it
    // ready with no server. It starts empty and the director replays the
    // transcript live: each message is appended and broadcast as `message:new`
    // over the fake socket, which the real refetch path renders, decrypted under
    // the shared epoch with per-sender labels (group mode).
    await page.getByTestId(TEST_IDS.chatLink).nth(CONVERSATION.group).click();
    await expect(
      page.getByText('Every message here is end-to-end encrypted, even in a group like this one.')
    ).toBeVisible({ timeout: TIMEOUTS.STREAM_CLEAR });
    await expect(page.getByText('sana', { exact: true })).toBeVisible();
  });

  test('regenerate re-streams a reply in place without breaking the thread', async ({ page }) => {
    await page.goto(ROUTES.DEMO);
    await page.getByTestId(TEST_IDS.chatLink).nth(CONVERSATION.codeMath).click();

    const reply = page.getByText('Binary search halves the range');
    await expect(reply).toBeVisible({ timeout: TIMEOUTS.STREAM_CLEAR });

    // Regenerate is supported in the demo — it re-streams against the fake
    // backend, replacing the assistant message in place. The thread stays
    // intact: still exactly one assistant reply (one Regenerate affordance),
    // its content present, and no sign-up nudge.
    await page.getByRole('button', { name: 'Regenerate' }).click();
    await expect(page.getByRole('button', { name: 'Regenerate' })).toHaveCount(1, {
      timeout: TIMEOUTS.STREAM,
    });
    await expect(reply).toBeVisible();
  });
});
