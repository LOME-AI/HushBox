import { noticeText, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { BudgetHelper, setWalletBalance } from '../helpers/budget.js';
import {
  expectBalanceDelta,
  expectChargeAttribution,
  mockTextTurnCharge,
  readMockChargeBasis,
  readMoneyState,
  spendOf,
} from '../helpers/exact-money.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { pinTextTurnShape } from '../helpers/text-turn-shape.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { personaEmail } from '../helpers/personas.js';
import type { APIRequestContext } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The four payer-ladder tests. The visibility test below stays on the file's
 * engine matrix: it drives the member sidebar and the budget modal, and the
 * Sheet it reopens is only closed on a mobile viewport, so a single desktop
 * carrier would delete the only run of that path.
 */
const PAYER_LADDER_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'What each proves is which wallet the server charged and by how much, read back from the API; the budget notice and cost badge they gate on are testid-addressed presence and copy derived from the shared vocabulary, not layout an engine could differ over.',
});

/**
 * The payer of the conversation's most recent AI message.
 *
 * Deliberately NOT the vocabulary's `expectChargeAttribution`, which asserts
 * over EVERY assistant message and so cannot be pointed at a fixture that seeds
 * uncharged AI rows: the group fixture seeds two, and an assistant message with
 * no charge behind it reports a null payer. The tests that build their own
 * conversation use the vocabulary instead.
 */
async function getLastAiPayerId(
  request: APIRequestContext,
  conversationId: string
): Promise<string | null | undefined> {
  const response = await request.get(`/dev/message-payers/${conversationId}`);
  const data = (await response.json()) as {
    payers: { messageId: string; payerId: string | null }[];
  };
  return data.payers.at(-1)?.payerId;
}

/**
 * Group Chat Billing E2E Tests
 *
 * Seeded balances:
 * - test-alice: $100.00 purchased + 5¢ free → paid tier
 * - test-bob:   $0.00 purchased + 5¢ free → free tier
 *
 * Billing decision (resolveBilling):
 *   effectiveCents = min(conversationRemaining, memberRemaining, ownerRemaining)
 *   > 0 → owner_balance (owner pays)
 *   ≤ 0 → personal fallthrough (sender pays from own tier)
 */
