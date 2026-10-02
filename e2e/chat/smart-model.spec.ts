import {
  SMART_MODEL_ID,
  TEST_IDS,
  TEST_ID_BUILDERS,
  noticeText,
  shortenModelName,
} from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { PRESENCE_ONLY_MODELS } from '../../scripts/lib/playwright/model-ids.js';
import { ChatPage } from '../pages/index.js';
import { getLlmCompletionCount } from '../helpers/budget.js';
import {
  expectExactCharge,
  expectNoWalletMovement,
  mockTextTurnCharge,
  readMockChargeBasis,
  readMoneyState,
  storedTextCharge,
} from '../helpers/exact-money.js';
import { pinOffRung } from '../helpers/text-turn-shape.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

const OPUS_MODEL_ID = PRESENCE_ONLY_MODELS.primary;
const OPUS_MODEL_NAME = 'Claude Opus 4.6';
const SONNET_MODEL_ID = PRESENCE_ONLY_MODELS.secondary;
const SONNET_MODEL_NAME = 'Claude Sonnet 4.6';

/**
 * A routed tile's label WHILE THE RUN IS LIVE. The resolve event carries the
 * model ID, and the nametag prefers it over the catalog lookup, so the display
 * name only lands when the post-run refetch substitutes the persisted row.
 */
const OPUS_LIVE_LABEL = shortenModelName(OPUS_MODEL_ID);

/**
 * How far above the payer's served daily allowance the unaffordable send's
 * estimate must sit. A block that holds by a hair is a fact about where the
 * estimator happens to land rather than about affordability, and this spec has
 * already been falsified once that way: an estimate narrowing made the turn
 * affordable and the spec failed on a missing notice, which says nothing about
 * the cause. Asserting the margin first turns that class of change into a
 * failure that names it.
 */
const ALLOWANCE_MARGIN = 3n;

/**
 * The filler the unaffordable prompt is built from. Words rather than one long
 * run of characters, so the composer's textarea wraps it the way it wraps any
 * other prompt.
 */
const PROMPT_FILLER = 'unaffordable ';

/**
 * Characters the unaffordable prompt carries, chosen so that its INPUT STORAGE
 * ALONE clears {@link ALLOWANCE_MARGIN} against a whole day's allowance.
 *
 * Storage is the one leg of the estimate a spec can price without standing up a
 * second estimator: it is a rate times a character count, and the count is at
 * least this message's own length — every other term (input tokens, the
 * classifier reserve, the answer floor) only adds. So `storedTextCharge` over
 * this length is a lower bound on the estimate, and the assertion below is
 * conservative in the direction that matters.
 */
const UNAFFORDABLE_PROMPT_CHARS = 700_000;

/**
 * Smart Model end-to-end coverage.
 *
 * The mock AIClient resolves Smart Model classifier calls to a deterministic
 * model id, configurable per request via the `x-mock-classifier-resolution`
 * HTTP header. Tests install the header via `page.setExtraHTTPHeaders`
 * before triggering the chat request; teardown is automatic when the page
 * is disposed, so no afterEach cleanup is required.
 *
 * Every Smart Model response should:
 *   - render with a cost badge and a model nametag (the resolved model name);
 *   - show the "Smart" chip next to the nametag (`data-testid="smart-model-chip"`).
 */
