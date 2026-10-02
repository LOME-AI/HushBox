import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { test, expect, type Locator } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { setupRealtimePair } from '../helpers/realtime.js';
import { settledReasoningLabel } from '../helpers/reasoning-row.js';
import { E2E_MODELS } from '../../scripts/lib/playwright/model-ids.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ChatPage } from '../pages';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/** A text model that carries a reasoning wire at a pinned rung, as the reasoning-row specs drive. */
const REASONING_MODEL_ID = E2E_MODELS.text[1];

/**
 * What every mock search returns on the E2E stack: the fake search adapter
 * answers any query with the same three reserved example domains.
 */
const MOCK_PAGE_COUNT = 3;
const MOCK_FIRST_TITLE = 'Example Domain';
const MOCK_QUERY = 'mock web search 1';

const NESTED_LABEL = `${settledReasoningLabel('high')} · Searched ${String(MOCK_PAGE_COUNT)} sources`;
const INLINE_LABEL = `Searched the web · ${String(MOCK_PAGE_COUNT)} sources`;

/**
 * Parks the next send on a mock search turn in its searching state. Page
 * headers are replaced whole, so the hold rides in the same call as the search
 * directives: the mock asks for one search through the run's tool, and the
 * held run stops after its tool call and before its result.
 */
async function holdNextSearchTurn(
  chatPage: ChatPage,
  options: { afterAnswerText: boolean }
): Promise<void> {
  await chatPage.page.setExtraHTTPHeaders({
    'x-mock-hold-primary-stream': 'true',
    'x-mock-web-search-count': '1',
    ...(options.afterAnswerText ? { 'x-mock-web-search-after-text': 'true' } : {}),
  });
}

function lastAssistant(chatPage: ChatPage): Locator {
  return chatPage.messagesByRole('assistant').last();
}

/**
 * Waits until the stored answer has replaced the live one on this page. The
 * cost renders only from the stored row, so its badge on the last answer marks
 * the swap done. Every assertion after a release comes after this.
 */
async function waitForStoredAnswer(chatPage: ChatPage, prompt: string): Promise<Locator> {
  const answer = lastAssistant(chatPage);
  await expect(answer.getByTestId(TEST_IDS.messageCost)).toBeVisible({
    timeout: TIMEOUTS.STREAM_SATURATED,
  });
  await expect(answer).toContainText(prompt);
  return answer;
}

/**
 * The search rows a message draws while its reasoning row is closed: a closed
 * reasoning row renders nothing of its body, so every row found here sits in
 * the answer itself rather than nested in the reasoning.
 */
function answerRows(message: Locator): Locator {
  return message.getByTestId(TEST_IDS.webSearchRow);
}

