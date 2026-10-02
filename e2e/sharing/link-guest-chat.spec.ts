import { TEST_IDS, UPGRADE_TICKET_PARAM } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper, getFundingSnapshot } from '../helpers/budget.js';
import {
  expectBalanceDelta,
  expectHoldCovers,
  mockTextTurnCharge,
  readHold,
  readMockChargeBasis,
  readMoneyState,
  spendOf,
} from '../helpers/exact-money.js';
import { setupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { createWriteLinkWithBudget } from '../helpers/invite-link.js';
import { expectSharedConversationLoaded } from '../helpers/link-assertions.js';
import { guestIp } from '../helpers/guest-identity.js';
import { pinTextTurnShape } from '../helpers/text-turn-shape.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The funding test below. What it proves is that a reservation Redis placed
 * against the owner's wallet moves the owner's own served spendable by the same
 * integer — numbers the server computes and the spec reads back over the API,
 * with no rendered value anywhere in the assertion. The guest composer send it
 * rides on is proven across every engine by this file's other test.
 */
const GUEST_FUNDING_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    "The assertion is integer arithmetic over the owner's served funding snapshot, read through the API and never off the page; the guest send it rides on is engine-proven by this file's other test.",
});

test.describe('Link Guest Chat', SPEC_MATRIX, () => {
  test('write-privileged guest can send messages and get AI responses', async ({
    authenticatedPage,
    unauthenticatedPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    await unauthenticatedPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

    const chatPage = new ChatPage(authenticatedPage);
    const helper = new BudgetHelper(authenticatedRequest);

    let inviteUrl: string;

    await test.step('create write-privileged invite link and setup budgets', async () => {
      await chatPage.gotoConversation(groupConversation.id);
      await chatPage.waitForConversationLoaded();

      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const result = await createWriteLinkWithBudget(authenticatedPage, sidebar, {
        helper,
        conversationId: groupConversation.id,
        withHistory: true,
        closeMethod: 'escape',
        displayName: 'Chat Guest',
      });
      inviteUrl = result.url;
      expect(inviteUrl).toContain('/share/c/');
      expect(inviteUrl).toContain('#');
    });

    const initialBalance = await helper.getBalance();

    // Every guest socket passes straight through to the server. The reconnect
    // step arms the route so that the next upgrade after its sever is recorded
    // as the reconnect. Matched by RegExp, never by a relative pattern: a
    // relative string is resolved against the context's baseURL, which is the
    // preview server rather than the API the socket dials.
    let severGuestSocket: (() => Promise<void>) | undefined;
    let establishedTicket: string | null = null;
    let reconnectArmed = false;
    let reconnectTicket: string | null = null;
    await unauthenticatedPage.routeWebSocket(
      new RegExp(`/conversations/${groupConversation.id}/websocket`, 'u'),
      (socket) => {
        const ticket = new URL(socket.url()).searchParams.get(UPGRADE_TICKET_PARAM);
        if (reconnectArmed) {
          reconnectArmed = false;
          reconnectTicket = ticket;
        } else {
          establishedTicket = ticket;
          severGuestSocket = () => socket.close();
        }
        socket.connectToServer();
      }
    );

    await test.step('guest opens shared conversation and sees messages', async () => {
      await unauthenticatedPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expectSharedConversationLoaded(unauthenticatedPage);

      // Existing seeded messages should be visible (helper auto-scrolls if virtualised)
      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.assertMessageVisible('Hello from Alice');
    });

    await test.step('guest does not see the premium payment prompt', async () => {
      await expect(unauthenticatedPage.getByText('Add credit')).not.toBeVisible();
      await expect(unauthenticatedPage.getByText('to unlock')).not.toBeVisible();
    });

    await test.step('guest sends message and receives AI response', async () => {
      const guestChatPage = new ChatPage(unauthenticatedPage);
      const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await expect(guestInput).toBeVisible({ timeout: TIMEOUTS.MODAL });

      // Fill message first — send button requires text content to become enabled
      const guestMessage = `Guest says hello ${String(Date.now())}`;
      const spentBeforeFirst = await helper.getTotalSpent(groupConversation.id);
      await guestInput.fill(guestMessage);

      const sendButton = unauthenticatedPage.getByTestId(TEST_IDS.sendButton);
      await expect(sendButton).toBeEnabled({ timeout: TIMEOUTS.CONVERSATION_LOAD });
      await sendButton.click();

      await guestChatPage.assertMessageVisible(guestMessage);
      // Assert THIS turn's own echo, not a pre-existing "Echo:" from the seeded
      // history — otherwise a BALANCE_RESERVED error tile would satisfy the step.
      await guestChatPage.waitForAIResponse(guestMessage);

      // The owner-funded worst-case reservation is released in the post-stream
      // `finally` (stream-pipeline), AFTER the SSE `done` the client acted on.
      // Wait for this turn's spend to land before sending the next message: the
      // spend persists one step before the reservation release in that same
      // `finally`, so by the time this poll's round-trip observes it the release
      // has run — and two overlapping worst-case reservations can't trip the
      // cushion guard (402 BALANCE_RESERVED) against the modest budget.
      await expect
        .poll(() => helper.getTotalSpent(groupConversation.id), { timeout: TIMEOUTS.ASSERT })
        .toBeGreaterThan(spentBeforeFirst);
    });

    await test.step('guest selects a model and sends another message', async () => {
      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.selectNonPremiumModel();

      const modelMessage = `Guest model test ${String(Date.now())}`;
      const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
      await guestInput.fill(modelMessage);

      const sendButton = unauthenticatedPage.getByTestId(TEST_IDS.sendButton);
      await expect(sendButton).toBeEnabled({ timeout: TIMEOUTS.MODAL });
      await sendButton.click();

      await guestChatPage.assertMessageVisible(modelMessage);

      // Assert THIS turn's own echo (scoped to assistant role) so a
      // BALANCE_RESERVED error tile can't pass as a response.
      await guestChatPage.waitForAIResponse(modelMessage);
      // Sanity: React state knows about all 4 assistant messages
      await expect(guestChatPage.messageList).toHaveAttribute('data-assistant-count', '4', {
        timeout: TIMEOUTS.ASSERT,
      });
      // New nametag helper scrolls through every assistant message, so this
      // works even when Virtuoso virtualises earlier seeded messages.
      await guestChatPage.expectAllAIMessagesHaveNametag();
    });

    await test.step('owner balance decreased (owner-funded billing)', async () => {
      await expect
        .poll(
          async () => {
            const finalBalance = await helper.getBalance();
            return Number.parseFloat(finalBalance.balance);
          },
          { timeout: TIMEOUTS.ASSERT, intervals: [500, 1000, 2000] }
        )
        .toBeLessThan(Number.parseFloat(initialBalance.balance));
    });

    await test.step('a severed guest socket reconnects on a fresh ticket and delivery resumes', async () => {
      const guestChatPage = new ChatPage(unauthenticatedPage);
      await guestChatPage.waitForWebSocketReady();
      expect(severGuestSocket, 'the guest socket was never routed').toBeDefined();
      expect(establishedTicket, "the guest's upgrade carried no ticket").not.toBeNull();

      reconnectArmed = true;
      await severGuestSocket?.();

      // The client's own reconnect reaching the route is the app saying it
      // observed the drop. A ticket opens one socket, so the reconnect must
      // carry one minted for this attempt rather than the ticket it opened on.
      await expect
        .poll(() => reconnectTicket, {
          timeout: TIMEOUTS.WS_HANDSHAKE,
          message: 'the guest never reconnected after its socket was severed',
        })
        .not.toBeNull();
      expect(reconnectTicket, 'the reconnect re-presented a spent ticket').not.toBe(
        establishedTicket
      );

      await guestChatPage.waitForWebSocketConnected();
      await guestChatPage.waitForWebSocketReady();

      // The guest page refetches the conversation on no timer and no focus, so
      // the owner's turn can reach it only through the reconnected socket: as
      // live run frames, or as the catch-up refetch that socket's `ready` triggers.
      const ownerMessage = `Owner writes after the guest reconnects ${String(Date.now())}`;
      await new MemberSidebarPage(authenticatedPage).closeMobileSidebarIfOpen();
      await chatPage.sendFollowUpMessage(ownerMessage);

      await guestChatPage.assertMessageVisible(ownerMessage);
      await guestChatPage.waitForAIResponse(ownerMessage);
    });
  });

  /**
   * A link guest holds no wallet, so admission places its run's hold on the
   * CONVERSATION OWNER's purchased wallet. The owner reads their own funding
   * snapshot with no conversation named, which is the self arm over that same
   * wallet-holds hash — so the guest's live run is visible as the owner's own
   * money going unavailable, in an amount nothing in the UI reports.
   *
   * Nothing here reads a notice: the composer's money gate and a refused run
   * render the same sentence, so only the served integers can tell a reservation
   * apart from a refusal.
   */
  test(
    "a guest's live run reserves the owner's funds",
    GUEST_FUNDING_MATRIX,
    async ({ authenticatedPage, unauthenticatedPage, authenticatedRequest, groupConversation }) => {
      test.slow();
      await unauthenticatedPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });

      const guestChatPage = new ChatPage(unauthenticatedPage);
      const helper = new BudgetHelper(authenticatedRequest);
      const prompt = `Guest reserves owner funds ${String(Date.now())}`;

      const { chatPage: ownerChatPage, sidebar } = await setupConversationWithSidebar(
        authenticatedPage,
        groupConversation.id
      );

      let inviteUrl = '';
      let bodySucceeded = false;

      await test.step('owner publishes a write-privileged link', async () => {
        const result = await createWriteLinkWithBudget(authenticatedPage, sidebar, {
          helper,
          conversationId: groupConversation.id,
          withHistory: true,
          closeMethod: 'escape',
          displayName: 'Funding Guest',
        });
        inviteUrl = result.url;
      });

      const basis = await readMockChargeBasis(authenticatedRequest);
      const ownerMoneyBefore = await readMoneyState(authenticatedRequest);

      try {
        await test.step('guest opens the link with its turn shape pinned', async () => {
          await unauthenticatedPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
          await expectSharedConversationLoaded(unauthenticatedPage);

          // The derivation below prices one generation and the characters this
          // turn persists, so the send has to be one unrouted, reasoning-free
          // generation.
          await pinTextTurnShape(guestChatPage);

          // The hold directive has to be set together with the guest address:
          // setExtraHTTPHeaders REPLACES the header set rather than merging into
          // it, and dropping the address would put this guest's traffic back on
          // the suite-wide caller identity every other project shares.
          await unauthenticatedPage.setExtraHTTPHeaders({
            'cf-connecting-ip': guestIp(),
            'x-mock-hold-primary-stream': 'true',
          });
        });

        // Read last thing before the send. The spendable figure is priced off a
        // 30-second wallet snapshot, so the two reads it is compared across are
        // kept as close together as the send allows.
        const ownerFundingBefore = await getFundingSnapshot(authenticatedRequest);

        await test.step('guest parks a run mid-stream', async () => {
          const guestInput = unauthenticatedPage.getByRole('textbox', { name: /message/i });
          await expect(guestInput).toBeVisible({ timeout: TIMEOUTS.MODAL });
          await guestInput.fill(prompt);

          const sendButton = unauthenticatedPage.getByTestId(TEST_IDS.sendButton);
          await expect(sendButton).toBeEnabled({ timeout: TIMEOUTS.CONVERSATION_LOAD });
          await sendButton.click();

          // The mock emits its first chunk and then parks, so the run is held in
          // flight by the server until it is released — the reads below observe a
          // live hold rather than racing settlement, which deletes it.
          await guestChatPage.waitForStreamingActive();
        });

        // Captured while the run is live; settlement releases the hold, so after
        // the turn completes there is nothing left to read.
        const hold = await readHold(authenticatedRequest, groupConversation.id);

        await test.step("the owner's own funds carry the guest's reservation", async () => {
          const ownerFundingLive = await getFundingSnapshot(authenticatedRequest);

          expect(
            ownerFundingLive.payer,
            "these are the owner's own wallet figures, not a group headroom"
          ).toBe('self');
          expect(
            ownerFundingLive.heldNanoUsd,
            "the guest's run must place a reservation on the owner's wallet"
          ).toBeGreaterThan(ownerFundingBefore.heldNanoUsd);
          expect(
            ownerFundingLive.spendableNanoUsd,
            "the owner's spendable falls by exactly what the guest's run reserved"
          ).toBe(
            ownerFundingBefore.spendableNanoUsd -
              (ownerFundingLive.heldNanoUsd - ownerFundingBefore.heldNanoUsd)
          );
        });

        await test.step("releasing the run charges the owner for the guest's turn", async () => {
          await unauthenticatedPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
          await ownerChatPage.releaseHeldStream(groupConversation.id);
          await guestChatPage.waitForAIResponse(prompt);

          await expectHoldCovers(authenticatedRequest, groupConversation.id, hold);
          await expectBalanceDelta(authenticatedRequest, ownerMoneyBefore, {
            purchased: spendOf(mockTextTurnCharge(basis, { prompt, answers: 1 })),
          });

          await expect
            .poll(
              async () => {
                const settled = await getFundingSnapshot(authenticatedRequest);
                return settled.heldNanoUsd;
              },
              {
                timeout: TIMEOUTS.STREAM_SATURATED,
                message: "settling the guest's run returns the reserved funds to the owner",
              }
            )
            .toBe(ownerFundingBefore.heldNanoUsd);
        });

        bodySucceeded = true;
      } finally {
        // A parked stream outlives a failed assertion and keeps the owner's funds
        // reserved until the hold TTL expires; releasing is a no-op when nothing
        // is held.
        await unauthenticatedPage.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
        if (bodySucceeded) {
          await ownerChatPage.releaseHeldStream(groupConversation.id);
        } else {
          // eslint-disable-next-line comments/resolvable-cross-reference -- the E2E harness writes its run report there and git ignores it, so the citation is correct and resolves only after a run
          // Raising a release error here would put the cleanup symptom in `e2e/report/`
          // where the diagnosis belongs, because a throw out of cleanup REPLACES the
          // failure being unwound. Attached instead of raised on the failure path,
          // and never dropped: a run left parked keeps the owner's funds reserved
          // until the hold's TTL.
          await ownerChatPage
            .releaseHeldStream(groupConversation.id)
            .catch(async (releaseError: unknown) => {
              await test.info().attach('held-stream-release-failed', {
                body: releaseError instanceof Error ? releaseError.message : 'non-Error thrown',
                contentType: 'text/plain',
              });
            });
        }
      }
    }
  );
});
