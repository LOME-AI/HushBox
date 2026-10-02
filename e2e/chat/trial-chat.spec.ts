import {
  ERROR_CODES,
  TEST_IDS,
  TEST_ID_BUILDERS,
  TRIAL_REMAINING_MESSAGE_ID,
  WEB_SEARCH_STORAGE_KEY,
  friendlyErrorMessage,
  noticeText,
} from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages';
import { requireEnv } from '../helpers/env.js';
import { idempotentDelete } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { ModelsListResponse } from '@hushbox/shared';
import type { APIRequestContext, Page } from '../fixtures.js';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * The sentence the spent daily quota puts on screen, read from the same lookup
 * the refusal builder reads (`apps/web/src/lib/chat/trial-refusals.ts`). Re-typing
 * the wording here is what let this spec assert copy the product never
 * contained.
 */
const TRIAL_LIMIT_MESSAGE = friendlyErrorMessage(ERROR_CODES.TRIAL_LIMIT_REACHED);

/**
 * The 6th send in a trial session deliberately trips the daily cap. The
 * resulting 429 from POST /chat/trial is the behavior under test, not a
 * regression — silence it on the page's allow-list so the default guard
 * (`fixtures.ts:455-459`) doesn't fire at teardown. Patterns split into
 * status-line + body-code matches the `account-deletion.spec.ts` convention;
 * combining them with `.*` doesn't work because the captured entry is
 * multi-line and `.` doesn't cross `\n`.
 */
function allowTrialRateLimitErrors(page: Page): void {
  expectApiErrors(page, [
    /429 Too Many Requests POST .*\/chat\/trial/,
    /"code":"TRIAL_LIMIT_REACHED"/,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: .*status of 429/]);
}

/** The identity a seeded selection and a row lookup both need. */
interface CatalogModelRef {
  readonly id: string;
  readonly name: string;
}

/**
 * Zustand persist key and schema version of the model store
 * (`apps/web/src/stores/model.ts`). Writing that key is how a visitor really
 * arrives holding a premium pin: the app persists the selection, and a session
 * that ends by expiry leaves the stored selection behind. No UI a trial visitor
 * can reach recreates it — a premium row answers their click with the paywall.
 */
const MODEL_STORAGE_KEY = 'hushbox-model-storage';
const MODEL_STORAGE_VERSION = 1;

/**
 * Two premium text models from the served catalog — the live snapshot, so the
 * ids are discovered rather than pinned. The first stands in for the visitor's
 * persisted pin; the second is a premium row nothing selected, which is what
 * separates "the paywall still stands" from "only the pinned row is locked".
 */
async function premiumTextModels(
  request: APIRequestContext
): Promise<[CatalogModelRef, CatalogModelRef]> {
  const response = await request.get(`${apiUrl}/models`);
  await expectOkResponse(response, 'models read');
  const { models, premiumModelIds } = (await response.json()) as ModelsListResponse;
  const premium = new Set(premiumModelIds);
  const [pinned, unpinned] = models.filter(
    (model) => model.modality === 'text' && premium.has(model.id)
  );
  if (pinned === undefined || unpinned === undefined) {
    throw new Error('the served catalog carries fewer than two premium text models');
  }
  return [
    { id: pinned.id, name: pinned.name },
    { id: unpinned.id, name: unpinned.name },
  ];
}

/**
 * Put the model the visitor arrives holding into the store's persisted state,
 * before the app boots. Only `selections` is written: every other field the
 * store persists keeps its default, so the seed states the arrangement under
 * test and nothing else.
 */
async function seedPersistedTextSelection(page: Page, model: CatalogModelRef): Promise<void> {
  await page.addInitScript(
    ({ storageKey, version, entry }) => {
      globalThis.localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: { selections: { text: [entry], image: [], audio: [], video: [] } },
          version,
        })
      );
    },
    { storageKey: MODEL_STORAGE_KEY, version: MODEL_STORAGE_VERSION, entry: model }
  );
}

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'Every trial test shares the one localhost IP whose per-day trial cap is the behaviour under test, so the suite must hold exactly one project at a time. The cap is server-side and engine-independent.',
});

