import {
  ERROR_CODES,
  REASONING_EFFORT_LABELS,
  SMART_MODEL_ID,
  TEST_IDS,
  friendlyErrorMessage,
} from '@hushbox/shared';
import { test as base, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages/index.js';
import {
  BudgetHelper,
  getLlmCompletionCount,
  getFundingSnapshot,
  getPurchasedBalanceNanoUsd,
  nanoUsdWireToDollars,
  setWalletBalance,
} from '../helpers/budget.js';
import { findLadderlessTextModel } from '../helpers/catalog.js';
import { expectConversationChargeMatchesDisplay } from '../helpers/cost-display.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { assertPartialFailurePersistence } from '../helpers/partial-failure.js';
import { personaEmail } from '../helpers/personas.js';
import { nextTurnRequest } from '../helpers/turn-request.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { E2E_MODELS, E2E_TEXT_PINNED_EFFORT } from '../../scripts/lib/playwright/model-ids.js';
import type { ReasoningEffortSelection, ResolvedReasoningEffort } from '@hushbox/shared';
import type { APIRequestContext, Request } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * Both text models carry reasoning metadata, so the effort chip renders for the
 * pair and an Auto turn resolves a level per sibling. Order is load-bearing for
 * the partial-failure case below: the FIRST id is the one made to fail.
 */
const REASONING_MODEL_IDS = E2E_MODELS.text;
const FAILING_MODEL_ID = REASONING_MODEL_IDS[0];
const SURVIVING_MODEL_ID = REASONING_MODEL_IDS[1];

/** The level the mock classifier answers with. */
const CLASSIFIER_EFFORT = 'low';

/** A display word the page object drives the effort menu by. */
type EffortWord = Parameters<ChatPage['selectReasoningEffort']>[0];

/**
 * The rung the effort cases below pin: the one the catalog refresh's guard holds
 * the `E2E_MODELS.text` pair to, so the pair is declared able to run it. The page
 * object drives the menu by its display word, which is read off the shared label
 * map rather than spelled a second time — one vocabulary, no pair to drift.
 */
const PINNED_EFFORT = E2E_TEXT_PINNED_EFFORT;
// The label map types its words as `string` while the page object's parameter
// spells out the word set, so the one is asserted into the other here.
const PINNED_EFFORT_LABEL = REASONING_EFFORT_LABELS[PINNED_EFFORT] as EffortWord;

/**
 * The purchased balance the no-refusal case is read at. It is set by the case
 * rather than assumed: the pooled Alice is seeded at a balance sized for live
 * sends, and a balance that merely covers a turn leaves affordability a live
 * variable in the one case whose whole claim is that money is not one. The
 * fixture below restores whatever this displaced.
 */
const HIGH_BALANCE_DOLLARS = '10000.00';

/**
 * How many times the effort case halves its bracket while hunting the balance at
 * which the pinned rung stops being offered. The bracket is the turn's own
 * measured reserve, so five steps land within a thirty-second of it — finer than
 * the gap between two rungs of one ladder, which is what has to be resolved for
 * the rung below the pin to stay funded.
 */
const FUNDING_BISECTION_STEPS = 5;

/**
 * The pooled Alice's purchased balance, restored on teardown. The effort case has
 * to pin her into scarcity, and her seeded balance is a documented precondition of
 * the group and billing suites, so the restore rides fixture teardown: Playwright
 * runs teardown even when a test TIMES OUT, where an in-body `finally` is skipped
 * and its API calls would be rejected anyway.
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
 * The effort selection a captured turn request carried. An absent field is a
 * failure rather than a value here: every case that reads this one has an effort
 * control on screen, so silence would mean the composer dropped the selection.
 */
function effortOnTheWire(request: Request): ReasoningEffortSelection {
  const body = JSON.parse(request.postData() ?? '{}') as {
    reasoningEffort?: ReasoningEffortSelection;
  };
  const effort = body.reasoningEffort;
  if (effort === undefined) throw new Error('the turn request carried no reasoningEffort field');
  return effort;
}

/**
 * The level each model recorded on its persisted answer, keyed by model id.
 * `null` is the wire-silent outcome the content-item contract spells as an absent
 * field: no level was recorded, which is a different fact from the `off` a model
 * records when reasoning was explicitly resolved to none.
 */
async function recordedEffortByModel(
  request: APIRequestContext,
  conversationId: string
): Promise<Record<string, ResolvedReasoningEffort | null>> {
  const response = await request.get(`/conversations/${conversationId}/messages`);
  await expectOkResponse(response, 'conversation messages read');
  const { messages } = (await response.json()) as {
    messages: {
      senderType: string;
      contentItems: { modelName: string | null; reasoningEffort?: ResolvedReasoningEffort }[];
    }[];
  };
  const recorded: Record<string, ResolvedReasoningEffort | null> = {};
  for (const message of messages.filter((entry) => entry.senderType === 'assistant')) {
    for (const item of message.contentItems) {
      if (item.modelName !== null) recorded[item.modelName] = item.reasoningEffort ?? null;
    }
  }
  return recorded;
}

const MONEY_ARITHMETIC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'These assert arithmetic over numbers the server already computed, which no renderer can change. Cost-badge RENDERING stays on the full engine matrix in the sibling display tests.',
});

