import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages/index.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * Release a run parked by the hold mock, without cleanup ever speaking over the
 * failure that sent it here: the release is raised only when the body succeeded
 * and a stuck run is therefore the only thing wrong, and on the failure path it
 * is attached instead. Never dropped either way, because a run left parked keeps
 * its funding hold until that hold's TTL, which the rest of the run pays for.
 */
async function releaseParkedRun(
  chatPage: ChatPage,
  conversationId: string,
  bodySucceeded: boolean
): Promise<void> {
  if (bodySucceeded) {
    await chatPage.releaseHeldStream(conversationId);
    return;
  }
  // eslint-disable-next-line comments/resolvable-cross-reference -- the E2E harness writes its run report there and git ignores it, so the citation is correct and resolves only after a run
  // A throw out of cleanup REPLACES the error being unwound, and `e2e/report/`
  // (where this suite is debugged) would then carry the cleanup symptom instead
  // of the diagnosis.
  await chatPage.releaseHeldStream(conversationId).catch(async (releaseError: unknown) => {
    await test.info().attach('held-stream-release-failed', {
      body: releaseError instanceof Error ? releaseError.message : 'non-Error thrown',
      contentType: 'text/plain',
    });
  });
}

test.describe('Message Queue', SPEC_MATRIX, () => {
  test('queued message auto-sends after active run completes', async ({
    authenticatedPage,
    testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    const stamp = String(Date.now());
    const messageA = `Queue A ${stamp}`;
    const messageB = `Queue B ${stamp}`;
    const messageC = `Queue C ${stamp}`;

    // Captured before any send: A's run and B's auto-sent run each advance
    // stream-cycle counter by one; C is canceled and must never advance it.
    const streamBaseline = await chatPage.captureStreamBaseline();

    await test.step('send A held open — streaming pinned active after first chunk', async () => {
      // Pin A's stream open at its first chunk so every enqueue below gates on a
      // deterministically-active stream, not the mock's brief real streaming
      // window. Released explicitly further down.
      await chatPage.holdPrimaryStreamForNextSends();
      await chatPage.sendFollowUpMessage(messageA);
      await chatPage.waitForStreamingActive();
    });

    await test.step('queue B while A streams — pill shown, B not yet sent', async () => {
      await chatPage.enqueueWhileStreaming(messageB);
      await expect(chatPage.queuedPill(0)).toBeVisible();
      await chatPage.expectMessageAbsent(messageB);
    });

    await test.step('queue C while A streams — two pills shown', async () => {
      // A is still parked, so streaming is deterministically active — re-gate so
      // C's enqueue is coupled to the in-flight run, never a settled one.
      await chatPage.waitForStreamingActive();
      await chatPage.enqueueWhileStreaming(messageC);
      await expect(chatPage.queuedPill(0)).toBeVisible();
      await expect(chatPage.queuedPill(1)).toBeVisible();
      await expect.poll(async () => chatPage.queuedPillCount()).toBe(2);
      await chatPage.expectMessageAbsent(messageC);
    });

    await test.step('cancel C — one pill remains', async () => {
      await chatPage.cancelQueuedPill(1);
      await expect(chatPage.queuedPill(1)).not.toBeVisible();
      await expect(chatPage.queuedPill(0)).toBeVisible();
      await expect.poll(async () => chatPage.queuedPillCount()).toBe(1);
    });

    await test.step('release A, then B auto-drains and streams', async () => {
      // Clear the hold BEFORE releasing: B's auto-drain send fires at A's settle
      // and must stream to completion on its own — inheriting the hold header
      // would park B with no release and hang the test.
      await chatPage.stopHoldingStreams();
      await chatPage.releaseHeldStream(testConversation.id);
      // The queue drains at A's settle: B leaves the pill stack and sends, so
      // the region unmounts once its last pill (B) is dequeued.
      await expect(chatPage.queuedRegion()).not.toBeVisible({
        timeout: TIMEOUTS.STREAM_SATURATED,
      });
      // Two cycles since baseline: A's run and B's auto-sent run, both settled.
      await chatPage.waitForStreamCyclesCompleted(streamBaseline, 2);
      await chatPage.assertMessageVisible(messageB);
    });

    await test.step('persisted turns are A then B — C was never sent', async () => {
      const count = await chatPage.getMessageCountViaAPI();
      // Seed (2) + A turn (user + assistant) + B turn (user + assistant) = 6.
      expect(count).toBe(6);
      await chatPage.expectMessageAbsent(messageC);
    });
  });

  test('a message queued while the balance is still loading drains once it resolves', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    const stamp = String(Date.now());
    const messageA = `Loading A ${stamp}`;
    const messageB = `Loading B ${stamp}`;

    // A first turn is sent with no conversation yet, so the conversation-scoped
    // funding read is only issued once the real id lands — while that same turn
    // is already streaming. The overlap is structural, not contrived: the
    // composer's balance is genuinely unread for the exact window the queue
    // exists for. Parking that read holds the window open on a barrier the test
    // resolves; the scope-less read the first send needs is not matched here, so
    // it still answers normally.
    let releaseFunding!: () => void;
    const fundingHeld = new Promise<void>((resolve) => {
      releaseFunding = resolve;
    });
    let readsParked = 0;
    let readsServed = 0;
    await authenticatedPage.route(/\/billing\/spendable\?.*conversationId=/, async (route) => {
      readsParked++;
      await fundingHeld;
      const response = await route.fetch();
      await route.fulfill({ response });
      readsServed++;
    });

    let conversationId = '';
    let streamBaseline = 0;
    let bodySucceeded = false;

    try {
      await test.step('first turn streams with its funding read still parked', async () => {
        await chatPage.goto();
        // Pin the stream at its first chunk so the queue below is gated on a
        // deterministically in-flight run. Released further down.
        await chatPage.holdPrimaryStreamForNextSends();
        await chatPage.sendNewChatMessage(messageA);
        conversationId = await chatPage.waitForConversation();
        await chatPage.waitForStreamingActive();
        streamBaseline = await chatPage.captureStreamBaseline();
        // An issued-but-unanswered read IS the loading state: no snapshot exists
        // for this conversation, so nothing has graded the payer's funds yet.
        await expect.poll(() => readsParked).toBeGreaterThan(0);
        expect(readsServed).toBe(0);
      });

      await test.step('the queue accepts a message while the balance loads', async () => {
        await chatPage.messageInput.fill(messageB);
        // While a run streams, the send control IS the queue control, so its
        // enabled state is the queue gate itself. A balance still being read is
        // an absent answer, not a refusal, and must not close the queue.
        await expect(chatPage.sendButton).toBeEnabled();
        await chatPage.enqueueWhileStreaming(messageB);
        await expect(chatPage.queuedPill(0)).toBeVisible();
        await chatPage.expectMessageAbsent(messageB);
      });

      await test.step('balance resolves, then the queued message drains and streams', async () => {
        releaseFunding();
        await expect.poll(() => readsServed).toBeGreaterThan(0);
        // Clear the hold BEFORE releasing, as above: the drained send must
        // stream to completion on its own.
        await chatPage.stopHoldingStreams();
        await chatPage.releaseHeldStream(conversationId);
        await expect(chatPage.queuedRegion()).not.toBeVisible({
          timeout: TIMEOUTS.STREAM_SATURATED,
        });
        await chatPage.waitForStreamCyclesCompleted(streamBaseline, 2);
        await chatPage.assertMessageVisible(messageB);
      });

      await test.step('both turns persisted', async () => {
        // This conversation is created by the test, so its whole history is the
        // first turn plus the drained one: 2 users + 2 assistants.
        expect(await chatPage.getMessageCountViaAPI()).toBe(4);
      });
      bodySucceeded = true;
    } finally {
      // A failure anywhere above leaves the barrier unresolved and the run
      // parked; both releases are no-ops once they have already happened.
      releaseFunding();
      await chatPage.stopHoldingStreams();
      if (conversationId !== '') {
        await releaseParkedRun(chatPage, conversationId, bodySucceeded);
      }
    }
  });
});
