import { noticeText, TEST_ID_BUILDERS } from '@hushbox/shared';
import { test as base, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages/index.js';
import {
  getFundingSnapshot,
  getPurchasedBalanceNanoUsd,
  nanoUsdWireToDollars,
  setWalletBalance,
} from '../helpers/budget.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { personaEmail } from '../helpers/personas.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { HOLD_PROBE_MODEL_ID } from '../../scripts/lib/playwright/model-ids.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The blocked send and the unchanged option sets are both graded on spendable plus held, and the scarcity is measured from the admission hold — arithmetic over numbers the server computed, which no renderer changes.',
});

/**
 * The pooled Alice's purchased balance, restored on teardown. This spec has to
 * pin her into scarcity, and her seeded balance is a documented precondition of
 * the group and billing suites, so the restore rides fixture teardown: Playwright
 * runs teardown even when a test TIMES OUT, where an in-body `finally` is skipped
 * and its API calls would be rejected anyway. A leaked sub-dollar balance would
 * fail the next owner-funded test in this worker as though owner funding itself
 * were broken.
 */
const test = base.extend<{ restorablePurchasedBalanceNanoUsd: bigint }>({
  restorablePurchasedBalanceNanoUsd: async ({ authenticatedRequest }, use) => {
    const starting = await getPurchasedBalanceNanoUsd(authenticatedRequest);
    await use(starting);
    await setWalletBalance(
      authenticatedRequest,
      personaEmail('test-alice'),
      'purchased',
      nanoUsdWireToDollars(starting.toString())
    );
  },
});

/**
 * A hold blocks the send and never greys the options (BILLING §Notices 9).
 *
 * The scarcity is MEASURED, never guessed: the same turn shape is sent once to
 * learn what admission holds for it, and the payer's balance is then pinned
 * BELOW that hold. Below is the robust side, and the reason is that the ceiling
 * is money-solved rather than fixed: once money is the binding bound, the priced
 * turn spends the whole funding (`budgetBuysTokens` floor-divides it), so the
 * hold leaves behind less than one output token's worth. The next turn's ceiling
 * is then zero, which cannot contain the minimum answer the send gate demands —
 * `B + MINIMUM_OUTPUT_TOKENS` inside the ceiling.
 *
 * The window's top is therefore one hold plus one minimum answer, not one and a
 * half holds: leave half a hold of headroom and it still buys tens of thousands
 * of tokens, so the gate correctly allows the send and the blocked state is
 * simply unreachable.
 *
 * The same pin leaves the second turn hold-blind affordable — the picker and the
 * effort menu grade on `spendable + held`, which a hold cannot move — so the
 * option sets must come back identical.
 *
 * The cushion is derived from two served figures rather than recomputed here:
 * `spendable + held` is hold-blind by contract, so subtracting the ledger-truth
 * balance leaves whatever the cushion currently is.
 */
