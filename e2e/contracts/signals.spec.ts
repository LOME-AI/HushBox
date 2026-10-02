import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEST_SIGNALS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages';
import { setupRealtimePair } from '../helpers/realtime.js';
import { nextTurnRequest } from '../helpers/turn-request.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

type SignalKey = keyof typeof TEST_SIGNALS;

/**
 * The signals this file drives into view, read off its own source rather than
 * listed beside it: a list says a signal is covered, and only the assertions
 * below make it so.
 */
const EXERCISED_HERE = new Set<string>(
  [
    ...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(/TEST_SIGNALS\.(\w+)/g),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
);

/**
 * The signals no case here drives, each against the e2e module that waits on
 * it. Both read-aloud signals are driven by cases that pay for a real
 * on-device model download, deliberately once on a single engine while this
 * spec runs on every engine, so duplicating them here would multiply the cost
 * that narrowing exists to avoid; the sign-out signal is waited on by the
 * shared logout helper, so it is exercised wherever a logout runs rather than
 * in a case of its own; the welcome cost signals are driven by the spec that
 * owns that section, which reads both the ready and the failed catalog.
 */
const EXERCISED_ELSEWHERE = {
  blogSpeaking: 'helpers/page-signals.ts',
  chatSpeaking: 'helpers/page-signals.ts',
  costReady: 'marketing-welcome-cost.spec.ts',
  costSettled: 'marketing-welcome-cost.spec.ts',
  signedOut: 'helpers/auth.ts',
} satisfies Partial<Record<SignalKey, string>>;

/**
 * `TEST_SIGNALS` is the typed registry of `data-*`
 * readiness attributes the production app emits. The unit test
 * (`packages/shared/src/testing/test-signals.test.ts`) locks the registry's *shape*.
 * This e2e contract locks the other half: that the running production app
 * actually emits each signal once driven into the state where it renders. A
 * signal that silently stops being emitted (renamed/removed at its DOM site)
 * breaks here rather than as a mystery wall-clock flake in whichever spec
 * gates on it.
 *
 * Tests are grouped by the app state required to render each signal so setup is
 * shared; the coverage cases below measure this file's own assertions against
 * the registry, so the claim that every signal is exercised is derived rather
 * than asserted.
 */
test.describe('State-signal contract', SPEC_MATRIX, () => {
  test('page-load signals render on the new-chat page', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    // appStable: the SPA has hydrated and settled (new-chat page).
    await expect(chatPage.newChatPage).toHaveAttribute(TEST_SIGNALS.appStable, 'true', {
      timeout: TIMEOUTS.APP_STABLE,
    });
  });

  test('banner-settled signal renders once the banner decision is applied', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    // bannerSettled: the banner payload fetch resolved AND the show/hide
    // decision was applied. Emitted 'true' regardless of whether a banner is
    // active (that is the point — it distinguishes "no banner" from "not
    // loaded yet"), so no banner_config seed is required. Attached, not
    // visible: with no active banner the mount node is an empty div.
    await expect(authenticatedPage.locator(`[${TEST_SIGNALS.bannerSettled}="true"]`)).toBeAttached({
      timeout: TIMEOUTS.APP_STABLE,
    });
  });

  test('conversation signals render on a seeded conversation', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const list = chatPage.messageList;

    // messagesReady: the decrypt pass has run (distinguishes "no messages" from
    // "decryption in flight").
    await expect(list).toHaveAttribute(TEST_SIGNALS.messagesReady, 'true', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });

    // The seeded conversation has one user + one AI message.
    await expect(list).toHaveAttribute(TEST_SIGNALS.messageCount, '2');
    await expect(list).toHaveAttribute(TEST_SIGNALS.decryptedCount, '2');

    // Count signals render regardless of value; assert presence (the contract).
    // assistantCount/costCount/rowsCount/virtuosoScrolling carry dynamic values
    // (cost is null on dev-seeded AI messages, so costCount is "0").
    await expect(list).toHaveAttribute(TEST_SIGNALS.assistantCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.costCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.rowsCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.virtuosoScrolling);
    await expect(list).toHaveAttribute(TEST_SIGNALS.atBottom);

    // Per-message identity/role on the rendered message items.
    const firstMessage = list.locator(`[${TEST_SIGNALS.messageId}]`).first();
    await expect(firstMessage).toHaveAttribute(TEST_SIGNALS.messageId);
    await expect(firstMessage).toHaveAttribute(TEST_SIGNALS.role);
  });

  test('stream signals render and advance when a turn completes', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const list = chatPage.messageList;

    // Both stream signals are present on the populated list before any new turn.
    await expect(list).toHaveAttribute(TEST_SIGNALS.streamingCount);
    await expect(list).toHaveAttribute(TEST_SIGNALS.streamsCompleted);

    // streamsCompleted is a monotonic cycle counter: it advances once a sent
    // turn streams to completion. Capturing the baseline and asserting an
    // increment proves the signal tracks real stream lifecycle, not a constant.
    const baseline = await chatPage.captureStreamBaseline();
    await chatPage.sendFollowUpMessage(`Signal stream check ${testConversation.id}`);
    await chatPage.waitForStreamCycle(baseline);
    await expect
      .poll(async () => Number((await list.getAttribute(TEST_SIGNALS.streamsCompleted)) ?? '0'), {
        timeout: TIMEOUTS.STREAM,
      })
      .toBeGreaterThan(baseline);
  });

  test('the stream settle gate holds until the first turn of a new chat completes', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    // A new-chat page renders no message list, so this baseline is only
    // readable because the shell root carries the counter on every route.
    const baseline = await chatPage.captureStreamBaseline();

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await authenticatedPage.route(/\/chat(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await released;
      await route.fallback();
    });

    const turnStart = nextTurnRequest(authenticatedPage);
    const prompt = 'Signal first-turn settle gate check';
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await turnStart;

    // While the turn's POST is held no stream can have started, so a gate that
    // passes here is one that can pass before the turn it waits for.
    await expect(chatPage.waitForStreamCycle(baseline, TIMEOUTS.QUICK)).rejects.toThrow(
      `Timeout ${String(TIMEOUTS.QUICK)}ms exceeded`
    );

    release();
    await chatPage.waitForStreamCycle(baseline);
    await chatPage.waitForAIResponse(prompt);
  });

  test('pre-inference signal renders and advances on a Smart Model turn', async ({
    authenticatedPage,
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    const list = chatPage.messageList;

    // Present on the populated list before any Smart Model turn.
    await expect(list).toHaveAttribute(TEST_SIGNALS.preInferenceStagesSeen);

    // Monotonic: a Smart Model send runs a pre-inference (classifier) stage,
    // advancing the counter. Capturing the baseline and asserting an increment
    // proves the signal tracks the real stage, not a constant.
    await chatPage.selectSingleModel('smart-model');
    const baseline = await chatPage.capturePreInferenceBaseline();
    await chatPage.sendFollowUpMessage(`Signal pre-inference check ${testConversation.id}`);
    await chatPage.waitForPreInferenceStage(baseline);
  });

  test('composer signals render on a seeded conversation', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    // Scoped to `main` for the same reason ChatPage's own send helpers are: a
    // composer can also be mounted outside it, and both signals ride the
    // composer.
    const conversation = authenticatedPage.locator('main');

    // affordabilitySettled: the composer's affordability producer has resolved
    // — the payer's funding snapshot is in hand (or terminally unavailable) and
    // the catalog has landed. Emitted "true"/"false" on the composer root, so
    // the attribute is present before it is true and the assertion is on the
    // value, not on attachment.
    const composer = conversation.locator(`[${TEST_SIGNALS.affordabilitySettled}]`);
    await expect(composer).toHaveAttribute(TEST_SIGNALS.affordabilitySettled, 'true', {
      timeout: TIMEOUTS.APP_STABLE,
    });

    // effortControl: tri-state on the effort chip's slide wrapper, always
    // attached because the wrapper is what slides. Selecting the Smart Model
    // drives it to `present` — that slot carries an effort ladder, since the
    // level pins the slot the server derives its candidates at.
    const effortControl = conversation.locator(`[${TEST_SIGNALS.effortControl}]`);
    await expect(effortControl).toBeAttached();
    await chatPage.selectSingleModel('smart-model');
    await expect(effortControl).toHaveAttribute(TEST_SIGNALS.effortControl, 'present', {
      timeout: TIMEOUTS.APP_STABLE,
    });
  });

  test('epoch-state signal renders on a seeded conversation', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    // epochState: the key-chain verdict. A seeded conversation has no departed
    // seat and keys that verify, and the verified banner renders hidden, so the
    // assertion is on the attached value, not on visibility.
    await expect(authenticatedPage.locator(`[${TEST_SIGNALS.epochState}="verified"]`)).toBeAttached(
      { timeout: TIMEOUTS.CONVERSATION_LOAD }
    );
  });

  test('websocket signals render on a group conversation', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    const { aliceChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    // wsConnected / wsReady are emitted as "true" only on a group chat once the
    // socket connects and the Durable Object reports server-side readiness.
    await expect(aliceChatPage.page.locator(`[${TEST_SIGNALS.wsConnected}="true"]`)).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
    await expect(aliceChatPage.page.locator(`[${TEST_SIGNALS.wsReady}="true"]`)).toBeAttached({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
  });

  test('roadmap-ready signal renders on the public roadmap', async ({ unauthenticatedPage }) => {
    await unauthenticatedPage.goto('/roadmap', { waitUntil: 'domcontentloaded' });

    // roadmapReady: the marketing roadmap board finished loading its
    // (Linear-mocked, deterministic) data.
    await expect(unauthenticatedPage.locator(`[${TEST_SIGNALS.roadmapReady}]`)).toBeVisible({
      timeout: TIMEOUTS.APP_STABLE,
    });
  });

  test('newsletter-ready signal renders on the public newsletter page', async ({
    unauthenticatedPage,
  }) => {
    await unauthenticatedPage.goto('/newsletter', { waitUntil: 'domcontentloaded' });

    // newsletterReady: the marketing signup island hydrated and accepts
    // input (static Astro HTML never carries the signal).
    await expect(
      unauthenticatedPage.locator(`[${TEST_SIGNALS.newsletterReady}="true"]`)
    ).toBeVisible({ timeout: TIMEOUTS.APP_STABLE });
  });

  test('stats signals render on the public leaderboard', async ({ unauthenticatedPage }) => {
    await unauthenticatedPage.goto('/leaderboard', { waitUntil: 'domcontentloaded' });

    // statsSettled: the stats fetch resolved (either branch); with seeded
    // usage data the settled element is also the statsReady wrapper.
    const settled = unauthenticatedPage.locator(`[${TEST_SIGNALS.statsSettled}="true"]`);
    await expect(settled).toBeVisible({ timeout: TIMEOUTS.APP_STABLE });
    await expect(settled).toHaveAttribute(TEST_SIGNALS.statsReady);
  });
});

const COVERAGE_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The check compares two key sets in memory, opens no page and drives no signal into view, so no rendering engine participates.',
});

test.describe('State-signal contract coverage', COVERAGE_MATRIX, () => {
  test('every registry signal is driven here or excused to a named module', () => {
    const registrySignals = Object.keys(TEST_SIGNALS) as SignalKey[];

    const unexercised = registrySignals.filter(
      (signal) => !EXERCISED_HERE.has(signal) && !(signal in EXERCISED_ELSEWHERE)
    );

    expect(
      unexercised,
      'signals declared in TEST_SIGNALS that no case in this spec drives into view'
    ).toEqual([]);
  });

  test('every signal excused to a module is read by that module', () => {
    const unread = Object.entries(EXERCISED_ELSEWHERE)
      .filter(
        ([signal, module]) =>
          !readFileSync(fileURLToPath(new URL(`../${module}`, import.meta.url)), 'utf8').includes(
            `TEST_SIGNALS.${signal}`
          )
      )
      .map(([signal]) => signal);

    expect(unread, 'signals excused to a module whose source does not read them').toEqual([]);
  });
});
