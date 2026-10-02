import { ACCESSIBILITY_PREFERENCES_DEFAULTS, TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION,
  TTS_MODEL_ID,
  modelWeightsRoutePath,
} from '@hushbox/shared/model-weights';
import { test, expect, type APIRequestContext, type Page } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage, PromptPredictionPage, SidebarPage } from '../pages';
import {
  GLYPH_ALIGNMENT_TOLERANCE,
  LAYOUT_PROPERTIES,
  type Box,
  type LayoutProperties,
} from '../pages/prompt-prediction.page.js';
import { armPromptPrediction } from '../helpers/prompt-prediction.js';
import { idempotentPut } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { waitForChatSpeaking } from '../helpers/page-signals.js';
import { requireEnv } from '../helpers/env.js';
import { settledReasoningLabel } from '../helpers/reasoning-row.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { E2E_MODELS } from '../../scripts/lib/playwright/model-ids.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The server's own record of a conversation, read back after a sidebar action
 * so the assertion rests on what was stored rather than on what was painted.
 * `title` is the stored ciphertext: the listing never returns plaintext, so a
 * title is comparable against another read of itself and not against the text
 * a test typed.
 */
async function storedConversation(
  request: APIRequestContext,
  conversationId: string
): Promise<{ id: string; title: string } | undefined> {
  const response = await request.get('/conversations?limit=100');
  await expectOkResponse(response, 'conversation list read');
  const body = (await response.json()) as { conversations: { id: string; title: string }[] };
  return body.conversations.find((conversation) => conversation.id === conversationId);
}

/**
 * The defect class this run exists to guard against — a bundler
 * miscompiling the on-device TTS runtime — is identical on every engine (it
 * lives in the worker bundle's compiled output, not in engine-specific
 * rendering), and the ~92 MB model fetch is the cost driver. Narrowing to
 * one project, as `e2e/marketing-roadmap.spec.ts`'s equivalent blog case
 * does, keeps that download to once per run instead of once per engine.
 */
const CHAT_SPEAKING_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'The defect class is bundler-compiled worker output, identical on every engine, and the ~92 MB model fetch is the cost driver — narrowing to one project keeps that cost to once per run.',
});

/** Where every on-device model object is served from, addressed through the
 * shared artifact contract so this spec cannot name an address the app does
 * not use — mirrors `e2e/marketing-roadmap.spec.ts`'s `MODEL_BASE_URL`. */
const MODEL_BASE_URL = new URL(
  modelWeightsRoutePath(TTS_MODEL_ID, MODEL_WEIGHTS_VERSION, ''),
  requireEnv('VITE_API_URL')
).href;

/**
 * A reasoning-capable text model (structured `reasoning` catalog metadata →
 * the effort chip renders for it). Validated present in the live catalog at
 * `e2e:prepare`, like every E2E model id.
 */
const REASONING_MODEL_ID = E2E_MODELS.text[1];

const SETTLED_REASONING_LABEL = settledReasoningLabel('high');