test.describe('Hold-Blocked Send', SPEC_MATRIX, () => {
  test('a run holding the payer funds blocks a send in another conversation, options unchanged', async ({
    authenticatedPage,
    authenticatedRequest,
    testConversation,
    restorablePurchasedBalanceNanoUsd: startingBalanceNanoUsd,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);
    const stamp = String(Date.now());

    const createResponse = await idempotentPost(authenticatedRequest, '/dev/conversation', {
      data: {
        ownerEmail: personaEmail('test-alice'),
        messages: [
          { content: `Second conversation ${stamp}`, senderType: 'user' },
          { content: `Echo: Second conversation ${stamp}`, senderType: 'ai' },
        ],
      },
    });
    await expectOkResponse(createResponse, 'dev conversation seed');
    const { conversationId: otherConversationId } = (await createResponse.json()) as {
      conversationId: string;
    };

    try {
      const resting = await getFundingSnapshot(authenticatedRequest, testConversation.id);
      const cushionNanoUsd =
        resting.spendableNanoUsd + resting.heldNanoUsd - startingBalanceNanoUsd;

      let holdNanoUsd = 0n;

      await test.step('learn what admission holds for this turn shape', async () => {
        await chatPage.gotoConversation(testConversation.id);
        await chatPage.waitForConversationLoaded();
        await chatPage.selectSingleModel(HOLD_PROBE_MODEL_ID);

        // This turn's model reasons at whatever level `auto` resolves to, so
        // the mock parks the stream on its reasoning trace, ahead of any answer
        // delta — the hold is observably live rather than raced against
        // settlement.
        await chatPage.holdPrimaryStreamForNextSends();
        const streamBaseline = await chatPage.captureStreamBaseline();
        await chatPage.sendFollowUpMessage(`Hold probe ${stamp}`);
        await chatPage.waitForStreamingActive();

        const probe = await getFundingSnapshot(authenticatedRequest, testConversation.id);
        expect(probe.heldNanoUsd).toBeGreaterThan(0n);
        holdNanoUsd = probe.heldNanoUsd;

        await chatPage.stopHoldingStreams();
        await chatPage.releaseHeldStream(testConversation.id);
        await chatPage.waitForStreamCycle(streamBaseline);
      });

      await test.step('pin the balance below one of those turns', async () => {
        const targetSpendableNanoUsd = holdNanoUsd / 2n;
        const targetBalanceNanoUsd = targetSpendableNanoUsd - cushionNanoUsd;
        expect(
          targetBalanceNanoUsd,
          'half a turn must cost more than the cushion, or the pin cannot land below the hold'
        ).toBeGreaterThan(0n);

        await setWalletBalance(
          authenticatedRequest,
          personaEmail('test-alice'),
          'purchased',
          nanoUsdWireToDollars(targetBalanceNanoUsd.toString())
        );

        // Strictly below the measured hold is what makes the blocked state
        // reachable at all: from here money is the binding bound, so the run's
        // own hold spends the whole spendable and leaves the next turn nothing.
        const pinned = await getFundingSnapshot(authenticatedRequest, otherConversationId);
        expect(pinned.spendableNanoUsd).toBeLessThan(holdNanoUsd);
        expect(pinned.spendableNanoUsd).toBeGreaterThan(0n);
      });

      let greyedRowsBefore: string[] = [];
      let greyedLevelsBefore: string[] = [];

      await test.step('with nothing held, the second conversation sends normally', async () => {
        // A reload, not a client-side navigation: the pinned balance has to
        // reach the composer's own funding read for this baseline to describe
        // the pinned wallet rather than the seeded one.
        await chatPage.gotoConversation(otherConversationId);
        await authenticatedPage.reload();
        await chatPage.waitForConversationLoaded();

        await chatPage.messageInput.fill(`Baseline draft ${stamp}`);
        await expect(chatPage.sendButton).toBeEnabled();
        await expect(
          authenticatedPage.getByTestId(TEST_ID_BUILDERS.budgetMessage('funds_held_by_run'))
        ).not.toBeVisible();

        greyedRowsBefore = await chatPage.greyedModelRowIds();
        greyedLevelsBefore = await chatPage.greyedEffortLevels();
      });

      await test.step('start a run in the first conversation and leave it holding', async () => {
        await chatPage.gotoConversation(testConversation.id);
        await chatPage.waitForConversationLoaded();
        await chatPage.holdPrimaryStreamForNextSends();
        await chatPage.sendFollowUpMessage(`Hold live ${stamp}`);
        await chatPage.waitForStreamingActive();

        const live = await getFundingSnapshot(authenticatedRequest, testConversation.id);
        expect(live.heldNanoUsd).toBeGreaterThan(0n);
      });

      await test.step('the second conversation refuses the send, transiently', async () => {
        await chatPage.gotoConversation(otherConversationId);
        await authenticatedPage.reload();
        await chatPage.waitForConversationLoaded();
        await chatPage.messageInput.fill(`Blocked draft ${stamp}`);

        const notice = authenticatedPage.getByTestId(
          TEST_ID_BUILDERS.budgetMessage('funds_held_by_run')
        );
        await expect(notice).toBeVisible({ timeout: TIMEOUTS.ASSERT });
        // The rendered sentence comes from the vocabulary, so the assertion
        // cannot drift from the copy the app derives.
        await expect(notice).toContainText(noticeText('funds_held_by_run'));
        await expect(chatPage.sendButton).toBeDisabled();
      });

      await test.step('the hold greys nothing: rows and effort levels are as before', async () => {
        expect(await chatPage.greyedModelRowIds()).toEqual(greyedRowsBefore);
        expect(await chatPage.greyedEffortLevels()).toEqual(greyedLevelsBefore);
      });

      await test.step('releasing the run returns the reserved funds', async () => {
        await chatPage.stopHoldingStreams();
        await chatPage.releaseHeldStream(testConversation.id);
        await expect
          .poll(
            async () => {
              const snapshot = await getFundingSnapshot(authenticatedRequest, testConversation.id);
              return snapshot.heldNanoUsd;
            },
            { timeout: TIMEOUTS.STREAM_SATURATED }
          )
          .toBe(0n);
      });
    } finally {
      // Releasing the parked stream early returns the reservation; the balance
      // itself is restored by fixture teardown, which a test timeout cannot skip.
      await chatPage.stopHoldingStreams();
      await chatPage.releaseHeldStream(testConversation.id);
    }
  });
});