const PICKER_VERDICT_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'A row is refused by the shared affordability producer reading the served funding and catalog, and the verdict reaches the DOM as one attribute. No rendering engine takes part in that decision.',
});

test.describe('Multi-Model Chat', SPEC_MATRIX, () => {
  test.describe('Model Selection', () => {
    test('selects multiple models via toggle in modal', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('open modal and select 3 models', async () => {
        await chatPage.selectModels(3);
      });

      await test.step('verify the model chip reads the first model and 2 more', async () => {
        const chip = authenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
        await expect(chip).toHaveAccessibleName(/ \+ 2$/u);
      });

      await test.step('verify the chip counts 3 models', async () => {
        await chatPage.expectModelChipCount(3);
      });
    });

    test('removes a model through the picker', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models', async () => {
        await chatPage.selectModels(3);
        await chatPage.expectSeveralModelsSelected();
      });

      await test.step('deselect one model — the chip counts 2', async () => {
        await chatPage.openModelSelector();
        await chatPage.selectedModelItems().first().getByRole('button').first().click();
        await chatPage.confirmModelSelection();

        await expect(
          authenticatedPage.getByTestId(TEST_IDS.modelSelectorButton)
        ).toHaveAccessibleName(/ \+ 1$/u);
      });

      await test.step('deselect another — the chip names one model alone', async () => {
        await chatPage.openModelSelector();
        await chatPage.selectedModelItems().first().getByRole('button').first().click();
        await chatPage.confirmModelSelection();

        await chatPage.expectModelChipCount(1);
      });
    });

    test('enforces max model limit', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 5 models (max)', async () => {
        await chatPage.selectModels(5);
        await chatPage.expectModelChipCount(5);
      });

      await test.step('verify unselected models are dimmed in modal', async () => {
        await chatPage.openModelSelector();

        // Find an unselected model (not disabled by premium lock)
        // Selecting the 5-model max guarantees unselected models remain (the
        // pinned catalog exposes more than five selectable models), so the
        // first unselected row must render dimmed.
        const unselectedModels = chatPage.unselectedSelectableModelItems();
        await expect(unselectedModels.first()).toHaveClass(/opacity-40/);
      });

      await test.step('deselect one model — dimming lifts', async () => {
        const selectedItems = chatPage.selectedModelItems();
        // Click the row body to toggle (no separate checkbox zone in the new design).
        await selectedItems.last().getByRole('button').first().click();

        // Deselecting one drops the selection below the max, so dimming lifts:
        // the first unselected row (at minimum the one just deselected) is no
        // longer opacity-40.
        const unselected = chatPage.unselectedSelectableModelItems();
        await expect(unselected.first()).not.toHaveClass(/opacity-40/);

        await chatPage.confirmModelSelection();
      });
    });

    test('modal opens with current selections checked', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models and close modal', async () => {
        await chatPage.selectModels(3);
      });

      await test.step('reopen modal — same 3 have checkmarks', async () => {
        await chatPage.openModelSelector();
        const selectedCount = await chatPage.getSelectedModelCount();
        expect(selectedCount).toBe(3);
        await chatPage.confirmModelSelection();
      });
    });

    test('clear selected removes all selections', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models', async () => {
        await chatPage.selectModels(3);
        await chatPage.expectModelChipCount(3);
      });

      let chosenName = '';
      await test.step('reopen modal, clear, select 1 model, confirm', async () => {
        await chatPage.openModelSelector();
        // Picker remembers per-modality mode; tests selecting 3 left it in multi.
        await authenticatedPage.getByTestId(TEST_IDS.clearSelectionButton).first().click();
        await expect(chatPage.selectedModelItems()).toHaveCount(0);
        // Click row body to add the first non-premium back in.
        const firstNonPremium = chatPage.selectableModelItems();
        chosenName = await chatPage.modelRowName(firstNonPremium.first());
        await firstNonPremium.first().getByRole('button').first().click();
        await chatPage.confirmModelSelection();
      });

      await test.step('verify the model chip names the one chosen model, with no count', async () => {
        await chatPage.expectModelChipNames(chosenName);
      });
    });

    test('persists selection across page reload', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 2 models', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectSeveralModelsSelected();
      });

      await test.step('reload page', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForAppStable();
      });

      await test.step('verify 2 models still selected', async () => {
        await chatPage.expectModelChipCount(2);
      });
    });

    test('picker mode (single/multi) persists across page reload', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('switch picker to multi mode and close', async () => {
        await chatPage.openModelSelector();
        await chatPage.switchPickerMode('multi');
        // Close via Cancel — mode persists even when no selection committed.
        await authenticatedPage
          .getByTestId(TEST_IDS.modelSelectorModal)
          .getByTestId(TEST_IDS.cancelButton)
          .click();
      });

      await test.step('reload, reopen — mode is still multi', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForAppStable();
        await chatPage.openModelSelector();
        await expect(authenticatedPage.getByTestId(TEST_IDS.modelSelectorModal)).toHaveAttribute(
          'data-picker-mode',
          'multi'
        );
      });
    });

    test('single mode: clicking a row commits + closes the modal immediately', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await chatPage.openModelSelector();
      await chatPage.switchPickerMode('single');

      const modal = authenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      const firstNonPremium = chatPage.nonPremiumModelItems().first();
      const targetId = (await firstNonPremium.getAttribute('data-testid')) ?? '';
      const chosenName = await chatPage.modelRowName(firstNonPremium);

      await firstNonPremium.getByRole('button').first().click();

      // Modal closed without needing a Use button click. The close is a Radix
      // CSS animation with no in-flight queries, so allow a generous timeout
      // for slow WebKit to finish painting the closed state.
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      // The model chip names the new pick alone: single mode selects one model.
      await chatPage.expectModelChipNames(chosenName);
      // The picked model id was the one whose row we clicked
      expect(targetId).toContain('model-item-');
    });

    test('multi mode: Cancel discards local changes (does not commit)', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      // Start with one committed model (default Smart Model).
      await chatPage.selectSingleModel('smart-model');

      // Open picker, switch to multi, add another model, then Cancel
      await chatPage.openModelSelector();
      await chatPage.switchPickerMode('multi');
      const modal = authenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      const firstNonPremium = chatPage.nonPremiumModelItems().first();
      await firstNonPremium.getByRole('button').first().click();

      await modal.getByTestId(TEST_IDS.cancelButton).click();
      // Close is a Radix CSS animation with no in-flight queries, so allow a
      // generous timeout for slow WebKit to finish painting the closed state.
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      // The model chip still names one model, because the second was discarded
      await chatPage.expectOneModelSelected();
    });
  });

  test.describe('Multi-Model Streaming', () => {
    test('sends to multiple models and receives parallel responses', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 2 models and send message', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectSeveralModelsSelected();

        const testMessage = `Multi-stream test ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(testMessage);
        await chatPage.waitForConversation();
      });

      await test.step('verify 2 AI responses appear', async () => {
        await chatPage.waitForMultiModelResponses(2);
      });
    });

    test('each AI response shows model nametag', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      await test.step('verify all AI messages have nametags', async () => {
        await chatPage.expectAllAIMessagesHaveNametag();
      });

      await test.step('verify nametags show different model names', async () => {
        // Assert React-state count via countMessages (virtualization-safe).
        expect(await chatPage.countMessages('assistant')).toBe(2);

        // For index-based access use DOM count — the 2 multi-model responses
        // are always rendered because they're the newest messages.
        const assistantMessages = chatPage.messagesByRole('assistant');
        const nametag1 = assistantMessages.nth(0).getByTestId(TEST_IDS.modelNametag);
        const nametag2 =
          (await assistantMessages.nth(1).getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';
        await expect(nametag1).not.toHaveText(nametag2);
      });
    });

    test('displays cost per model response', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const costElements = chatPage.messageList.locator(`[data-testid="${TEST_IDS.messageCost}"]`);
      const count = await costElements.count();
      expect(count).toBeGreaterThanOrEqual(2);
    });

    test('follow-up message includes all previous responses in history', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      const streamBaseline = await chatPage.captureStreamBaseline();

      await test.step('send follow-up message', async () => {
        const followup = `Follow-up ${String(Date.now())}`;
        await chatPage.sendFollowUpMessage(followup);
        await chatPage.expectMessageVisible(followup);
      });

      await test.step('wait for 2 more AI responses (4 total)', async () => {
        // Wait for streaming to complete — cost badge signals billing + persistence done
        await chatPage.waitForStreamCycle(streamBaseline);
        // Verify via data attribute (client state) — Virtuoso may not render all items on mobile
        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '4', {
          timeout: TIMEOUTS.ROUTE,
        });
      });
    });

    // Balance debit equals the sum of displayed per-message costs for N
    // models. Catches reservation/charge skew at the wallet boundary, not just
    // at the API.
    // engine-any: the assertion is arithmetic over served numbers, which no
    // renderer can change. The cost badge's own rendering stays cross-browser in
    // 'displays cost per model response'.
    test(
      'wallet debit equals the sum of per-model displayed costs for N=2',
      MONEY_ARITHMETIC_MATRIX,
      async ({ authenticatedPage }) => {
        test.slow();
        const chatPage = new ChatPage(authenticatedPage);
        const budgetHelper = new BudgetHelper(authenticatedPage.request);

        await chatPage.goto();
        await chatPage.waitForAppStable();
        await chatPage.selectModels(2);

        const msg = `Wallet debit ${String(Date.now())}`;
        await chatPage.withStreamCycle(() => chatPage.sendNewChatMessage(msg));
        const conversationId = await chatPage.waitForConversation();
        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
          timeout: TIMEOUTS.ROUTE,
        });

        await expectConversationChargeMatchesDisplay(
          budgetHelper,
          conversationId,
          chatPage.messageList
        );
      }
    );

    // Web search × multi-model, on the display path. The debit and the
    // per-tile costs are written from one charge list, so an over-charged
    // search (the N² shape) moves both sides together and passes here: what
    // this holds is that the search-inclusive charge and its display agree,
    // not that the amount is right.
    // engine-any: same arithmetic-over-served-numbers reason as above.
    test(
      'the search-inclusive charge and the displayed cost agree with N=2 models',
      MONEY_ARITHMETIC_MATRIX,
      async ({ authenticatedPage }) => {
        test.slow();
        const chatPage = new ChatPage(authenticatedPage);
        const budgetHelper = new BudgetHelper(authenticatedPage.request);

        await chatPage.goto();
        await chatPage.waitForAppStable();
        await chatPage.selectModels(2);

        // Flip web search on via the toolbar toggle.
        const searchToggle = authenticatedPage.getByRole('button', {
          name: /Turn on internet search/i,
        });
        await searchToggle.click();
        await expect(
          authenticatedPage.getByRole('button', { name: /Turn off internet search/i })
        ).toBeVisible();

        const msg = `Search debit ${String(Date.now())}`;
        await chatPage.withStreamCycle(
          () => chatPage.sendNewChatMessage(msg),
          TIMEOUTS.MEDIA_DECODE
        );
        const conversationId = await chatPage.waitForConversation();
        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
          timeout: TIMEOUTS.ROUTE,
        });

        // Charge must equal the displayed search-inclusive cost.
        await expectConversationChargeMatchesDisplay(
          budgetHelper,
          conversationId,
          chatPage.messageList
        );
      }
    );

    /**
     * On Auto effort the classifier chooses the level each sibling runs at, and
     * the settled answer wears the level it actually ran at — not the composer's
     * Auto. The mock's classifier emits one pinned level, so both nameplates'
     * effort tags must read that level's word: a tag reading "Auto", or no tag,
     * means the resolved level never reached the persisted answer.
     *
     * The tag shows only where a turn left a reasoning trace, so a turn that
     * emitted no thoughts shows no rung anywhere. These siblings do reason: the
     * resolved level is what puts an active reasoning config on the request,
     * which is what makes the mock stream thoughts ahead of the echo.
     */
    test('each answer of an auto-effort multi-model turn wears the level it ran at', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);

      await authenticatedPage.setExtraHTTPHeaders({
        'x-mock-classifier-effort': CLASSIFIER_EFFORT,
      });

      try {
        await chatPage.goto();
        await chatPage.waitForAppStable();

        await test.step('select two reasoning models and leave effort on Auto', async () => {
          await chatPage.selectModelsByIds(REASONING_MODEL_IDS);
          await chatPage.expectSeveralModelsSelected();
          // Both siblings offer levels, so the chip renders; Auto is what makes
          // the turn carry a classifier at all.
          await expect(chatPage.effortChip()).toBeVisible();
          await chatPage.selectReasoningEffort('Auto');
        });

        await test.step('send and wait for both answers to settle', async () => {
          await chatPage.withStreamCycle(
            () => chatPage.sendNewChatMessage(`Auto effort ${String(Date.now())}`),
            TIMEOUTS.MEDIA_DECODE
          );
          await chatPage.waitForConversation();
          await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
            timeout: TIMEOUTS.ROUTE,
          });
        });

        await test.step('both answers tag their nameplate with that level', async () => {
          const assistantMessages = chatPage.messagesByRole('assistant');
          for (const index of [0, 1]) {
            const tag = assistantMessages.nth(index).getByTestId(TEST_IDS.effortTag);
            await expect(tag).toBeVisible();
            await expect(tag).toHaveText(`${REASONING_EFFORT_LABELS[CLASSIFIER_EFFORT]} effort`);
          }
        });
      } finally {
        await authenticatedPage.setExtraHTTPHeaders({});
      }
    });
  });

  test.describe('Multi-Model on Fork', () => {
    test('multi-model responses persist on fork after streaming completes', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('send single-model message and create fork', async () => {
        const setupMsg = `Fork setup ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(setupMsg);
        await chatPage.waitForConversation();
        await chatPage.waitForAIResponse(setupMsg);

        await chatPage.clickFork(1);
        await chatPage.expectBranchCount(2);
        await chatPage.expectCurrentBranch('Fork 1');
      });

      await test.step('select 2 models and send message on fork', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectSeveralModelsSelected();

        const forkMsg = `Multi-model on fork ${String(Date.now())}`;
        await chatPage.sendFollowUpMessage(forkMsg);
        await chatPage.expectMessageVisible(forkMsg);
      });

      await test.step('verify both AI responses visible after stream completes', async () => {
        // Verify via data attributes (client state) — Virtuoso may not render all items on mobile.
        // Cost count confirms: done SSE → saveChatTurn committed → invalidateQueries refetched.
        await expect(chatPage.messageList).toHaveAttribute('data-cost-count', '3', {
          timeout: TIMEOUTS.ROUTE,
        });
        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '3', {
          timeout: TIMEOUTS.STREAM,
        });
      });

      await test.step('verify distinct model nametags on multi-model responses', async () => {
        // Index-based access needs DOM count (state count may exceed rendered
        // count under virtualization, causing nth() to wait for a non-existent
        // node). The multi-model responses are the two newest assistant items,
        // which Virtuoso always keeps rendered since it auto-scrolls on new
        // content.
        const assistantMessages = chatPage.messagesByRole('assistant');
        const domCount = await assistantMessages.count();
        const nametag1 = assistantMessages.nth(domCount - 2).getByTestId(TEST_IDS.modelNametag);
        const nametag2 =
          (await assistantMessages
            .nth(domCount - 1)
            .getByTestId(TEST_IDS.modelNametag)
            .textContent()) ?? '';
        await expect(nametag1).not.toHaveText(nametag2);
      });

      await test.step('page reload preserves all responses on fork', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForConversationLoaded();

        await chatPage.expectCurrentBranch('Fork 1');

        await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '3', {
          timeout: TIMEOUTS.STREAM,
        });
      });
    });
  });

  test.describe('Single-Model Regression', () => {
    test('single model selection works identically to before', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 1 model — the model chip names one model', async () => {
        await chatPage.selectModels(1);
        await chatPage.expectOneModelSelected();
      });

      await test.step('send message — 1 response, normal flow', async () => {
        const testMessage = `Single model ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(testMessage);
        await chatPage.waitForConversation();
        await chatPage.waitForAIResponse(testMessage);
        await chatPage.expectAssistantMessageContains('Echo:');
      });
    });
  });

  test.describe('Partial Failure', () => {
    test('handles partial model failure gracefully', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      const { successModelId, failModelId } = await chatPage.selectModelsWithFailTarget();
      await chatPage.expectSeveralModelsSelected();

      await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModelId });

      try {
        const streamBaseline = await chatPage.captureStreamBaseline();
        await chatPage.sendNewChatMessage(`Partial failure test ${String(Date.now())}`);
        await chatPage.waitForConversation();

        const successResponse = chatPage.messagesByRole('assistant').filter({ hasText: 'Echo:' });
        await expect(successResponse.first()).toBeVisible({ timeout: TIMEOUTS.STREAM_SATURATED });

        // Gate on the server-side settle before the persistence read below: the
        // success token is visible in the DOM before saveChatTurn commits.
        await chatPage.waitForStreamCycle(streamBaseline);

        // Error renders on an optimistic message after stream ends — opt out of settled
        // to wait for the React re-render without premature failure
        const errorMessage = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
        await expect(errorMessage).toBeVisible({ timeout: TIMEOUTS.ASSERT });
        // A failed sibling's tile carries the stream-error code and renders that
        // code's registered sentence — matched whole, so no other one can pass.
        await expect(errorMessage).toHaveText(friendlyErrorMessage(ERROR_CODES.STREAM_ERROR));

        await assertPartialFailurePersistence(authenticatedPage, {
          succeededModelId: successModelId,
          failedModelId: failModelId,
          expectedSucceededCount: 1,
        });

        await expect(chatPage.messageInput).toBeVisible();
      } finally {
        await authenticatedPage.setExtraHTTPHeaders({});
      }
    });

    // Partial failure on the display path: the charge that survives the
    // failed slot is the one the tiles show. A charge for the failed model
    // would anchor onto the surviving tile and land in both sums, so this
    // cannot speak for "the failed model was not billed" — the media suite
    // asserts that one against a derivation.
    // engine-any: arithmetic over served numbers. The failure tile's own
    // rendering stays cross-browser in 'handles partial model failure gracefully'.
    test(
      'charge and display agree when one of two models fails',
      MONEY_ARITHMETIC_MATRIX,
      async ({ authenticatedPage }) => {
        test.slow();
        const chatPage = new ChatPage(authenticatedPage);
        const budgetHelper = new BudgetHelper(authenticatedPage.request);

        await chatPage.goto();
        await chatPage.waitForAppStable();

        const { failModelId } = await chatPage.selectModelsWithFailTarget();
        await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModelId });
        try {
          await chatPage.withStreamCycle(
            () => chatPage.sendNewChatMessage(`Refund test ${String(Date.now())}`),
            TIMEOUTS.MEDIA_DECODE
          );
          const conversationId = await chatPage.waitForConversation();

          const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
          await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.ASSERT });

          // One tile carries a cost badge, and the conversation's charge is
          // that tile's. Whether a second charge exists is not decidable here.
          await expectConversationChargeMatchesDisplay(
            budgetHelper,
            conversationId,
            chatPage.messageList
          );
        } finally {
          await authenticatedPage.setExtraHTTPHeaders({});
        }
      }
    );

    /**
     * The classifier's own charge is anchored to the first PERSISTED answer, not
     * to the first requested sibling. Failing the first sibling is what tells
     * those apart: an anchor keyed on request order has no content item to hang
     * on, so the charge would be dropped and the routing the user paid for would
     * go unbilled.
     *
     * Two completion rows is the discriminating count, and only alongside the
     * persistence assertion: exactly one sibling persisted, so the second row
     * can only be the classifier's.
     */
    // engine-any: the discriminating assertion is a persisted completion-row
    // count read over the API, with no rendered value in it.
    test(
      'the classifier charge still lands when the first sibling fails',
      MONEY_ARITHMETIC_MATRIX,
      async ({ authenticatedPage }) => {
        test.slow();
        const chatPage = new ChatPage(authenticatedPage);

        await chatPage.goto();
        await chatPage.waitForAppStable();

        await test.step('select two reasoning models on Auto effort', async () => {
          await chatPage.selectModelsByIds(REASONING_MODEL_IDS);
          await chatPage.expectSeveralModelsSelected();
          await expect(chatPage.effortChip()).toBeVisible();
          await chatPage.selectReasoningEffort('Auto');
        });

        await authenticatedPage.setExtraHTTPHeaders({
          'x-mock-failing-models': FAILING_MODEL_ID,
          'x-mock-classifier-effort': CLASSIFIER_EFFORT,
        });
        try {
          const streamBaseline = await chatPage.captureStreamBaseline();
          await chatPage.sendNewChatMessage(`Classifier anchor ${String(Date.now())}`);
          const conversationId = await chatPage.waitForConversation();
          await expect(
            chatPage.messagesByRole('assistant').filter({ hasText: 'Echo:' }).first()
          ).toBeVisible({ timeout: TIMEOUTS.STREAM_SATURATED });
          await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);

          await test.step('the first sibling failed and only the second persisted', async () => {
            await expect(authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage)).toBeVisible({
              timeout: TIMEOUTS.ASSERT,
            });
            await assertPartialFailurePersistence(authenticatedPage, {
              succeededModelId: SURVIVING_MODEL_ID,
              failedModelId: FAILING_MODEL_ID,
              expectedSucceededCount: 1,
            });
          });

          await test.step('two completion rows: the survivor plus the classifier', async () => {
            await expect
              .poll(async () => getLlmCompletionCount(authenticatedPage.request, conversationId), {
                timeout: TIMEOUTS.STREAM,
              })
              .toBe(2);
          });
        } finally {
          await authenticatedPage.setExtraHTTPHeaders({});
        }
      }
    );
  });
});

/**
 * The effort story end to end, on the two shapes whose defects were only ever
 * visible where the client and the server meet.
 */
test.describe('Reasoning Effort', SPEC_MATRIX, () => {
  /**
   * THE LAW: no client sends what the server would refuse. A pinned rung the
   * payer can no longer fund is lowered, and the lowered value is ONE value —
   * the chip displays it and the request carries it. Neither half proves the law
   * alone: a unit test can pin the displayed word or the sent word, but only a
   * live composer holds both at once.
   *
   * The scarcity is MEASURED, never guessed, and the measurement sets its own
   * scale: the first turn is parked mid-stream so its admission hold can be read,
   * and that hold — the turn's reserve at the pinned rung — brackets the hunt.
   * Halving inside that bracket, reading the menu's own greyed set at each probe
   * with the prompt filled every time (the graded basis includes it), lands on the
   * largest probed balance at which the rung is still greyed. One step below the
   * boundary, so every cheaper rung the ladder offers is still funded and the send
   * still goes out.
   *
   * The held-stream knob is SETUP here, not assertion: both halves of the law are
   * read while COMPOSING and at the moment the POST leaves, never mid-stream.
   */
  test('a pin the payer cannot fund lowers the chip and the request to one value', async ({
    authenticatedPage,
    authenticatedRequest,
    restorablePurchasedBalanceNanoUsd: _restoredOnTeardown,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const payerEmail = personaEmail('test-alice');
    const prompt = `Effort law ${String(Date.now())}`;

    /** Land on a fresh composer at `balance`, composing the same turn every time. */
    const composeAt = async (balanceNanoUsd: bigint): Promise<void> => {
      await setWalletBalance(
        authenticatedRequest,
        payerEmail,
        'purchased',
        nanoUsdWireToDollars(balanceNanoUsd.toString())
      );
      await chatPage.goto();
      await chatPage.waitForAppStable();
      await chatPage.waitForAffordabilitySettled();
      await chatPage.promptInput.fill(prompt);
    };

    /** Whether the menu is presenting the pinned rung greyed. Absent = a mis-read. */
    const pinnedRungGreyed = async (): Promise<boolean> => {
      const levels = await chatPage.effortMenuLevels();
      const rung = levels.find((level) => level.word === PINNED_EFFORT_LABEL);
      if (rung === undefined) {
        throw new Error(`the effort menu is not presenting ${PINNED_EFFORT_LABEL}`);
      }
      return rung.greyed;
    };

    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('pin the rung on a two-model turn — it is offered and ungreyed', async () => {
      await chatPage.selectModelsByIds(REASONING_MODEL_IDS);
      await chatPage.expectSeveralModelsSelected();
      await expect(chatPage.effortChip()).toBeVisible();
      await chatPage.selectReasoningEffort(PINNED_EFFORT_LABEL);
      await chatPage.promptInput.fill(prompt);
      expect(await pinnedRungGreyed(), 'the pinned rung must start out funded').toBe(false);
    });

    let reserveAtPinNanoUsd = 0n;
    let conversationId = '';

    await test.step('the composer sends the pinned rung, and the turn reserves against it', async () => {
      await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
      // Parked mid-stream so the admission hold is still standing when it is
      // read — the hold IS the turn's reserve at the pinned rung, and it is what
      // gives the hunt below a bracket on the right scale.
      await chatPage.holdPrimaryStreamForNextSends();
      const streamBaseline = await chatPage.captureStreamBaseline();
      try {
        const requested = nextTurnRequest(authenticatedPage);
        await chatPage.sendButton.click();
        expect(REASONING_EFFORT_LABELS[effortOnTheWire(await requested)]).toBe(PINNED_EFFORT_LABEL);
        conversationId = await chatPage.waitForConversation();
        await chatPage.waitForStreamingActive();
        const reserved = async (): Promise<bigint> => {
          const snapshot = await getFundingSnapshot(authenticatedRequest, conversationId);
          return snapshot.heldNanoUsd;
        };
        await expect.poll(reserved, { timeout: TIMEOUTS.STREAM }).toBeGreaterThan(0n);
        reserveAtPinNanoUsd = await reserved();
      } finally {
        await chatPage.stopHoldingStreams();
        // Release only once an id exists. The dev route's query schema rejects an
        // empty string, so an unguarded call would throw out of `finally` on any
        // failure above and bury the failure that actually happened.
        if (conversationId !== '') await chatPage.releaseHeldStream(conversationId);
      }
      await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);
    });

    let starvedBalanceNanoUsd = 0n;

    await test.step('halve inside the reserve until the pinned rung stops being offered', async () => {
      // The bracket is the measured reserve: spendable is never below the balance
      // (the negative-balance cushion only adds), so the rung is funded at the top
      // of the bracket and starved at the bottom, and the boundary lies between.
      let funded = reserveAtPinNanoUsd;
      let starved = 0n;
      for (let attempt = 0; attempt < FUNDING_BISECTION_STEPS; attempt++) {
        const probe = (funded + starved) / 2n;
        await composeAt(probe);
        if (await pinnedRungGreyed()) starved = probe;
        else funded = probe;
      }
      starvedBalanceNanoUsd = starved;
    });

    await test.step('at that balance the chip no longer shows the pinned rung', async () => {
      await composeAt(starvedBalanceNanoUsd);
      expect(await pinnedRungGreyed(), 'the hunt must end on a starved balance').toBe(true);
      await expect(chatPage.effortChip()).not.toHaveAccessibleName(
        `Reasoning effort: ${PINNED_EFFORT_LABEL}`
      );
    });

    const loweredTurnBaseline = await chatPage.captureStreamBaseline();

    await test.step('the chip and the request carry the same lowered value', async () => {
      await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
      // The displayed half is captured BEFORE the send and is what the wire value
      // is then compared against, so both halves still ride one assertion. It
      // cannot be read after the click: the send invalidates the spendable query,
      // and at this starved balance the fresh hold lowers the funded ladder again,
      // so the chip legitimately moves shortly after the POST leaves.
      await expect(chatPage.effortChip()).toHaveAccessibleName(/^Reasoning effort: \S+$/u);
      const displayed = await chatPage.effortChipAccessibleName();

      const requested = nextTurnRequest(authenticatedPage);
      await chatPage.sendButton.click();
      const lowered = REASONING_EFFORT_LABELS[effortOnTheWire(await requested)];

      expect(lowered, 'the request must carry a lowered rung, not the pinned one').not.toBe(
        PINNED_EFFORT_LABEL
      );
      // The one assertion that holds both halves at once: the word on screen is
      // the word that went out. A client displaying one rung while sending
      // another is the exact defect this case exists for, and it passes every
      // unit test on either side.
      expect(displayed, 'the chip must display exactly the rung the request carried').toBe(
        `Reasoning effort: ${lowered}`
      );
    });

    await test.step('the server accepts the value the client lowered to', async () => {
      // The other half of the same law: a lowered value that still refused would
      // mean the client had sent something the server would not take. The page's
      // own API-error guard fails the test on any 4xx here, so the turn settling
      // is the whole assertion.
      await chatPage.waitForConversation();
      await chatPage.waitForStreamCycle(loweredTurnBaseline, TIMEOUTS.MEDIA_DECODE);
    });
  });

  /**
   * A model with no ladder is not a model that refuses the turn. Under a pin it
   * runs WIRE-SILENT — no reasoning field reaches the provider, so no level is
   * recorded on its answer — while its reasoning sibling answers at the pinned
   * rung. Turning that union into an intersection (greying every rung, refusing
   * the turn) was a Critical, and the shape is the one a later simplification of
   * the predicate would break again.
   *
   * The recorded level is read off the persisted content items rather than the
   * rendered badge: an absent field is precisely the "no level recorded" fact,
   * and it cannot be confused with a badge that merely failed to render.
   */
  test('a ladderless sibling runs wire-silent while its reasoning sibling answers at the pin', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const ladderless = await findLadderlessTextModel(authenticatedRequest);

    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select one reasoning model and one ladderless model, under the pin', async () => {
      await chatPage.selectModelsByIds([SURVIVING_MODEL_ID, ladderless.id]);
      await chatPage.expectSeveralModelsSelected();
      // The turn's option set is the UNION of the selection's ladders, so the
      // reasoning sibling's rungs are offered even though the other has none.
      await expect(chatPage.effortChip()).toBeVisible();
      await chatPage.selectReasoningEffort(PINNED_EFFORT_LABEL);
    });

    let conversationId = '';

    await test.step('the turn sends and both siblings answer', async () => {
      const streamBaseline = await chatPage.captureStreamBaseline();
      await chatPage.sendNewChatMessage(`Wire silence ${String(Date.now())}`);
      conversationId = await chatPage.waitForConversation();
      await expect(
        chatPage.messagesByRole('assistant').filter({ hasText: 'Echo:' }).first()
      ).toBeVisible({ timeout: TIMEOUTS.STREAM_SATURATED });
      // The persisted read in the next step must not race the settle commit.
      await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);
      await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });
    });

    await test.step('the pinned rung is recorded on the reasoning sibling alone', async () => {
      const recorded = await recordedEffortByModel(authenticatedRequest, conversationId);
      expect({
        reasoning: recorded[SURVIVING_MODEL_ID],
        ladderless: recorded[ladderless.id],
      }).toEqual({ reasoning: PINNED_EFFORT, ladderless: null });
    });
  });

  /**
   * A payer who cannot run out of money sees no model refused on a fresh
   * composer. Wire funding, the shared affordability producer and the rendered
   * row meet here and nowhere else, which is why the claim is worth a browser:
   * each layer alone can be right about a verdict the next one never receives.
   *
   * It is read at BOTH ends of the effort control, because the pin is what used
   * to falsify it. Grading every candidate at the PINNED rung refused each
   * reasoning model whose completion cap sat at or below that rung's budget —
   * at any balance, since no amount of money buys a model room it does not
   * have. Grading at each model's cheapest feasible rung moves that refusal
   * onto the effort menu, where a rung greys and the model stays selectable.
   *
   * The list is read only after the composer reports its affordability producer
   * resolved: until the spendable read and the catalog land every row renders
   * neutral, and neutral is the same DOM a passing assertion sees. That signal
   * is what makes a zero a verdict rather than an unanswered query, and the row
   * count is asserted non-empty for the same reason — no refusals out of no rows
   * is not the invariant.
   */
  test(
    'a payer at a high balance sees no model refused on a fresh composer',
    PICKER_VERDICT_MATRIX,
    async ({
      authenticatedPage,
      authenticatedRequest,
      restorablePurchasedBalanceNanoUsd: _restoredOnTeardown,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      await setWalletBalance(
        authenticatedRequest,
        personaEmail('test-alice'),
        'purchased',
        HIGH_BALANCE_DOLLARS
      );

      await chatPage.goto();
      await chatPage.waitForAppStable();
      await chatPage.waitForAffordabilitySettled();
      await chatPage.selectSingleModel(SMART_MODEL_ID);

      /** Open the picker on the still-unfilled composer and read its verdict. */
      const expectNothingRefused = async (): Promise<void> => {
        await chatPage.openModelSelector();
        await expect(chatPage.modelItems()).not.toHaveCount(0);
        await expect(chatPage.unavailableModelItems()).toHaveCount(0);
        await chatPage.confirmModelSelection();
      };

      await test.step('at Auto the fresh list refuses nothing', async () => {
        await chatPage.selectReasoningEffort('Auto');
        await expectNothingRefused();
      });

      await test.step('and it still refuses nothing once a rung is pinned', async () => {
        await chatPage.selectReasoningEffort(PINNED_EFFORT_LABEL);
        await expectNothingRefused();
      });
    }
  );
});