test.describe('Trial Chat', SPEC_MATRIX, () => {
  // eslint-disable-next-line no-restricted-syntax -- serial: every trial test shares the same localhost IP whose per-day trial cap is the behavior under test; concurrent runs would consume each other's allowance.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const response = await idempotentDelete(request, `${apiUrl}/dev/trial-usage`);
    await expectOkResponse(response, 'dev trial-usage reset');
  });
  test.describe('New Chat Page', () => {
    test('displays new chat UI with focused prompt input', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();

      await expect(chatPage.promptInput).toBeEnabled({ timeout: TIMEOUTS.MODAL });
      await expect(chatPage.promptInput).toBeFocused({ timeout: TIMEOUTS.QUICK });
    });
  });

  test.describe('Chat Streaming', () => {
    test('trial user can send message and receive response', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      // Regression guard: a web-search preference persists across sign-out and the
      // trial toggle can't clear it. It must not reserve the worst-case search cost
      // (≈5.75¢, far above the 1¢ trial cap) and gate trial sends with
      // "This message is too costly for the free trial."
      await unauthenticatedPage.addInitScript((storageKey) => {
        globalThis.localStorage.setItem(
          storageKey,
          JSON.stringify({ state: { webSearchEnabled: true }, version: 0 })
        );
      }, WEB_SEARCH_STORAGE_KEY);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const testMessage = `Trial test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await expect(unauthenticatedPage).toHaveURL('/chat/trial');
      await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
      await chatPage.expectMessageVisible(testMessage);
      await chatPage.waitForAIResponse(testMessage);
      await chatPage.expectAssistantMessageContains('Echo:');

      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageInput).toBeEnabled();
    });

    test('trial user can have multi-turn conversation', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const firstMessage = `Trial first ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(firstMessage);
      await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
      await chatPage.waitForAIResponse(firstMessage);

      const secondMessage = `Trial second ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(secondMessage);
      await chatPage.expectMessageVisible(secondMessage);
    });
  });

  test.describe('Free Preview Count', () => {
    test.beforeEach(async ({ request }) => {
      const response = await idempotentDelete(request, `${apiUrl}/dev/trial-usage`);
      await expectOkResponse(response, 'dev trial-usage reset');
    });

    test('states the messages left once the first one is spent', async ({
      unauthenticatedPage,
    }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      const remaining = unauthenticatedPage.getByTestId(
        TEST_ID_BUILDERS.budgetMessage(TRIAL_REMAINING_MESSAGE_ID)
      );

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();
      // A visitor still holding the whole allowance is told nothing.
      await expect(remaining).toBeHidden();

      const message = `Remaining count ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(message);
      await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
      await chatPage.waitForAIResponse(message);

      await expect(remaining).toHaveText(/^4 messages left in your free preview today\./, {
        timeout: TIMEOUTS.ASSERT,
      });
    });
  });

  test.describe('Rate Limiting', () => {
    test.beforeEach(async ({ request }) => {
      const response = await idempotentDelete(request, `${apiUrl}/dev/trial-usage`);
      await expectOkResponse(response, 'dev trial-usage reset');
    });

    test('shows rate limit message after 5 messages', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      allowTrialRateLimitErrors(unauthenticatedPage);

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      for (let index = 1; index <= 5; index++) {
        const message = `Rate limit test ${String(index)} ${String(Date.now())}`;
        if (index === 1) {
          await chatPage.sendNewChatMessage(message);
          await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
        } else {
          await chatPage.sendFollowUpMessage(message);
        }
        await chatPage.waitForAIResponse(message, TIMEOUTS.MEDIA_DECODE);
      }

      // Don't use sendFollowUpMessage - rate limiting prevents input from clearing
      const rateLimitMessage = `Rate limit trigger ${String(Date.now())}`;
      await chatPage.messageInput.fill(rateLimitMessage);
      await chatPage.messageInput.press('Enter');

      // Rate limit shows inline message instead of modal
      await expect(unauthenticatedPage.getByText(TRIAL_LIMIT_MESSAGE)).toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });
    });

    test('input is disabled after rate limit', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      allowTrialRateLimitErrors(unauthenticatedPage);

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      for (let index = 1; index <= 5; index++) {
        const message = `Disable test ${String(index)} ${String(Date.now())}`;
        if (index === 1) {
          await chatPage.sendNewChatMessage(message);
          await expect(chatPage.messageList).toBeVisible({ timeout: TIMEOUTS.MODAL });
        } else {
          await chatPage.sendFollowUpMessage(message);
        }
        await chatPage.waitForAIResponse(message, TIMEOUTS.MEDIA_DECODE);
      }

      // Don't use sendFollowUpMessage - rate limiting prevents input from clearing
      const rateLimitMessage = `Disable trigger ${String(Date.now())}`;
      await chatPage.messageInput.fill(rateLimitMessage);
      await chatPage.messageInput.press('Enter');

      await expect(unauthenticatedPage.getByText(TRIAL_LIMIT_MESSAGE)).toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });
      await expect(chatPage.messageInput).toBeDisabled();
    });
  });

  test.describe('Premium Model Access', () => {
    test('shows signup modal when trial user clicks premium model', async ({
      unauthenticatedPage,
    }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      const signupModal = unauthenticatedPage.getByTestId(TEST_IDS.signupModal);

      await chatPage.goto();

      const modelChip = unauthenticatedPage.getByTestId(TEST_IDS.modelSelectorButton);
      await expect(modelChip).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await modelChip.click();

      const modal = unauthenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });

      const premiumModel = chatPage.lockedModelItems().first();
      await expect(premiumModel).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      // Single click on a premium row triggers onPremiumClick now that the
      // dual-zone (focus vs commit) pattern was removed in the picker rewrite.
      await premiumModel.getByRole('button').first().click();

      await expect(signupModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
      const heading = signupModal.getByRole('heading');
      await expect(heading).toContainText(/premium/i);
    });

    /**
     * A visitor arriving with a premium model still in their persisted
     * selection once found the whole picker greyed: every candidate row was
     * graded as if the click ADDED it beside that pin, so the one refused pin
     * dressed every other row in its refusal and there was no row left to
     * click — dropping the pin is a multi-mode affordance, so single mode had
     * no escape. A single-mode click REPLACES the selection, and the rows are
     * graded as that click leaves them.
     */
    test('trial user holding a premium pin can still pick a model', async ({
      unauthenticatedPage,
      request,
    }) => {
      const [pinnedPremium, unpinnedPremium] = await premiumTextModels(request);
      await seedPersistedTextSelection(unauthenticatedPage, pinnedPremium);

      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();
      await chatPage.openModelSelector();
      await chatPage.switchPickerMode('single');
      // A row's verdict is the affordability producer's, and until it has run
      // every row renders neutral — which is the same DOM a passing assertion
      // about a selectable row would see.
      await chatPage.waitForAffordabilitySettled();

      const pinnedRow = unauthenticatedPage.getByTestId(
        TEST_ID_BUILDERS.modelItem(pinnedPremium.id)
      );
      // The arrangement under test really landed: the picker opened on the
      // persisted premium model, not on the default one.
      await expect(pinnedRow).toHaveAttribute('data-selected', 'true');

      // The paywall still stands, and each premium row names its own reason
      // rather than a neighbour's.
      const premiumRefusal = noticeText('premium_requires_account');
      const unpinnedRow = unauthenticatedPage.getByTestId(
        TEST_ID_BUILDERS.modelItem(unpinnedPremium.id)
      );
      await expect(pinnedRow).toHaveAttribute('data-unavailable', 'true');
      await expect(pinnedRow.getByRole('button').first()).toHaveAccessibleDescription(
        premiumRefusal
      );
      await expect(unpinnedRow).toHaveAttribute('data-unavailable', 'true');
      await expect(unpinnedRow.getByRole('button').first()).toHaveAccessibleDescription(
        premiumRefusal
      );

      // A row with no premium problem of its own is still offered.
      const selectableRows = chatPage.nonPremiumModelItems();
      await expect(selectableRows).not.toHaveCount(0);
      const target = selectableRows.first();
      const targetTestId = await target.getAttribute('data-testid');
      if (!targetTestId) throw new Error('a selectable model row carries no data-testid');
      await target.getByRole('button').first().click();

      const modal = unauthenticatedPage.getByTestId(TEST_IDS.modelSelectorModal);
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      // The click replaced the selection rather than adding to it: the clicked
      // row is the whole of it, and the premium pin is gone from it.
      await chatPage.openModelSelector();
      await expect(unauthenticatedPage.getByTestId(targetTestId)).toHaveAttribute(
        'data-selected',
        'true'
      );
      await expect(pinnedRow).toHaveAttribute('data-selected', 'false');
      await expect(chatPage.selectedModelItems()).toHaveCount(1);
    });
  });
});