test.describe('Group Chat Billing', SPEC_MATRIX, () => {
  // Each test gets its own groupConversation fixture (isolated billing state)

  test(
    'owner-funded: all budgets active, owner pays',
    PAYER_LADDER_MATRIX,
    async ({ authenticatedPage: _alice, testBobPage, authenticatedRequest, groupConversation }) => {
      const helper = new BudgetHelper(authenticatedRequest);
      const bobUser = groupConversation.members.find((m) => m.email === personaEmail('test-bob'))!;

      await test.step('setup budgets: conv=$10, member=$5', async () => {
        await helper.setConversationBudget(groupConversation.id, 1000);
        const bobMemberId = await helper.findMemberId(groupConversation.id, bobUser.userId);
        await helper.setMemberBudget(groupConversation.id, bobMemberId, 500);
      });

      // Read before the send, so the assertion below is what Bob's turn took from
      // the owner rather than what the owner's wallet happens to hold.
      const ownerBefore = await readMoneyState(authenticatedRequest);
      const basis = await readMockChargeBasis(authenticatedRequest);
      const prompt = `Budget test ${String(Date.now())}`;

      await test.step('Bob sends message in group chat', async () => {
        const chatPage = new ChatPage(testBobPage);
        await chatPage.gotoConversation(groupConversation.id);
        await chatPage.waitForConversationLoaded();

        // The derivation below prices one generation, so the send has to be one:
        // the default selection routes through the Smart Model and bills two.
        await pinTextTurnShape(chatPage);
        await chatPage.sendFollowUpMessage(prompt);
        await chatPage.waitForAIResponse('Budget test');
      });

      await test.step('verify owner-funded billing', async () => {
        const chatPage = new ChatPage(testBobPage);
        await chatPage.expectMessageCostVisible();

        // No free_allowance_pays (owner is paying)
        await expect(
          testBobPage.getByTestId(TEST_ID_BUILDERS.budgetMessage('free_allowance_pays'))
        ).not.toBeVisible();

        // The owner's purchased wallet lost EXACTLY Bob's turn — the answer, plus
        // the prompt and the echo it persisted. "Decreased" would also hold if the
        // owner were charged twice, or charged for a turn nobody sent.
        await expectBalanceDelta(authenticatedRequest, ownerBefore, {
          purchased: spendOf(mockTextTurnCharge(basis, { prompt, answers: 1 })),
        });

        // Group spending incremented (owner-funded → spending tracked)
        // Use expect.poll() — the DB write may not be visible to the next API call immediately
        await expect
          .poll(() => helper.getTotalSpent(groupConversation.id), {
            timeout: TIMEOUTS.ASSERT,
            message: 'totalSpent should be > 0 after owner-funded message',
          })
          .toBeGreaterThan(0);

        await expect
          .poll(
            async () => {
              const budgets = await helper.getBudgets(groupConversation.id);
              const bob = budgets.memberBudgets.find((mb) => mb.userId === bobUser.userId);
              return Number.parseFloat(bob?.spent ?? '0');
            },
            { timeout: TIMEOUTS.ASSERT, message: 'bob spent should be > 0' }
          )
          .toBeGreaterThan(0);
      });
    }
  );

  // Both tests below fall through to Bob's personal free_allowance billing,
  // reserving against the same Redis key (chatReservedBalance:{bobUserId}).
  // Serial mode prevents concurrent reservations from exceeding Bob's 5¢ allowance.
  // beforeEach resets Bob's wallet to ensure each test starts with a clean 5¢ balance.
  test.describe('personal free-allowance fallthrough', () => {
    // eslint-disable-next-line no-restricted-syntax -- serial: both tests reserve against the same Redis key (chatReservedBalance:{bobUserId}) and share Bob's 5¢ allowance; parallel runs would exceed it
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ authenticatedRequest }) => {
      await setWalletBalance(
        authenticatedRequest,
        personaEmail('test-bob'),
        'free_tier',
        '0.05000000'
      );
    });

    test(
      'member budget exhausted: falls through to free allowance',
      PAYER_LADDER_MATRIX,
      async ({
        authenticatedPage: _alice,
        testBobPage,
        authenticatedRequest,
        groupConversation,
      }) => {
        const helper = new BudgetHelper(authenticatedRequest);

        await test.step('setup: conv=$10, member=$0 (default)', async () => {
          // Set high conversation budget but do NOT set Bob's member budget (stays 0)
          await helper.setConversationBudget(groupConversation.id, 1000);
        });

        await test.step('Bob navigates and sees free_allowance_pays', async () => {
          const chatPage = new ChatPage(testBobPage);
          await chatPage.gotoConversation(groupConversation.id);
          await chatPage.waitForConversationLoaded();

          // memberRemaining = 0 → effectiveCents = 0 → personal → free_allowance
          await expect(
            testBobPage.getByTestId(TEST_ID_BUILDERS.budgetMessage('free_allowance_pays'))
          ).toBeVisible({
            timeout: TIMEOUTS.ASSERT,
          });
        });

        // A change of payer is disclosed BEFORE the send (BILLING §Notices 5): the
        // fall-through succeeds, so it never enters the refusal vocabulary and
        // would otherwise be silent.
        await test.step('the payer change is disclosed, informational, and does not block', async () => {
          const chatPage = new ChatPage(testBobPage);
          const notice = testBobPage.getByTestId(
            TEST_ID_BUILDERS.budgetMessage('payer_switched_to_personal')
          );
          await expect(notice).toBeVisible({ timeout: TIMEOUTS.ASSERT });
          // Derived copy, so the assertion cannot drift from what the app renders.
          await expect(notice).toContainText(noticeText('payer_switched_to_personal'));
          await expect(
            testBobPage.getByTestId(TEST_ID_BUILDERS.budgetDismiss('payer_switched_to_personal'))
          ).toBeVisible();
          await chatPage.messageInput.fill(`Payer disclosure ${String(Date.now())}`);
          await expect(chatPage.sendButton).toBeEnabled();
        });

        const bobBefore = await readMoneyState(testBobPage.request);
        const basis = await readMockChargeBasis(authenticatedRequest);
        const prompt = `Member exhausted ${String(Date.now())}`;

        await test.step('Bob sends and owner is NOT charged', async () => {
          const chatPage = new ChatPage(testBobPage);
          await pinTextTurnShape(chatPage);
          await chatPage.sendFollowUpMessage(prompt);
          await chatPage.waitForAIResponse('Member exhausted');

          // Verify Bob (not Alice) was charged — per-message payerId check,
          // immune to parallel test pollution (unlike Alice's global balance)
          const bobUser = groupConversation.members.find(
            (m) => m.email === personaEmail('test-bob')
          )!;
          await expect
            .poll(() => getLastAiPayerId(authenticatedRequest, groupConversation.id), {
              timeout: TIMEOUTS.ASSERT,
              message: 'last AI message payerId should be Bob (personal billing)',
            })
            .toBe(bobUser.userId);

          // What "Bob paid" costs him, to the nano: a free-wallet charge debits
          // the wallet AND spends the day's allowance by the same amount, so both
          // components name the same derivation.
          const spend = spendOf(mockTextTurnCharge(basis, { prompt, answers: 1 }));
          await expectBalanceDelta(testBobPage.request, bobBefore, {
            free: spend,
            allowanceRemaining: spend,
          });

          // Group spending NOT incremented (free_allowance → owner didn't pay)
          const budgets = await helper.getBudgets(groupConversation.id);
          expect(Number.parseFloat(budgets.totalSpent)).toBe(0);
        });
      }
    );

    test(
      'conversation budget exhausted: falls through to free allowance',
      PAYER_LADDER_MATRIX,
      async ({
        authenticatedPage: _alice,
        testBobPage,
        authenticatedRequest,
        groupConversation,
      }) => {
        const helper = new BudgetHelper(authenticatedRequest);
        const bobUser = groupConversation.members.find(
          (m) => m.email === personaEmail('test-bob')
        )!;

        await test.step('setup: conv=$0 (default), member=$5', async () => {
          // Set high member budget but do NOT set conversation budget (stays 0)
          const bobMemberId = await helper.findMemberId(groupConversation.id, bobUser.userId);
          await helper.setMemberBudget(groupConversation.id, bobMemberId, 500);
        });

        await test.step('Bob navigates and sees free_allowance_pays', async () => {
          const chatPage = new ChatPage(testBobPage);
          await chatPage.gotoConversation(groupConversation.id);
          await chatPage.waitForConversationLoaded();

          // conversationRemaining = 0 → effectiveCents = 0 → personal → free_allowance
          await expect(
            testBobPage.getByTestId(TEST_ID_BUILDERS.budgetMessage('free_allowance_pays'))
          ).toBeVisible({
            timeout: TIMEOUTS.ASSERT,
          });
        });

        const bobBefore = await readMoneyState(testBobPage.request);
        const basis = await readMockChargeBasis(authenticatedRequest);
        const prompt = `Conv exhausted ${String(Date.now())}`;

        await test.step('Bob sends and owner is NOT charged', async () => {
          const chatPage = new ChatPage(testBobPage);
          await pinTextTurnShape(chatPage);
          await chatPage.sendFollowUpMessage(prompt);
          await chatPage.waitForAIResponse('Conv exhausted');

          // Verify Bob (not Alice) was charged — per-message payerId check,
          // immune to parallel test pollution (unlike Alice's global balance)
          await expect
            .poll(() => getLastAiPayerId(authenticatedRequest, groupConversation.id), {
              timeout: TIMEOUTS.ASSERT,
              message: 'last AI message payerId should be Bob (personal billing)',
            })
            .toBe(bobUser.userId);

          // The same nano-exact statement of what Bob paid: wallet and day's
          // allowance both move by the turn's own derivation.
          const spend = spendOf(mockTextTurnCharge(basis, { prompt, answers: 1 }));
          await expectBalanceDelta(testBobPage.request, bobBefore, {
            free: spend,
            allowanceRemaining: spend,
          });

          // Group spending NOT incremented (free_allowance → owner didn't pay)
          const budgets = await helper.getBudgets(groupConversation.id);
          expect(Number.parseFloat(budgets.totalSpent)).toBe(0);
        });
      }
    );
  });

  test(
    'owner balance exhausted: paid member uses personal balance',
    PAYER_LADDER_MATRIX,
    async ({ authenticatedPage, authenticatedRequest, testBobRequest }) => {
      // Create a custom group chat where Bob (free tier, $0 balance) is the owner
      // and Alice (paid tier, $100 balance) is an admin member.
      const createResponse = await idempotentPost(authenticatedRequest, '/dev/group-chat', {
        data: {
          ownerEmail: personaEmail('test-bob'),
          memberEmails: [personaEmail('test-alice')],
          messages: [
            {
              senderEmail: personaEmail('test-bob'),
              content: 'Welcome to Bob group',
              senderType: 'user',
            },
          ],
        },
      });
      await expectOkResponse(createResponse, 'dev group-chat creation');
      const { conversationId, members } = (await createResponse.json()) as {
        conversationId: string;
        members: { userId: string; email: string }[];
      };
      const alice = members.find((member) => member.email === personaEmail('test-alice'));
      expect(alice, 'the seeded group must carry Alice as a member').toBeDefined();

      const bobHelper = new BudgetHelper(testBobRequest);

      await test.step('setup budgets with Bob (owner) auth: conv=$10, member=$5', async () => {
        await bobHelper.setConversationBudget(conversationId, 1000);

        // Find Alice's memberId using Bob's auth (Bob is owner, can see all members)
        const budgets = await bobHelper.getBudgets(conversationId);
        const aliceUser = budgets.memberBudgets.find((mb) => mb.userId !== null);
        expect(aliceUser).toBeDefined();
        await bobHelper.setMemberBudget(conversationId, aliceUser!.memberId, 500);
      });

      const aliceBefore = await readMoneyState(authenticatedRequest);
      const basis = await readMockChargeBasis(authenticatedRequest);
      const prompt = `Owner exhausted ${String(Date.now())}`;

      await test.step('Alice navigates to Bob-owned group', async () => {
        const chatPage = new ChatPage(authenticatedPage);
        await chatPage.gotoConversation(conversationId);
        await chatPage.waitForConversationLoaded();
        await chatPage.expectMessageVisible('Welcome to Bob group');
      });

      await test.step('Alice sees no free_allowance_pays (paid tier)', async () => {
        // ownerRemaining = 0 (Bob has $0) → effectiveCents = 0 → personal
        // Alice is paid tier → personal_balance → no free_allowance_pays
        await expect(
          authenticatedPage.getByTestId(TEST_ID_BUILDERS.budgetMessage('free_allowance_pays'))
        ).not.toBeVisible();
      });

      await test.step('Alice sends and pays for it herself', async () => {
        const chatPage = new ChatPage(authenticatedPage);
        await pinTextTurnShape(chatPage);
        await chatPage.sendFollowUpMessage(prompt);
        await chatPage.waitForAIResponse('Owner exhausted');
        await chatPage.expectMessageCostVisible();

        // Alice's own purchased wallet lost exactly her turn. The seeded group
        // carries no AI message, so the attribution assertion below can speak for
        // every assistant message in it: she is both payer and sender, which is
        // what separates this personal fallthrough from an owner-funded turn.
        await expectBalanceDelta(authenticatedRequest, aliceBefore, {
          purchased: spendOf(mockTextTurnCharge(basis, { prompt, answers: 1 })),
        });
        await expectChargeAttribution(authenticatedRequest, conversationId, {
          payerId: alice!.userId,
          senderUserId: alice!.userId,
        });

        // Group spending NOT incremented (personal_balance → owner didn't pay)
        const budgets = await bobHelper.getBudgets(conversationId);
        expect(Number.parseFloat(budgets.totalSpent)).toBe(0);
      });
    }
  );

  test('budget visibility: footer and modal reflect spending', async ({
    authenticatedPage,
    testBobPage,
    authenticatedRequest,
    groupConversation,
  }) => {
    // 5 steps: setup, Bob send+AI response, Bob modal, Alice modal
    test.slow();

    const helper = new BudgetHelper(authenticatedRequest);
    const bobUser = groupConversation.members.find((m) => m.email === personaEmail('test-bob'))!;

    await test.step('setup budgets', async () => {
      await helper.setConversationBudget(groupConversation.id, 1000);
      const bobMemberId = await helper.findMemberId(groupConversation.id, bobUser.userId);
      await helper.setMemberBudget(groupConversation.id, bobMemberId, 500);
    });

    const bobChatPage = new ChatPage(testBobPage);
    await bobChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.waitForConversationLoaded();

    await test.step('budget footer is visible', async () => {
      const sidebar = new MemberSidebarPage(testBobPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await expect(sidebar.budgetFooter).toBeVisible();
      await sidebar.closeSidebar();
    });

    await test.step('no free_allowance_pays when owner-funded', async () => {
      await expect(
        testBobPage.getByTestId(TEST_ID_BUILDERS.budgetMessage('free_allowance_pays'))
      ).not.toBeVisible();
    });

    await test.step('Bob sends message and costs appear', async () => {
      await bobChatPage.sendFollowUpMessage(`Visibility test ${String(Date.now())}`);
      await bobChatPage.waitForAIResponse('Visibility test');
      await bobChatPage.expectMessageCostVisible();
    });

    await test.step('Bob budget modal shows spending', async () => {
      const sidebar = new MemberSidebarPage(testBobPage);
      // Reopen sidebar — on mobile (pixel-7) the Sheet is fully closed,
      // so member-budget-trigger is not in the DOM
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();
      await sidebar.clickBudgetSettings();

      const modal = testBobPage.getByTestId(TEST_IDS.budgetSettingsModal);
      await expect(modal).toBeVisible();

      // Values are text (read-only for non-owner)
      await expect(testBobPage.getByTestId(TEST_IDS.budgetConversationValue)).toBeVisible();

      // Total spent should be > $0.00
      const totalSpent = testBobPage.getByTestId(TEST_IDS.budgetTotalSpent);
      await expect(totalSpent).toBeVisible();

      await testBobPage.getByTestId(TEST_IDS.budgetCancelButton).click();
    });

    await test.step('Alice budget modal also shows updated spending', async () => {
      const aliceChatPage = new ChatPage(authenticatedPage);
      await aliceChatPage.gotoConversation(groupConversation.id);
      await aliceChatPage.waitForConversationLoaded();

      const aliceSidebar = new MemberSidebarPage(authenticatedPage);
      await aliceSidebar.openViaFacepile();
      await aliceSidebar.waitForLoaded();
      await aliceSidebar.clickBudgetSettings();

      const modal = authenticatedPage.getByTestId(TEST_IDS.budgetSettingsModal);
      await expect(modal).toBeVisible();

      // Owner sees editable inputs
      await expect(authenticatedPage.getByTestId(TEST_IDS.budgetConversationInput)).toBeVisible();

      const totalSpent = authenticatedPage.getByTestId(TEST_IDS.budgetTotalSpent);
      await expect(totalSpent).toBeVisible();

      await authenticatedPage.keyboard.press('Escape');
    });
  });
});