test.describe('Chat Functionality', SPEC_MATRIX, () => {
  test.describe('New Chat', () => {
    test('displays UI, creates conversation, receives response, appears once in sidebar', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const sidebar = new SidebarPage(authenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();

      const uniqueId = `combined-new-${String(Date.now())}`;
      const testMessage = `Test ${uniqueId}`;
      await chatPage.sendNewChatMessage(testMessage);

      await chatPage.waitForConversation();
      await chatPage.expectMessageVisible(testMessage);

      await chatPage.waitForAIResponse(testMessage);
      await chatPage.expectAssistantMessageContains('Echo:');

      await expect
        .poll(() => sidebar.countConversationsWithText(uniqueId), { timeout: TIMEOUTS.MODAL })
        .toBe(1);
    });
  });

  test.describe('Existing Conversation', () => {
    test('displays messages and accepts followup', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageList).toBeVisible();

      const followupMessage = `Follow-up ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(followupMessage);
      await chatPage.expectMessageVisible(followupMessage);
    });

    test('send button re-enables after streaming completes', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const firstMessage = `First followup ${String(Date.now())}`;
      await chatPage.messageInput.fill(firstMessage);

      await expect(chatPage.sendButton).toBeEnabled();
      await chatPage.sendButton.click();

      await chatPage.expectMessageVisible(firstMessage);
      await chatPage.waitForAIResponse(firstMessage);

      const secondMessage = `Second followup ${String(Date.now())}`;
      await chatPage.messageInput.fill(secondMessage);
      await chatPage.sendButton.click();

      await chatPage.expectMessageVisible(secondMessage);
      await chatPage.waitForAIResponse(secondMessage);
      // Button is disabled after streaming when input is empty (correct behavior)
    });
  });

  test.describe('Sidebar Actions', () => {
    // eslint-disable-next-line no-restricted-syntax -- serial: rename/delete/cancel-delete mutate the same shared Alice sidebar conversation list; concurrent runs cross-talk on the shared authenticated page.
    test.describe.configure({ mode: 'serial' });

    test('shows conversation in sidebar', async ({ authenticatedPage, testConversation }) => {
      const sidebar = new SidebarPage(authenticatedPage);
      await sidebar.expectConversationVisible(testConversation.id);
    });

    test('can rename conversation via dropdown menu', async ({
      authenticatedPage,
      authenticatedRequest,
      testConversation,
    }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      const before = await storedConversation(authenticatedRequest, testConversation.id);
      expect(
        before,
        'the conversation is not in the listing the read-backs below use'
      ).toBeDefined();

      await sidebar.renameConversation(testConversation.id, 'My Renamed Conversation');
      await sidebar.expectConversationTitle(testConversation.id, 'My Renamed Conversation');

      // The stored title is ciphertext, so what a server-side read can prove is
      // that the title field was rewritten — not the plaintext it now holds,
      // which only the sidebar assertion above establishes.
      const after = await storedConversation(authenticatedRequest, testConversation.id);
      expect(after?.title).toBeDefined();
      expect(after?.title).not.toBe(before?.title);
    });

    test('can delete conversation via dropdown menu', async ({
      authenticatedPage,
      authenticatedRequest,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const sidebar = new SidebarPage(authenticatedPage);

      expect(
        await storedConversation(authenticatedRequest, testConversation.id),
        'the conversation is not in the listing, so its later absence would prove nothing'
      ).toBeDefined();

      // Delete refreshes only the conversation list; it no longer cascades a
      // refetch into the deleted conversation's detail/messages queries, so no
      // 404 fires against the gone id — no error opt-out is needed.
      await sidebar.deleteConversation(testConversation.id);

      await expect(authenticatedPage).toHaveURL('/chat');
      await chatPage.expectNewChatPageVisible();

      expect(await storedConversation(authenticatedRequest, testConversation.id)).toBeUndefined();
    });

    test('can cancel delete confirmation', async ({
      authenticatedPage,
      authenticatedRequest,
      testConversation,
    }) => {
      const sidebar = new SidebarPage(authenticatedPage);

      await sidebar.cancelDelete(testConversation.id);

      await expect(authenticatedPage).toHaveURL(testConversation.url);

      // The URL assertion above resolves on a value that was already true, so a
      // delete that fired late would pass it; the stored row is what rules that out.
      expect(await storedConversation(authenticatedRequest, testConversation.id)).toBeDefined();
    });
  });

  test.describe('AI Response Streaming', () => {
    test('displays streaming AI response with reasoning effort after sending message', async ({
      authenticatedPage,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      await test.step('chip hidden while only non-reasoning models are selected', async () => {
        // The image-generation selection carries no reasoning metadata, so the
        // effort chip must slide out entirely.
        await chatPage.switchToImageMode();
        await expect(chatPage.effortChip()).not.toBeVisible();
        await chatPage.switchToTextMode();
      });

      await test.step('select a reasoning model and the High effort level', async () => {
        await chatPage.selectSingleModel(REASONING_MODEL_ID);
        await expect(chatPage.effortChip()).toBeVisible();
        await chatPage.selectReasoningEffort('High');
      });

      const testMessage = `Echo test ${String(Date.now())}`;
      let conversationId = '';

      await test.step('mid-turn: live reasoning shows its one-liner and no thoughts', async () => {
        // Live reasoning renders one line, naming the model, and nothing below
        // it. A reasoning turn's hold parks the stream at exactly that phase,
        // every reasoning delta emitted and the first answer delta withheld, so it
        // stays open on a barrier the test resolves rather than for a stretch of
        // wall clock.
        await chatPage.holdPrimaryStreamForNextSends();
        await chatPage.sendNewChatMessage(testMessage);
        conversationId = await chatPage.waitForConversation();
        await chatPage.waitForStreamingActive();

        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        const modelName = await assistant.getByTestId(TEST_IDS.modelNametag).textContent();
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureStatus)).toHaveText(
          `${modelName ?? ''} is thinking`
        );
        // Every reasoning delta has arrived at the park, so a thought on screen
        // anywhere in the message would show here.
        await expect(assistant).not.toContainText('Reading the request');
      });

      await test.step('settled — one closed row wearing the rung it ran at', async () => {
        // Clear the hold before releasing, so nothing sent after this step parks
        // with no release; the run already in flight keeps the barrier it holds.
        await chatPage.stopHoldingStreams();
        await chatPage.releaseHeldStream(conversationId);
        await chatPage.waitForAIResponse(testMessage);
        await chatPage.expectAssistantMessageContains('Echo:');
        await chatPage.expectMessageCostVisible();

        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        // The live one-liner belongs to the reasoning phase alone, and a closed
        // disclosure holds no trace: a settled row is one line of chrome with
        // nothing resting under it.
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureStatus)).toHaveCount(0);
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toHaveCount(0);
        const toggle = disclosure.getByTestId(TEST_IDS.thinkingDisclosureToggle);
        await expect(toggle).toHaveText(SETTLED_REASONING_LABEL);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      });

      await test.step('expand the row — the whole trace', async () => {
        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        await disclosure.getByTestId(TEST_IDS.thinkingDisclosureToggle).click();
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toContainText(
          'Ready to answer now.'
        );
      });

      await test.step('reload — persisted thoughts and rung still render per message', async () => {
        await authenticatedPage.goto(`/chat/${conversationId}`, {
          waitUntil: 'domcontentloaded',
        });
        await chatPage.waitForConversationLoaded();

        const assistant = chatPage.messagesByRole('assistant').last();
        const disclosure = chatPage.thinkingDisclosureFor(assistant);
        await expect(disclosure).toBeVisible();
        const toggle = disclosure.getByTestId(TEST_IDS.thinkingDisclosureToggle);
        await expect(toggle).toHaveText(SETTLED_REASONING_LABEL);
        await toggle.click();
        await expect(disclosure.getByTestId(TEST_IDS.thinkingDisclosureContent)).toContainText(
          'Reading the request'
        );
      });
    });
  });

  test.describe('Message Layout', () => {
    test('long unbroken strings do not push previous messages off screen', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const firstMessage = chatPage.messageList
        .locator(`[data-testid="${TEST_IDS.messageItem}"]`)
        .first();
      const initialBoundingBox = await firstMessage.boundingBox();
      expect(initialBoundingBox).not.toBeNull();

      const longString = 'test'.repeat(50);
      await chatPage.sendFollowUpMessage(longString);

      await chatPage.waitForAIResponse(longString);

      const { scrollWidth, clientWidth } = await chatPage.getDocumentDimensions();
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      await expect(firstMessage).toBeAttached();

      // Re-issue scrollToTop each poll, not once: under a saturated mobile engine
      // a late post-stream re-render (Virtuoso re-measuring the long message's
      // height, the toolbar mounting) can re-pin the list to the bottom after a
      // single scroll, snapping the just-revealed first message back off-screen.
      // Keep scrolling up — what a user does — until it holds in view. A first
      // message that can never be scrolled into view (a real regression) never
      // satisfies the check and the poll times out.
      await expect(async () => {
        await chatPage.scrollToTop();
        await expect(firstMessage).toBeInViewport({ ratio: 0.5, timeout: TIMEOUTS.QUICK });
      }).toPass({ timeout: TIMEOUTS.STREAM_SATURATED });
    });

    test('the user row and the answer keep their ids when the stored rows replace the live ones', async ({
      authenticatedPage,
      testConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);
      const prompt = `Kept rows ${String(Date.now())}`;

      await chatPage.holdPrimaryStreamForNextSends();
      await chatPage.sendFollowUpMessage(prompt);
      await chatPage.waitForStreamingActive();
      const liveUser = chatPage.messagesByRole('user').last();
      const liveAnswer = chatPage.messagesByRole('assistant').last();
      const userId = await liveUser.getAttribute(TEST_SIGNALS.messageId);
      const answerId = await liveAnswer.getAttribute(TEST_SIGNALS.messageId);

      await chatPage.stopHoldingStreams();
      await chatPage.releaseHeldStream(testConversation.id);
      await chatPage.waitForAIResponse(prompt);
      const storedAnswer = chatPage.messagesByRole('assistant').last();
      await expect(storedAnswer.getByTestId(TEST_IDS.messageCost)).toBeVisible({
        timeout: TIMEOUTS.STREAM_SATURATED,
      });

      await expect(chatPage.messagesByRole('user').last()).toHaveAttribute(
        TEST_SIGNALS.messageId,
        userId ?? ''
      );
      await expect(storedAnswer).toHaveAttribute(TEST_SIGNALS.messageId, answerId ?? '');
    });

    test('long messages wrap properly without horizontal overflow', async ({
      authenticatedPage,
      testConversation: _testConversation,
    }, testInfo) => {
      const chatPage = new ChatPage(authenticatedPage);

      const longString = 'a'.repeat(500);
      await chatPage.sendFollowUpMessage(longString);
      await chatPage.waitForAIResponse(longString);

      const overflowingElements = await chatPage.findOverflowingElements();
      if (overflowingElements.length > 0) {
        await testInfo.attach('overflowing-elements', {
          body: JSON.stringify(overflowingElements, null, 2),
          contentType: 'application/json',
        });
      }

      expect(
        overflowingElements.length,
        `Found ${String(overflowingElements.length)} overflowing elements:\n${overflowingElements.join('\n')}`
      ).toBe(0);

      const messageItem = chatPage.messageList
        .locator(`[data-testid="${TEST_IDS.messageItem}"]`)
        .last();
      await expect(messageItem).toBeVisible();
      const [messageBox, viewportWidth] = await Promise.all([
        messageItem.boundingBox(),
        chatPage.getViewportWidth(),
      ]);

      if (messageBox === null) throw new Error('Expected last message bounding box');
      expect(messageBox.width).toBeLessThanOrEqual(viewportWidth);
      expect(messageBox.x + messageBox.width).toBeLessThanOrEqual(viewportWidth);
    });
  });
});

/**
 * The chat surface's own regression guard for on-device read-aloud,
 * separate from `e2e/marketing-roadmap.spec.ts`'s blog case: chat wires the
 * TTS runtime through its own streaming feeder
 * (`apps/web/src/lib/tts/chat-tts-stream.ts`), which no blog test reaches.
 * Runs the real bundler-compiled worker to actual audio, gated on
 * `data-chat-speaking` — set only once the TTS engine's own `onAudioStart`
 * fires (after `source.start()` returns), never on the earlier moment a
 * message is merely chosen to speak.
 */
test.describe('Chat read-aloud speaks', CHAT_SPEAKING_MATRIX, () => {
  test('reads a real streamed reply aloud on-device', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    // The config-wide per-test timeout is shorter than the model
    // download+synthesis budget this case needs, mirroring the blog case's
    // own override.
    test.setTimeout(TIMEOUTS.XXLONG);

    // This suite reuses named personas across runs, so a prior run against
    // this account may have left ttsEnabled:true server-side. The toggle
    // below only downloads the on-device model on its "first-time enable"
    // branch (local ttsEnabled currently false); a stale true would skip
    // that branch and this test would never gate on real audio. Resetting
    // to the schema defaults first makes the toggle deterministic
    // regardless of run history. The store is last-writer-wins on
    // `updatedAt` (an equal stamp wins), so this must read the live clock
    // to beat whatever real instant the persona's last write carries.
    const resetResponse = await idempotentPut(
      authenticatedRequest,
      '/account/preferences/accessibility',
      {
        data: {
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: new Date(Date.now()).toISOString(),
        },
      }
    );
    await expectOkResponse(resetResponse, 'accessibility preferences reset');

    const modelRequests: string[] = [];
    authenticatedPage.on('request', (request) => {
      if (request.url().startsWith(MODEL_BASE_URL)) modelRequests.push(request.url());
    });

    await authenticatedPage.goto('/accessibility', { waitUntil: 'domcontentloaded' });
    const chatAloudToggle = authenticatedPage.getByRole('button', {
      name: 'Read chat replies aloud: Off',
    });
    // The toggle writes locally first, then debounces a PUT to the account's
    // stored preferences (`useAccessibilitySync`). Waiting for that PUT's
    // response, not just the label flipping to "On", is what makes the
    // enabled state (and the on-device model it just downloaded) survive
    // the client-side navigation to chat below.
    const preferencesSynced = authenticatedPage.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith('/account/preferences/accessibility') &&
        response.status() === 200
    );
    await chatAloudToggle.click();
    await expect(
      authenticatedPage.getByRole('button', { name: 'Read chat replies aloud: On' })
    ).toBeVisible({ timeout: TIMEOUTS.TTS_SPEAK });
    await preferencesSynced;

    // A client-side route change (TanStack Router's navigate), not
    // chatPage.goto()'s full page.goto(): a hard navigation reloads the SPA
    // and tears down the TTS engine singleton (module state + its worker)
    // that was just loaded, forcing a second cold load the near-instant
    // chat reply below easily outraces.
    await authenticatedPage.getByRole('link', { name: 'New Chat' }).click();
    const chatPage = new ChatPage(authenticatedPage);
    await expect(chatPage.newChatPage).toBeVisible();
    const testMessage = `Echo test ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(testMessage);
    await chatPage.waitForAIResponse(testMessage);

    await waitForChatSpeaking(authenticatedPage, TIMEOUTS.TTS_SPEAK);

    expect(modelRequests.length).toBeGreaterThan(0);
    await expect(authenticatedPage.getByRole('alert')).toHaveCount(0);

    // End the read through the UI, matching the blog case's own teardown
    // pattern instead of leaving it to context teardown.
    const stopReading = authenticatedPage.getByRole('button', {
      name: 'Stop reading message aloud',
    });
    await expect(stopReading).toBeVisible();
    await stopReading.click();
    await expect(stopReading).toBeHidden();
  });
});