test.describe('Web search row', SPEC_MATRIX, () => {
  test('an answer keeps its id and its opened reasoning when the stored row replaces the live one', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.selectSingleModel(REASONING_MODEL_ID);
    await chatPage.selectReasoningEffort('High');
    await authenticatedPage.getByRole('button', { name: /Turn on internet search/i }).click();
    const prompt = `Kept reasoning ${String(Date.now())}`;

    await holdNextSearchTurn(chatPage, { afterAnswerText: true });
    await chatPage.sendFollowUpMessage(prompt);
    await chatPage.waitForStreamingActive();
    const live = lastAssistant(chatPage);
    const liveToggle = live.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    await liveToggle.click();
    await expect(liveToggle).toHaveAttribute('aria-expanded', 'true');
    const liveId = await live.getAttribute(TEST_SIGNALS.messageId);
    expect(liveId).not.toBeNull();

    await chatPage.stopHoldingStreams();
    await chatPage.releaseHeldStream(testConversation.id);
    const stored = await waitForStoredAnswer(chatPage, prompt);

    await expect(stored).toHaveAttribute(TEST_SIGNALS.messageId, liveId ?? '');
    await expect(stored.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  test('a search nests in the reasoning it happened in and sits inline in the answer otherwise, the same live, for a watcher and after reload', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    test.slow();
    const { aliceChatPage, bobChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    await test.step('pin a reasoning model at High effort and turn web search on', async () => {
      await aliceChatPage.selectSingleModel(REASONING_MODEL_ID);
      await aliceChatPage.selectReasoningEffort('High');
      await authenticatedPage.getByRole('button', { name: /Turn on internet search/i }).click();
      await expect(
        authenticatedPage.getByRole('button', { name: /Turn off internet search/i })
      ).toBeVisible();
    });

    const nestedPrompt = `Nested search ${String(Date.now())}`;

    await test.step('while the search runs inside reasoning, both members see only the one-liner', async () => {
      await holdNextSearchTurn(aliceChatPage, { afterAnswerText: false });
      await aliceChatPage.sendFollowUpMessage(nestedPrompt);
      await aliceChatPage.waitForStreamingActive();

      const modelName = await lastAssistant(aliceChatPage)
        .getByTestId(TEST_IDS.modelNametag)
        .textContent();
      for (const page of [aliceChatPage, bobChatPage]) {
        const message = lastAssistant(page);
        await expect(message.getByTestId(TEST_IDS.thinkingDisclosureStatus)).toHaveText(
          `${modelName ?? ''} is searching the web`
        );
        // Live reasoning is its one-liner alone: the search inside it is not on screen.
        await expect(message.getByTestId(TEST_IDS.webSearchRow)).toHaveCount(0);
      }
    });

    await test.step('once settled, the one-liner counts the search for both members', async () => {
      await aliceChatPage.stopHoldingStreams();
      await aliceChatPage.releaseHeldStream(groupConversation.id);
      await waitForStoredAnswer(aliceChatPage, nestedPrompt);
      await aliceChatPage.waitForAIResponse(nestedPrompt);

      for (const page of [aliceChatPage, bobChatPage]) {
        const message = await waitForStoredAnswer(page, nestedPrompt);
        await expect(message.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveText(
          NESTED_LABEL
        );
      }
    });

    await test.step('opening the reasoning shows the search inside it, which opens to its sources', async () => {
      const message = await waitForStoredAnswer(aliceChatPage, nestedPrompt);
      await message.getByTestId(TEST_IDS.thinkingDisclosureToggle).click();
      const trace = message.getByTestId(TEST_IDS.thinkingDisclosureContent);
      const nested = trace.getByTestId(TEST_IDS.webSearchRow);
      await expect(nested).toHaveCount(1);
      await nested.getByTestId(TEST_IDS.webSearchRowToggle).click();
      await expect(nested.getByTestId(TEST_IDS.webSearchSource)).toHaveCount(MOCK_PAGE_COUNT);
      await expect(nested.getByTestId(TEST_IDS.webSearchSource).first()).toContainText(
        MOCK_FIRST_TITLE
      );
    });

    const inlinePrompt = `Inline search ${String(Date.now())}`;

    await test.step('a search made after the answer began runs inline, live for both members', async () => {
      await holdNextSearchTurn(aliceChatPage, { afterAnswerText: true });
      await aliceChatPage.sendFollowUpMessage(inlinePrompt);
      await aliceChatPage.waitForStreamingActive();

      for (const page of [aliceChatPage, bobChatPage]) {
        const message = lastAssistant(page);
        await expect(message.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAttribute(
          'aria-expanded',
          'false'
        );
        const row = answerRows(message);
        await expect(row).toHaveCount(1);
        await expect(row).toHaveAttribute('data-state', 'live');
        await expect(row.getByTestId(TEST_IDS.webSearchRowQueries)).toContainText(
          `${MOCK_QUERY}·Searching`
        );
      }
    });

    await test.step('once settled, the inline row names its sources for both members', async () => {
      await aliceChatPage.stopHoldingStreams();
      await aliceChatPage.releaseHeldStream(groupConversation.id);
      await waitForStoredAnswer(aliceChatPage, inlinePrompt);
      await aliceChatPage.waitForAIResponse(inlinePrompt);

      for (const page of [aliceChatPage, bobChatPage]) {
        const message = await waitForStoredAnswer(page, inlinePrompt);
        await expect(answerRows(message).getByTestId(TEST_IDS.webSearchRowToggle)).toContainText(
          INLINE_LABEL
        );
        // The reasoning that came before the answer carries no search of its own.
        await expect(message.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveText(
          settledReasoningLabel('high')
        );
      }
    });

    await test.step('the inline row opens to its sources', async () => {
      const row = answerRows(await waitForStoredAnswer(aliceChatPage, inlinePrompt));
      await row.getByTestId(TEST_IDS.webSearchRowToggle).click();
      await expect(row.getByTestId(TEST_IDS.webSearchSource)).toHaveCount(MOCK_PAGE_COUNT);
    });

    await test.step('after a reload, both messages read the same', async () => {
      await authenticatedPage.goto(`/chat/${groupConversation.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await aliceChatPage.waitForConversationLoaded();

      const nested = aliceChatPage.messagesByRole('assistant').filter({ hasText: nestedPrompt });
      const inline = aliceChatPage.messagesByRole('assistant').filter({ hasText: inlinePrompt });
      await expect(nested.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveText(NESTED_LABEL);
      await expect(inline.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveText(
        settledReasoningLabel('high')
      );
      await expect(answerRows(inline).getByTestId(TEST_IDS.webSearchRowToggle)).toContainText(
        INLINE_LABEL
      );
      await answerRows(inline).getByTestId(TEST_IDS.webSearchRowToggle).click();
      await expect(answerRows(inline).getByTestId(TEST_IDS.webSearchSource)).toHaveCount(
        MOCK_PAGE_COUNT
      );
    });
  });
});
