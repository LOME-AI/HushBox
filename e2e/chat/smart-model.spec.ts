import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';
import { requireEnv } from '../helpers/env.js';

const apiUrl = requireEnv('VITE_API_URL');

const OPUS_MODEL_ID = 'anthropic/claude-opus-4.6';
const OPUS_MODEL_NAME = 'Claude Opus 4.6';
const SONNET_MODEL_ID = 'anthropic/claude-sonnet-4.6';
const SONNET_MODEL_NAME = 'Claude Sonnet 4.6';

/**
 * Smart Model end-to-end coverage (plan §F1-F4).
 *
 * The mock AIClient resolves Smart Model classifier calls to a deterministic
 * model id (overridable per scenario via the `setClassifierResolution` mock
 * helper, exposed at `/api/dev/classifier-resolution` in dev mode). Every
 * Smart Model response should:
 *   - render with a cost badge and a model nametag (the resolved model name);
 *   - show the "Smart" chip next to the nametag (`data-testid="smart-model-chip"`).
 */
test.describe('Smart Model', () => {
  test.afterEach(async ({ authenticatedPage }) => {
    // Reset classifier overrides between tests so cross-test bleed doesn't poison results.
    await authenticatedPage.request.post(`${apiUrl}/api/dev/classifier-resolution`, {
      data: { modelId: SONNET_MODEL_ID },
    });
    await authenticatedPage.request.post(`${apiUrl}/api/dev/classifier-failure`, {
      data: { enabled: false },
    });
  });
  /** F1: select Smart Model entry, send prompt, response renders with cost + nametag + Smart chip. */
  test('selects Smart Model, sends prompt, renders response with cost and Smart chip', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('open model selector and choose Smart Model', async () => {
      await chatPage.openModelSelector();
      const modal = authenticatedPage.getByTestId('model-selector-modal');

      // Clear default selection so Smart Model becomes the only choice.
      const clearButton = modal.getByTestId('clear-selection-button');
      if (await clearButton.isVisible()) {
        await clearButton.click();
      }

      const smartItem = modal.getByTestId('model-item-smart-model');
      await expect(smartItem).toBeVisible({ timeout: 10_000 });
      await smartItem.getByTestId('model-checkbox').click();
      await expect(smartItem).toHaveAttribute('data-selected', 'true');

      await chatPage.confirmModelSelection();
    });

    const prompt = `Smart Model send ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse();
    await chatPage.waitForStreamComplete();

    // F2: nametag visible alongside the Smart chip on the assistant message.
    const assistantMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    await expect(assistantMessage.getByTestId('model-nametag')).toBeVisible();
    await expect(assistantMessage.getByTestId('smart-model-chip')).toBeVisible();
    await expect(assistantMessage.getByTestId('smart-model-chip')).toContainText(/smart/i);

    const costBadge = assistantMessage.locator('[data-testid="message-cost"]').first();
    await expect(costBadge).toBeVisible();
    await expect(costBadge).toContainText(/\$/);
  });

  /**
   * F3: regenerate on a Smart Model response triggers a fresh classification.
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

    // Lane 9 #9: pin the first classifier resolution to Sonnet, then swap to
    // Opus before regenerate. The nametag on the regenerated assistant message
    // must reflect the new resolved model — proving the regenerate path
    // re-runs classification (it doesn't reuse the cached resolution).
    const setSonnet = await authenticatedPage.request.post(
      `${apiUrl}/api/dev/classifier-resolution`,
      { data: { modelId: SONNET_MODEL_ID } }
    );
    expect(setSonnet.ok()).toBe(true);

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) {
      await clearButton.click();
    }
    const smartItem = modal.getByTestId('model-item-smart-model');
    await expect(smartItem).toBeVisible({ timeout: 10_000 });
    await smartItem.getByTestId('model-checkbox').click();
    await chatPage.confirmModelSelection();

    const prompt = `Smart Model regen ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.waitForAIResponse();
    await chatPage.waitForStreamComplete();

    const initialAssistant = chatPage.messageList.locator('[data-role="assistant"]').first();
    await expect(initialAssistant.getByTestId('smart-model-chip')).toBeVisible();
    await expect(initialAssistant.getByTestId('model-nametag')).toContainText(SONNET_MODEL_NAME);

    // Now swap the classifier resolution before regenerate.
    const setOpus = await authenticatedPage.request.post(
      `${apiUrl}/api/dev/classifier-resolution`,
      { data: { modelId: OPUS_MODEL_ID } }
    );
    expect(setOpus.ok()).toBe(true);

    // Trigger regeneration on the assistant message (index 1).
    await chatPage.clickRegenerate(1);
    await chatPage.waitForStreamComplete();

    // After regeneration, the latest assistant response still shows the Smart
    // chip AND the nametag reflects the new classifier resolution (Opus).
    const refreshedAssistant = chatPage.messageList.locator('[data-role="assistant"]').last();
    await expect(refreshedAssistant.getByTestId('smart-model-chip')).toBeVisible();
    await expect(refreshedAssistant.locator('[data-testid="message-cost"]').first()).toBeVisible();
    await expect(refreshedAssistant.getByTestId('model-nametag')).toContainText(OPUS_MODEL_NAME);
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
    const overrideResponse = await authenticatedPage.request.post(
      `${apiUrl}/api/dev/classifier-resolution`,
      { data: { modelId: OPUS_MODEL_ID } }
    );
    expect(overrideResponse.ok()).toBe(true);

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) await clearButton.click();
    const smartItem = modal.getByTestId('model-item-smart-model');
    await expect(smartItem).toBeVisible({ timeout: 10_000 });
    await smartItem.getByTestId('model-checkbox').click();
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Smart→Opus ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    const assistantMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    await expect(assistantMessage.getByTestId('smart-model-chip')).toBeVisible();
    await expect(assistantMessage.getByTestId('model-nametag')).toContainText(OPUS_MODEL_NAME);
  });

  /**
   * Symmetric to the Opus test: Sonnet override → Sonnet nametag.
   */
  test('classifier picks claude-sonnet-4.6 → response nametag shows Sonnet', async ({
    authenticatedPage,
  }) => {
    test.slow();

    const overrideResponse = await authenticatedPage.request.post(
      `${apiUrl}/api/dev/classifier-resolution`,
      { data: { modelId: SONNET_MODEL_ID } }
    );
    expect(overrideResponse.ok()).toBe(true);

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) await clearButton.click();
    const smartItem = modal.getByTestId('model-item-smart-model');
    await expect(smartItem).toBeVisible({ timeout: 10_000 });
    await smartItem.getByTestId('model-checkbox').click();
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Smart→Sonnet ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    const assistantMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    await expect(assistantMessage.getByTestId('smart-model-chip')).toBeVisible();
    await expect(assistantMessage.getByTestId('model-nametag')).toContainText(SONNET_MODEL_NAME);
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

    // Force classifier failure for this test only.
    const failureResponse = await authenticatedPage.request.post(
      `${apiUrl}/api/dev/classifier-failure`,
      { data: { enabled: true } }
    );
    expect(failureResponse.ok()).toBe(true);

    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) await clearButton.click();
    const smartItem = modal.getByTestId('model-item-smart-model');
    await expect(smartItem).toBeVisible({ timeout: 10_000 });
    await smartItem.getByTestId('model-checkbox').click();
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Smart fallback ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    // Even on classifier failure the user gets a response with the Smart chip.
    // Nametag will be one of the eligible value models.
    const assistantMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    await expect(assistantMessage.getByTestId('smart-model-chip')).toBeVisible();
    const nametag = await assistantMessage.getByTestId('model-nametag').textContent();
    expect(nametag, 'fallback nametag must be non-empty').toBeTruthy();
    // The fallback resolves to a real text model — its nametag matches one of
    // the mock-catalogued text model display names.
    expect([SONNET_MODEL_NAME, OPUS_MODEL_NAME]).toContain(nametag?.trim());
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

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) await clearButton.click();
    const smartItem = modal.getByTestId('model-item-smart-model');
    await expect(smartItem).toBeVisible({ timeout: 10_000 });
    await smartItem.getByTestId('model-checkbox').click();
    await chatPage.confirmModelSelection();

    await chatPage.sendNewChatMessage(`Smart usage rows ${String(Date.now())}`);
    await chatPage.waitForConversation();
    await chatPage.waitForStreamComplete();

    // Conversation id is in the URL after navigation.
    const url = new URL(authenticatedPage.url());
    const conversationId = url.pathname.split('/').pop() ?? '';
    expect(conversationId).toBeTruthy();

    // Poll the count until it reaches 2 (saveChatTurn finalizes async).
    await expect
      .poll(
        async () => {
          const response = await authenticatedPage.request.get(
            `${apiUrl}/api/dev/llm-completions-count/${conversationId}`
          );
          if (!response.ok()) return -1;
          const body = (await response.json()) as { count: number };
          return body.count;
        },
        { timeout: 15_000 }
      )
      .toBe(2);
  });

  /**
   * F4: a low-balance user (~$0.01 purchased, $0 free) can't afford a Smart
   * Model send — the affordability preflight blocks the request and shows the
   * insufficient-balance message in the prompt input. No assistant message
   * persists.
   */
  test('insufficient balance blocks send and surfaces the budget error', async ({
    lowBalancePage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(lowBalancePage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await test.step('select Smart Model on a low-balance account', async () => {
      await chatPage.openModelSelector();
      const modal = lowBalancePage.getByTestId('model-selector-modal');
      const clearButton = modal.getByTestId('clear-selection-button');
      if (await clearButton.isVisible()) {
        await clearButton.click();
      }
      const smartItem = modal.getByTestId('model-item-smart-model');
      await expect(smartItem).toBeVisible({ timeout: 10_000 });
      await smartItem.getByTestId('model-checkbox').click();
      await chatPage.confirmModelSelection();
    });

    // Type a prompt; the budget banner ought to render before/while typing.
    await chatPage.promptInput.fill(`Smart Model insufficient ${String(Date.now())}`);

    // budget-messages renders the friendly insufficient-balance string from
    // generateNotifications. The send button must be disabled.
    await unsettledExpect(lowBalancePage.getByTestId('budget-messages')).toBeVisible({
      timeout: 10_000,
    });
    await expect(lowBalancePage.getByText(/Insufficient balance\./i)).toBeVisible();
    await expect(chatPage.sendButton).toBeDisabled();

    // No conversation is ever created (still on /chat).
    await expect(lowBalancePage).toHaveURL(/\/chat$/);
  });

  /**
   * Lane 9 #8: while the classifier is resolving, the assistant slot must
   * surface a "Choosing the best model…" thinking indicator. Once the
   * classifier resolves and the inference response begins streaming, the
   * indicator must disappear (replaced by the actual streaming content). The
   * test fires off a normal Smart Model send and races a quick polling
   * window — the loading indicator needs to be visible briefly, then
   * disappear within a reasonable timeout once the response arrives.
   */
  test('Smart Model shows "Choosing the best model" loading state then clears it', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    await chatPage.openModelSelector();
    const modal = authenticatedPage.getByTestId('model-selector-modal');
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) await clearButton.click();
    const smartItem = modal.getByTestId('model-item-smart-model');
    await expect(smartItem).toBeVisible({ timeout: 10_000 });
    await smartItem.getByTestId('model-checkbox').click();
    await chatPage.confirmModelSelection();

    // Send the message — don't await waitForAIResponse before we start polling
    // for the loading text, because the indicator window is brief.
    const prompt = `Smart Model loading ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);

    // The "Choosing the best model…" indicator should appear within a short
    // window (the classifier round-trip starts as soon as the first token
    // arrives). It is rendered by the ThinkingIndicator with stageLabel.
    const loadingIndicator = authenticatedPage.getByText('Choosing the best model…');
    await expect(loadingIndicator).toBeVisible({ timeout: 10_000 });

    // The indicator must clear once the classifier resolves and the inference
    // response starts streaming.
    await expect(loadingIndicator).not.toBeVisible({ timeout: 15_000 });

    // Sanity: the assistant message arrived with a real response.
    await chatPage.waitForStreamComplete();
    const assistant = chatPage.messageList.locator('[data-role="assistant"]').first();
    await expect(assistant.getByTestId('smart-model-chip')).toBeVisible();
  });
});