/**
 * The composer's sentence-completion hint.
 *
 * Everything asserted below is a fact about where things land on a laid-out
 * page: which pixels the hint occupies, whether the composer moved, whether the
 * textarea has outgrown its own box. The unit tier cannot see any of it — its
 * DOM implements no layout, so every height it reports is zero — which is why
 * these checks live here and why they measure rather than re-derive.
 *
 * The predictions come from a deterministic predictor the end-to-end build
 * carries, armed per page. No test downloads or runs a model.
 */
const PREDICTION_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'desktop' });

/**
 * Touch is the axis here: the accept gesture is a `pointerdown` the composer
 * cancels to keep focus, and whether a user agent honours that for a touch
 * pointer is exactly the kind of thing that differs between engines.
 */
const PREDICTION_TOUCH_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'mobile' });

/** Enough words typed for the composer to have a clause worth continuing. */
const TYPED_SENTENCE = 'the quick brown fox jumps';

/**
 * Long enough to wrap several times on a desktop composer without filling it,
 * and far past its seven-line maximum once the window narrows — which is what
 * lets a resize alone push the composer into scrolling its own text.
 */
const WRAPPING_SENTENCE = `${TYPED_SENTENCE} `.repeat(18).trim();

/** A window narrow enough to wrap the same text past the composer's maximum height. */
const NARROW_VIEWPORT = { width: 380, height: 720 };