test.describe('Smart Model', SPEC_MATRIX, () => {
  /** Select the Smart Model entry, send a prompt, render the response with cost + nametag + Smart chip. */
  test('selects Smart Model, sends prompt, renders response with cost and Smart chip', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('open model selector and choose Smart Model', async () => {
      await chatPage.selectSingleModel(SMART_MODEL_ID);
      // The routing classifier is what this test prices; an effort wire on top
      // would stream reasoning text into the persisted answer and grow the
      // storage term past the echo the derivation sizes.
      await pinOffRung(chatPage);
    });

    const prompt = `Smart Model send ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    const conversationId = await chatPage.waitForConversation();
    await chatPage.waitForAIResponse(prompt);

    // A routed turn is billed TWICE: the classifier call, which persists
    // nothing of its own, and the answer it routed to. Naming both is what
    // makes this fail if the classifier's charge is dropped — the shape a
    // badge-visible assertion cannot see, since the dropped charge would
    // simply not be displayed either.
    await expectExactCharge(
      authenticatedPage.request,
      conversationId,
      mockTextTurnCharge(await readMockChargeBasis(authenticatedPage.request), {
        prompt,
        answers: 1,
        contentlessCalls: 1,
      })
    );

    // The nametag is visible alongside the Smart chip on the assistant message.
    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.modelNametag)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toContainText(/smart/i);

    const costBadge = assistantMessage.getByTestId(TEST_IDS.messageCost).first();
    await expect(costBadge).toBeVisible();
  });

  /**
   * Regenerate on a Smart Model response triggers a fresh classification.
   * The newly persisted assistant message still carries the Smart chip; a new
   * cost row is recorded (cost-count grows after regenerate).
   */
  test('regenerate re-runs classification and records a fresh response', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // Pin the first classifier resolution to Sonnet, then swap to
    // Opus before regenerate. The nametag on the regenerated assistant message
    // must reflect the new resolved model — proving the regenerate path
    // re-runs classification (it doesn't reuse the cached resolution).
    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': SONNET_MODEL_ID,
    });

    await chatPage.selectSingleModel(SMART_MODEL_ID);

    const prompt = `Smart Model regen ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse(prompt);

    const initialAssistant = chatPage.messagesByRole('assistant').first();
    await expect(initialAssistant.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(initialAssistant.getByTestId(TEST_IDS.modelNametag)).toContainText(
      SONNET_MODEL_NAME
    );

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': OPUS_MODEL_ID,
    });

    await chatPage.withStreamCycle(() => chatPage.clickRegenerate(1));

    const refreshedAssistant = chatPage.messagesByRole('assistant').last();
    await expect(refreshedAssistant.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(refreshedAssistant.getByTestId(TEST_IDS.messageCost).first()).toBeVisible();
    await expect(refreshedAssistant.getByTestId(TEST_IDS.modelNametag)).toContainText(
      OPUS_MODEL_NAME
    );
  });

  /**
   * Drives the classifier override end-to-end: setting resolution to Opus
   * yields a Smart Model response whose nametag is the Opus display name.
   */
  test('classifier picks claude-opus-4.6 → response nametag shows Opus', async ({
    authenticatedPage,
  }) => {
    test.slow();

    // Override the mock classifier to deterministically resolve to Opus.
    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': OPUS_MODEL_ID,
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel(SMART_MODEL_ID);

    await chatPage.withStreamCycle(() =>
      chatPage.sendNewChatMessage(`Smart→Opus ${String(Date.now())}`)
    );
    await chatPage.waitForConversation();

    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.modelNametag)).toContainText(
      OPUS_MODEL_NAME
    );
  });

  /**
   * Symmetric to the Opus test: Sonnet override → Sonnet nametag.
   */
  test('classifier picks claude-sonnet-4.6 → response nametag shows Sonnet', async ({
    authenticatedPage,
  }) => {
    test.slow();

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': SONNET_MODEL_ID,
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel(SMART_MODEL_ID);

    await chatPage.withStreamCycle(() =>
      chatPage.sendNewChatMessage(`Smart→Sonnet ${String(Date.now())}`)
    );
    await chatPage.waitForConversation();

    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    await expect(assistantMessage.getByTestId(TEST_IDS.modelNametag)).toContainText(
      SONNET_MODEL_NAME
    );
  });

  /**
   * Classifier failure → fallback path. The pipeline must select the cheapest
   * eligible model so the user still gets a response. We verify the nametag
   * renders some recognized model name and the chip is present, indicating
   * the fallback path executed.
   */
  test('classifier failure falls back to a value model and still renders a response', async ({
    authenticatedPage,
  }) => {
    test.slow();

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-failure': 'true',
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel(SMART_MODEL_ID);

    await chatPage.withStreamCycle(() =>
      chatPage.sendNewChatMessage(`Smart fallback ${String(Date.now())}`)
    );
    await chatPage.waitForConversation();

    // Even on classifier failure the user gets a response with the Smart chip.
    // Fallback resolves to the cheapest eligible model (config.classifierModelId
    // in `runSmartModelStage`), so the specific nametag depends on the mock
    // catalog's pricing — assert only that it's a non-empty real model name.
    const assistantMessage = chatPage.messagesByRole('assistant').first();
    await expect(assistantMessage.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    const nametag = assistantMessage.getByTestId(TEST_IDS.modelNametag);
    await expect(nametag, 'fallback nametag must be non-empty').not.toHaveText('');
  });

  /**
   * A single Smart Model send must persist TWO llm_completions rows: one for
   * the classifier call and one for the inference call. The dev endpoint
   * counts `llm_completions` joined to messages by conversationId so the test
   * is robust against later message edits/regens.
   */
  test('a Smart Model send persists two llm_completions rows (classifier + inference)', async ({
    authenticatedPage,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.selectSingleModel(SMART_MODEL_ID);

    await chatPage.withStreamCycle(() =>
      chatPage.sendNewChatMessage(`Smart usage rows ${String(Date.now())}`)
    );
    await chatPage.waitForConversation();

    // Conversation id is in the URL after navigation.
    const url = new URL(authenticatedPage.url());
    const conversationId = url.pathname.split('/').pop() ?? '';
    expect(conversationId).toBeTruthy();

    // Poll the count until it reaches 2 (saveChatTurn finalizes async).
    await expect
      .poll(async () => getLlmCompletionCount(authenticatedPage.request, conversationId), {
        timeout: TIMEOUTS.STREAM,
      })
      .toBe(2);
  });

  /**
   * Smart Model as ONE SIBLING of a multi-model turn (BILLING §Turn Stories 1):
   * the routed sibling wears the Smart chip and the nametag of the model the
   * classifier picked, while the plainly-selected sibling answers under its own
   * name and wears no chip. Both answers are billed, so both carry a cost badge
   * — a turn that dropped the routed sibling's charge would still render two
   * answers, which is why the badges are asserted per answer rather than counted.
   */
  test('Smart Model runs as one sibling of a multi-model turn alongside a named model', async ({
    authenticatedPage,
  }) => {
    test.slow();

    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': OPUS_MODEL_ID,
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select Smart Model and Sonnet as the two siblings', async () => {
      await chatPage.selectModelsByIds([SMART_MODEL_ID, SONNET_MODEL_ID]);
      await chatPage.expectSeveralModelsSelected();
    });

    await test.step('send and wait for both siblings to settle', async () => {
      await chatPage.withStreamCycle(
        () => chatPage.sendNewChatMessage(`Smart sibling ${String(Date.now())}`),
        TIMEOUTS.MEDIA_DECODE
      );
      await chatPage.waitForConversation();
      await expect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: TIMEOUTS.ROUTE,
      });
    });

    await test.step('exactly one answer is the routed one, and it names Opus', async () => {
      const assistantMessages = chatPage.messagesByRole('assistant');
      const routed = assistantMessages.filter({
        has: authenticatedPage.getByTestId(TEST_IDS.smartModelChip),
      });
      await expect(routed).toHaveCount(1);
      await expect(routed.getByTestId(TEST_IDS.modelNametag)).toContainText(OPUS_MODEL_NAME);
      await expect(routed.getByTestId(TEST_IDS.messageCost).first()).toBeVisible();
    });

    await test.step('the named sibling answers under its own name, unchipped', async () => {
      const assistantMessages = chatPage.messagesByRole('assistant');
      const plain = assistantMessages.filter({
        hasNot: authenticatedPage.getByTestId(TEST_IDS.smartModelChip),
      });
      await expect(plain).toHaveCount(1);
      await expect(plain.getByTestId(TEST_IDS.modelNametag)).toContainText(SONNET_MODEL_NAME);
      await expect(plain.getByTestId(TEST_IDS.messageCost).first()).toBeVisible();
    });
  });

  /**
   * The same mixture with the slot LAST: tiles are allocated in the SELECTED
   * order, the server emits its answer nodes in that same order, and each tile
   * must wear the label of the model whose answer it is carrying. That chain
   * crosses client and server, so no unit test spans it.
   *
   * It does NOT discriminate the client's tile binder. `stream-start` is emitted
   * before any provider await and the nodes are handed out in declaration order,
   * so with the slot last every pinned tile is already bound by its own id and
   * the routed stream lands on the only tile left — an arrival-order binder and
   * an id-first binder produce the same mapping in this arrangement. The binder's
   * choice is pinned by its own unit tests, on the ordering that reaches it.
   *
   * The routed tile is read at BOTH moments because its label is two different
   * strings. While the run is live it wears the resolved model ID; the catalog
   * display name arrives only when the post-run refetch swaps in the persisted
   * row. Asserting the settled name alone would never see the live label, and
   * asserting the live label alone would miss the swap.
   *
   * Auto effort is load-bearing, not incidental. With the effort axis open the
   * pinned sibling and the slot both read the classifier's decision, so they sit
   * in one execution level and stream concurrently — which is what lets the hold
   * barrier park them together. With the axis closed the sibling reads the turn
   * input instead, sits in an earlier level, and parks there forever, so the
   * slot's stream never starts and its label is never observable.
   */
  test('a slot-last mixed turn labels each tile: resolved id while live, catalog name once settled', async ({
    authenticatedPage,
  }) => {
    test.slow();

    // Non-vacuity: the live label and the settled label have to be different
    // strings, or the two reads below are one read made twice.
    expect(OPUS_LIVE_LABEL).not.toBe(OPUS_MODEL_NAME);

    // Both knobs in ONE call: `setExtraHTTPHeaders` REPLACES the header set, so
    // arming the hold separately would drop the classifier resolution.
    await authenticatedPage.setExtraHTTPHeaders({
      'x-mock-classifier-resolution': OPUS_MODEL_ID,
      'x-mock-hold-primary-stream': 'true',
    });

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('pin one model, put the Smart slot last, leave effort open', async () => {
      await chatPage.selectModelsByIds([SONNET_MODEL_ID, SMART_MODEL_ID]);
      await chatPage.expectSeveralModelsSelected();
      await expect(chatPage.effortChip()).toBeVisible();
      // Chosen explicitly rather than inherited from the stored default: the
      // level co-location this test parks on is a property of the OPEN axis.
      await chatPage.selectReasoningEffort('Auto');
    });

    let conversationId = '';
    const streamBaseline = await chatPage.captureStreamBaseline();

    try {
      await test.step('send and let both answer streams park', async () => {
        await chatPage.sendNewChatMessage(`Smart slot last ${String(Date.now())}`);
        conversationId = await chatPage.waitForConversation();
        await chatPage.waitForStreamingActive();
      });

      await test.step('while live, each tile names the model whose answer it holds', async () => {
        const tiles = chatPage.messagesByRole('assistant');
        await expect(tiles).toHaveCount(2, { timeout: TIMEOUTS.STREAM_SATURATED });

        // Position is the contract: the wire carries the sources in the selected
        // order and the tiles are allocated in that same order. Asserting each
        // position's own name is what a label swap fails — counting tiles, or
        // asserting both names appear somewhere, passes under any permutation.
        await expect(tiles.nth(0).getByTestId(TEST_IDS.modelNametag)).toContainText(
          SONNET_MODEL_NAME,
          { timeout: TIMEOUTS.STREAM_SATURATED }
        );
        await expect(tiles.nth(1).getByTestId(TEST_IDS.modelNametag)).toContainText(
          OPUS_LIVE_LABEL,
          { timeout: TIMEOUTS.STREAM_SATURATED }
        );

        // The chip is the routed tile's own mark, so it pins the same mapping
        // from the other side: it must sit on the slot's tile and nowhere else.
        await expect(tiles.nth(1).getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
        await expect(tiles.nth(0).getByTestId(TEST_IDS.smartModelChip)).toHaveCount(0);
      });
    } finally {
      await chatPage.stopHoldingStreams();
      // The dev route's query schema rejects an empty string, so an unguarded
      // call would throw out of `finally` and bury the real failure.
      if (conversationId !== '') await chatPage.releaseHeldStream(conversationId);
    }

    // Two facts the parked read cannot carry: the routed tile heals onto its
    // catalog display name, and the SERVER kept the slot last — the selected
    // order surviving the round trip, which decides which sibling is the fork tip.
    await test.step('settling relabels the routed tile, still last', async () => {
      await chatPage.waitForStreamCycle(streamBaseline, TIMEOUTS.MEDIA_DECODE);
      const tiles = chatPage.messagesByRole('assistant');
      await expect(tiles).toHaveCount(2, { timeout: TIMEOUTS.ROUTE });
      await expect(tiles.nth(0).getByTestId(TEST_IDS.modelNametag)).toContainText(
        SONNET_MODEL_NAME
      );
      await expect(tiles.nth(1).getByTestId(TEST_IDS.modelNametag)).toContainText(OPUS_MODEL_NAME);
      await expect(tiles.nth(1).getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
    });
  });

  /**
   * A payer whose wallets are both empty draws on the day-keyed free allowance,
   * not on a wallet, so unaffordability here is reached by COST: a prompt whose
   * storage alone dwarfs the allowance.
   *
   * The block names the LENGTH rather than the money, and that is the composer
   * working as designed: the pool's money refusal is what survives the
   * reduction, and a money refusal is re-voiced into the length wording
   * whenever the same turn with an empty prompt would still send — shortening
   * is then the action that actually clears the block, and offering credit
   * would name one the payer does not need. No conversation is created and no
   * wallet moves.
   */
  test('insufficient balance blocks send and surfaces the budget error', async ({
    lowBalancePage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select Smart Model on a low-balance account', async () => {
      await chatPage.selectSingleModel(SMART_MODEL_ID);
    });

    const before = await readMoneyState(lowBalancePage.request);
    const prompt = PROMPT_FILLER.repeat(
      Math.ceil(UNAFFORDABLE_PROMPT_CHARS / PROMPT_FILLER.length)
    );
    await chatPage.promptInput.fill(prompt);

    // The margin, asserted BEFORE the block it explains: what this turn stores
    // is priced through the rate settlement itself charges, and it clears the
    // whole served allowance several times over. A change that erodes the
    // margin fails here, naming it, instead of surfacing as a notice that never
    // appears.
    expect(storedTextCharge(prompt.length)).toBeGreaterThanOrEqual(
      before.allowanceRemainingNanoUsd * ALLOWANCE_MARGIN
    );

    await expect(lowBalancePage.getByTestId(TEST_IDS.budgetMessages)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    // Bound to the reason CODE, and to the sentence only through the shared
    // vocabulary the app renders from: a reword cannot drift this assertion,
    // and a rename of the reason fails to compile here rather than timing out
    // on a notice that no longer carries the name.
    const notice = lowBalancePage.getByTestId(TEST_ID_BUILDERS.budgetMessage('prompt_too_long'));
    await expect(notice).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(notice).toContainText(noticeText('prompt_too_long'));
    await expect(chatPage.sendButton).toBeDisabled();

    // No conversation is ever created (still on /chat).
    await expect(lowBalancePage).toHaveURL(/\/chat$/);
    await expectNoWalletMovement(lowBalancePage.request, before);
  });

  /**
   * A Smart Model send runs a pre-inference classifier stage that
   * picks the model, surfacing a "Choosing the best model…" indicator while it
   * resolves. The classifier is instant in tests (no wall-clock delay — see
   * buildMockConfig), so the transient indicator can't be reliably caught
   * mid-flight; instead we prove the stage ran via the monotonic
   * `data-pre-inference-stages-seen` signal, then confirm the indicator has
   * settled (not stuck) and a routed response rendered.
   */
  test('Smart Model send runs its pre-inference classifier stage', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.selectSingleModel(SMART_MODEL_ID);

    const preInferenceBaseline = await chatPage.capturePreInferenceBaseline();
    const streamBaseline = await chatPage.captureStreamBaseline();

    const prompt = `Smart Model loading ${String(Date.now())}`;
    await chatPage.sendFollowUpMessage(prompt);

    await chatPage.waitForPreInferenceStage(preInferenceBaseline);

    // After the turn completes the indicator must have settled, not stuck.
    await chatPage.waitForStreamCycle(streamBaseline);
    await expect(authenticatedPage.getByText('Choosing the best model…')).not.toBeVisible();

    const assistant = chatPage.messagesByRole('assistant').last();
    await expect(assistant.getByTestId(TEST_IDS.smartModelChip)).toBeVisible();
  });
});