/** Type-scale increase large enough that no rounding could account for it. */
const FONT_SCALE_FACTOR = 1.5;

const ALL_EDGES = ['x', 'y', 'width', 'height'] as const;

/**
 * The prediction overlay is pinned to the composer's top and full width but
 * never to its bottom, so it sizes to the mirrored text while the composer
 * holds a minimum height of its own — the two boxes coincide on every edge but
 * `height` by design (`apps/web/src/components/chat/input/prediction-overlay.tsx`).
 */
const EDGES_LESS_HEIGHT = ['x', 'y', 'width'] as const;

function expectSameBox(
  actual: Box,
  expected: Box,
  what: string,
  edges: readonly (keyof Box)[]
): void {
  for (const edge of edges) {
    expect(
      Math.abs(actual[edge] - expected[edge]),
      `${what} moved on its ${edge}: ${String(expected[edge])} → ${String(actual[edge])}`
    ).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);
  }
}

/** Matches a `getComputedStyle` value already resolved to a pixel length, e.g. `19.125px`. */
const RESOLVED_PIXEL_LENGTH = /^-?\d+(\.\d+)?px$/;

/**
 * A resolved length can differ by a sub-pixel fraction between two
 * independently rounded reads of textually identical CSS — the same source
 * of noise `expectSameBox` tolerates on box edges applies equally to a
 * padding or line-height value read off a `<textarea>` versus a generic
 * element. Every other property here is a font or a keyword (`normal`,
 * `break-word`, a font-family list): those have no rounding step, so any
 * difference is the mirror and the composer actually disagreeing.
 */
function expectSameLayoutProperties(actual: LayoutProperties, expected: LayoutProperties): void {
  for (const property of LAYOUT_PROPERTIES) {
    const actualValue = actual[property];
    const expectedValue = expected[property];
    if (RESOLVED_PIXEL_LENGTH.test(actualValue) && RESOLVED_PIXEL_LENGTH.test(expectedValue)) {
      expect(
        Math.abs(Number.parseFloat(actualValue) - Number.parseFloat(expectedValue)),
        `${property} resolved to ${actualValue} vs ${expectedValue}`
      ).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);
    } else {
      expect(actualValue, property).toEqual(expectedValue);
    }
  }
}

interface ArmedChat {
  readonly chatPage: ChatPage;
  readonly prediction: PromptPredictionPage;
}

/**
 * The new-chat surface with the stub predictor answering on it.
 *
 * Arming writes its key from an init script, so it has to happen before the
 * navigation that loads the app — which is the ordering every test below needs
 * and none of them should be free to get wrong on its own.
 */
async function openArmedChat(page: Page): Promise<ArmedChat> {
  const chatPage = new ChatPage(page);
  const prediction = new PromptPredictionPage(page);
  await armPromptPrediction(page);
  await chatPage.goto();
  await chatPage.waitForAppStable();
  return { chatPage, prediction };
}

test.describe('Prompt Prediction', PREDICTION_MATRIX, () => {
  test('sends the typed text alone, and offers no candidate list inside a conversation', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    const prediction = new PromptPredictionPage(authenticatedPage);
    await armPromptPrediction(authenticatedPage);
    await chatPage.gotoConversation(testConversation.id);
    await chatPage.waitForConversationLoaded();

    await chatPage.messageInput.fill(TYPED_SENTENCE);
    const hint = await prediction.hintText();
    // A conversation gets the hint at the caret and nothing else — the list of
    // rivals belongs to the page that has room under the composer for it.
    await prediction.expectListClosed();
    // The hint is drawn over the composer, never into it.
    await expect(chatPage.messageInput).toHaveValue(TYPED_SENTENCE);

    await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    await chatPage.messageInput.press('Enter');
    await expect(chatPage.messageInput).toHaveValue('');

    // An exact match: a message carrying the continuation as well would not be
    // this string, which is the one failure that would corrupt what a user said.
    await chatPage.expectMessageVisible(TYPED_SENTENCE);
    await chatPage.assertMessageNotVisible(`${TYPED_SENTENCE}${hint}`);
  });

  test('lets Tab move focus on while no hint shows, and takes the hint once one does', async ({
    authenticatedPage,
  }) => {
    const { chatPage, prediction } = await openArmedChat(authenticatedPage);

    // An empty composer has no clause to continue, so nothing is on offer and
    // Tab has to keep its ordinary meaning. A composer that swallowed it here
    // would be a keyboard trap.
    await chatPage.promptInput.focus();
    await expect(chatPage.promptInput).toBeFocused();
    await prediction.expectHintHidden();
    await chatPage.promptInput.press('Tab');
    await expect(chatPage.promptInput).not.toBeFocused();

    await chatPage.promptInput.fill(TYPED_SENTENCE);
    const hint = await prediction.hintText();
    await chatPage.promptInput.press('Tab');
    await expect(chatPage.promptInput).toHaveValue(`${TYPED_SENTENCE}${hint}`);
    await expect(chatPage.promptInput).toBeFocused();
  });

  test('holds the composer still while the candidate list opens beneath it', async ({
    authenticatedPage,
  }) => {
    const { chatPage, prediction } = await openArmedChat(authenticatedPage);

    await chatPage.promptInput.fill(TYPED_SENTENCE);
    await prediction.expectListOpen();

    const openComposer = await prediction.boxOf(chatPage.promptInput, 'the composer');
    const openInspiration = await prediction.boxOf(
      chatPage.suggestionChips,
      'the inspiration label'
    );
    const spacer = await prediction.boxOf(prediction.suggestionSpacer, 'the reserved list space');
    const greeting = await prediction.boxOf(prediction.greetingBesideSpacer, 'the greeting');

    // The reserved height only holds the composer still while it sits flush
    // against the greeting: any spacing introduced between the two would push
    // the column further than the list below the composer pushes it back.
    expect(spacer.height).toBeGreaterThan(0);
    expect(
      Math.abs(greeting.y - (spacer.y + spacer.height)),
      'the reserved list space and the greeting have vertical spacing between them'
    ).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);

    await chatPage.promptInput.fill('');
    await prediction.expectListClosed();

    const closedComposer = await prediction.boxOf(chatPage.promptInput, 'the composer');
    const closedInspiration = await prediction.boxOf(
      chatPage.suggestionChips,
      'the inspiration label'
    );

    expectSameBox(closedComposer, openComposer, 'the composer', ALL_EDGES);
    // What the list does move is everything below it, by exactly its own height.
    expect(
      Math.abs(openInspiration.y - closedInspiration.y - spacer.height),
      'the inspiration block did not move down by the height the list took'
    ).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);
  });

  test('draws the hint at the end of the typed text, and keeps it there as the type scale grows', async ({
    authenticatedPage,
  }) => {
    const { chatPage, prediction } = await openArmedChat(authenticatedPage);

    await chatPage.promptInput.fill(TYPED_SENTENCE);
    await prediction.expectHintVisible();

    // The mirror places the hint by repeating the composer's own metrics and
    // letting the browser break the lines. Nothing measures a caret, so these
    // being equal is the whole mechanism.
    const [composerLayout, mirrorLayout] = await Promise.all([
      prediction.layoutPropertiesOf(chatPage.promptInput),
      prediction.layoutPropertiesOf(prediction.overlay),
    ]);
    expectSameLayoutProperties(mirrorLayout, composerLayout);

    const atDefaultScale = await prediction.hintOffsetFromTypedText();
    expect(Math.abs(atDefaultScale.dx)).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);
    expect(Math.abs(atDefaultScale.dy)).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);

    // Every other reading here is taken from inside the mirror, so all of them
    // hold wherever on the page the mirror happens to sit. The overlay covering
    // the composer is what makes them statements about where the user sees the
    // prediction rather than about the mirror's own interior.
    const [initialOverlayBox, composerBox] = await prediction.boxesOf(
      prediction.overlay,
      chatPage.promptInput,
      'the prediction overlay'
    );
    expectSameBox(initialOverlayBox, composerBox, 'the prediction overlay', EDGES_LESS_HEIGHT);

    const composerFontSize = await prediction.fontSizeOf(chatPage.promptInput);
    const composerHeight = composerBox.height;
    await prediction.growRootFontSize(FONT_SCALE_FACTOR);
    await expect
      .poll(() => prediction.fontSizeOf(chatPage.promptInput))
      .toBeGreaterThan(composerFontSize);
    // The composer's own maximum height is set in `rem`, so a type-scale change
    // resizes the observed box rather than only its contents.
    await expect
      .poll(async () => {
        const { height } = await prediction.boxOf(chatPage.promptInput, 'the composer');
        return height;
      })
      .toBeGreaterThan(composerHeight);

    await prediction.expectHintVisible();
    // Re-taken at the larger root size, because a metric one side resolves in
    // `rem` and the other in absolute units agrees at exactly one scale — the
    // reading above would report them equal and this one would not. The
    // composer's own size is already known to have grown, so equality here is
    // the proof the mirror grew with it.
    const [scaledComposerLayout, scaledMirrorLayout] = await Promise.all([
      prediction.layoutPropertiesOf(chatPage.promptInput),
      prediction.layoutPropertiesOf(prediction.overlay),
    ]);
    expectSameLayoutProperties(scaledMirrorLayout, scaledComposerLayout);

    // Re-taken for the same reason as the metrics: the composer's box has
    // grown, and an overlay that stopped covering it would leave every reading
    // below still measuring an aligned hint drawn somewhere else. Read from one
    // synchronous browser-side evaluation (`boxesOf`, not two sequential
    // `boxOf` calls) — the type-scale change above triggers a page reflow that
    // two separate round trips can straddle, reporting the overlay and the
    // composer apart when at every instant they in fact agree.
    const [scaledOverlayBox, scaledComposerBox] = await prediction.boxesOf(
      prediction.overlay,
      chatPage.promptInput,
      'the prediction overlay'
    );
    expectSameBox(scaledOverlayBox, scaledComposerBox, 'the prediction overlay', EDGES_LESS_HEIGHT);

    const atLargerScale = await prediction.hintOffsetFromTypedText();
    expect(Math.abs(atLargerScale.dx)).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);
    expect(Math.abs(atLargerScale.dy)).toBeLessThan(GLYPH_ALIGNMENT_TOLERANCE);
  });

  test('withholds the hint once a narrower window makes the composer scroll its own text', async ({
    authenticatedPage,
  }) => {
    const { chatPage, prediction } = await openArmedChat(authenticatedPage);

    await chatPage.promptInput.fill(WRAPPING_SENTENCE);
    // A hint on screen is itself the proof the composer is not scrolling yet:
    // nothing renders while any suppression rule holds.
    await prediction.expectHintVisible();

    // The typed text never changes across the resize, so the held answer stays
    // valid for it. Suppression is then the only thing that can take it off
    // screen — and only a geometry reading taken after the window moved can
    // reach it.
    await authenticatedPage.setViewportSize(NARROW_VIEWPORT);
    await expect.poll(() => prediction.composerScrollsInternally(chatPage.promptInput)).toBe(true);
    await prediction.expectHintHidden();
  });
});

test.describe('Prompt Prediction on touch', PREDICTION_TOUCH_MATRIX, () => {
  test('takes the hint when it is tapped, leaving the composer focused', async ({
    authenticatedPage,
  }) => {
    const { chatPage, prediction } = await openArmedChat(authenticatedPage);

    await chatPage.promptInput.fill(TYPED_SENTENCE);
    const hint = await prediction.hintText();

    // The only accept gesture a touch user has. It works only while the user
    // agent honours the composer cancelling the press, which is what keeps the
    // keyboard up and the caret where it was.
    await prediction.hint.tap();
    await expect(chatPage.promptInput).toHaveValue(`${TYPED_SENTENCE}${hint}`);
    await expect(chatPage.promptInput).toBeFocused();
  });
});
