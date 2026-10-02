import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages/index.js';
import { pinTextTurnShape } from '../helpers/text-turn-shape.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Locator } from '../fixtures.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'Every participant in the replay is engine-independent: the room buffers the frames, the DO adapter carries the declaration on the upgrade URL, and the client collects cursors in plain JavaScript. The one harness capability the test needs — a WebSocket route that fires per construction and holds the page socket in CONNECTING until it connects upstream — is a page-injected constructor override that behaves identically on all three engines.',
});

/**
 * How many further chunks one release lets through before the stream parks
 * again. Sized against the prompt below rather than against a chunk count: two
 * strides have to stay inside the echoed prompt, because that is the region
 * where the rendered text is plain prose and a contiguity check can read it.
 */
const STRIDE = 4;

/**
 * The prompt's opening word, and the only occurrence of it in the whole echoed
 * answer. The rendered tile carries the mock's own prefix ahead of the echo,
 * and markdown decides how that prefix's line break is rendered — so the
 * assertions below start reading at this word instead of at the tile's first
 * character, and never have to model the affix at all.
 */
const PROMPT_HEAD = 'reconnect';

/**
 * Long, single-line, plain ASCII, and free of every markdown-significant
 * character. Length is the load-bearing property: the echoed prompt has to
 * outlast the two strides this test walks, so that each assertion reads a
 * position inside one paragraph of prose rather than inside the JSON fence the
 * mock appends, whose rendering is a code block rather than text.
 */
const PROMPT =
  `${PROMPT_HEAD} ` +
  'the room replays exactly the frames a severed socket missed '.repeat(7).trim();

/**
 * A ceiling on the releases that drain the rest of the run, not an expectation
 * of how many it takes: the loop stops on the run's own completed-cycle signal
 * and this only bounds a run that never completes. Generous enough that a
 * change to the mock's chunk width cannot silently exhaust it.
 */
const MAX_DRAIN_RELEASES = 40;

/**
 * The echoed prompt as the tile currently renders it. Everything ahead of
 * {@link PROMPT_HEAD} is the mock's prefix, whose whitespace markdown may
 * render as a newline, a `<br>`, or nothing at all; everything from that word
 * on is the prompt verbatim, so it can be compared character for character
 * against the string this spec sent.
 */
async function renderedPromptPortion(answerBody: Locator): Promise<string> {
  const rendered = (await answerBody.textContent()) ?? '';
  const start = rendered.indexOf(PROMPT_HEAD);
  return start === -1 ? '' : rendered.slice(start);
}

/**
 * Assert the tile is showing a CONTIGUOUS opening stretch of the prompt. A
 * frame that never arrived, or one delivered out of its place, produces a
 * string that is not a prefix of what was sent — which is what makes equality
 * here a statement about frame contiguity and not merely about length.
 */
function expectContiguousPrefix(portion: string): void {
  expect(PROMPT.slice(0, portion.length)).toBe(portion);
}

/**
 * Release a parked run. A run left parked holds its funding reservation until
 * the hold's TTL, so the drain is never simply dropped.
 */
async function drainParkedRun(
  chatPage: ChatPage,
  conversationId: string,
  cycleBaseline: number
): Promise<void> {
  for (let attempt = 0; attempt < MAX_DRAIN_RELEASES; attempt += 1) {
    if ((await chatPage.captureStreamBaseline()) > cycleBaseline) return;
    await chatPage.releaseHeldStream(conversationId);
  }
}

/**
 * A severed socket recovers exactly the part of a live reply it missed.
 *
 * The whole point is the MID-RUN assertion. Once the run's terminal frame
 * lands the client refetches the conversation and the persisted message repairs
 * any hole, so an assertion taken after completion proves persistence and says
 * nothing about replay. Every assertion that grades the recovered text is
 * therefore paired with the message list still reporting one live stream.
 *
 * The reconnect is GATED, and that gate is what makes the test mean anything:
 * the reconnecting socket is held in `CONNECTING` until the held run has
 * already advanced past the point the client last saw. Admit it any earlier and
 * the missed frames arrive as ordinary live fan-out, the replay path never
 * runs, and the test passes without having exercised it.
 */
test.describe('Reconnect replay', SPEC_MATRIX, () => {
  test('a socket severed mid-run recovers exactly the frames it missed', async ({
    authenticatedPage,
    testConversation,
  }) => {
    test.slow();

    const chatPage = new ChatPage(authenticatedPage);

    let severEstablishedSocket: (() => Promise<void>) | undefined;
    let announceReconnectAttempt: (() => void) | undefined;
    let admitReconnect: (() => void) | undefined;
    let socketsOpened = 0;

    const reconnectAttempted = new Promise<void>((resolve) => {
      announceReconnectAttempt = resolve;
    });
    const reconnectAdmitted = new Promise<void>((resolve) => {
      admitReconnect = resolve;
    });

    // Matched by RegExp, never by a relative pattern: a relative string is
    // resolved against the context's baseURL, which is the preview server
    // rather than the API the socket dials.
    await authenticatedPage.routeWebSocket(
      new RegExp(`/conversations/${testConversation.id}/websocket`, 'u'),
      async (socket) => {
        socketsOpened += 1;
        if (socketsOpened === 1) {
          severEstablishedSocket = () => socket.close();
          socket.connectToServer();
          return;
        }
        announceReconnectAttempt?.();
        await reconnectAdmitted;
        socket.connectToServer();
      }
    );

    // A solo conversation holds no socket of its own: the run transport
    // acquires one when the turn starts and releases it when the turn settles,
    // so the socket this test severs is created after the route is installed
    // and there is nothing to wait for here. The layout's `ws` readiness
    // signals belong to the group-realtime hook and are absent on this page.
    await chatPage.gotoConversation(testConversation.id);
    await chatPage.waitForConversationLoaded();

    const cycleBaseline = await chatPage.captureStreamBaseline();
    const answerBody = chatPage
      .messagesByRole('assistant')
      .last()
      .getByTestId(TEST_IDS.markdownRenderer);

    let parkedText = '';
    let bodySucceeded = false;

    try {
      await test.step('park the run one chunk in, on a turn that carries no reasoning', async () => {
        await pinTextTurnShape(chatPage);
        await chatPage.holdPrimaryStreamForNextSends(STRIDE);
        await chatPage.sendFollowUpMessage(PROMPT);
        await chatPage.waitForStreamingActive();

        // The shape the turn took, read from what it emitted rather than from
        // what the request asked for. A turn carrying an active reasoning wire
        // parks in its reasoning-only phase, where its reasoning row is a live
        // one-liner and no answer text exists; once it answers, the row stays as
        // a settled disclosure. So answer text present with no reasoning row at
        // all is the plain shape, and the plain shape is the one whose first
        // park sits after the first chunk.
        await expect(answerBody).toContainText(PROMPT_HEAD, {
          timeout: TIMEOUTS.STREAM_SATURATED,
        });
        await expect(
          chatPage.messagesByRole('assistant').last().getByTestId(TEST_IDS.thinkingDisclosure)
        ).toHaveCount(0);

        parkedText = await renderedPromptPortion(answerBody);
        expectContiguousPrefix(parkedText);
        expect(parkedText.length).toBeGreaterThan(0);
        expect(parkedText.length).toBeLessThan(PROMPT.length);
      });

      await test.step('sever the socket and advance the run while it is gone', async () => {
        // Cleared before any release, so a resubmit triggered anywhere in the
        // page cannot carry the hold directive and park with nobody to free it.
        await chatPage.stopHoldingStreams();

        expect(severEstablishedSocket, 'the established socket was never routed').toBeDefined();
        await severEstablishedSocket?.();

        // The client's own reconnect is the barrier: reaching the route a
        // second time is the app saying it observed the drop. Nothing here
        // waits on a clock, and the socket stays in CONNECTING — no upgrade,
        // no declaration, no frames — until this test admits it.
        await reconnectAttempted;

        // Returns only once the run has parked again, so the frames this
        // client cannot see have already been written when it resolves.
        await chatPage.releaseHeldStream(testConversation.id);
      });

      await test.step('the gap the reconnecting client declares comes back, in order', async () => {
        admitReconnect?.();

        await expect
          .poll(
            async () => {
              const growing = await renderedPromptPortion(answerBody);
              return growing.length;
            },
            { timeout: TIMEOUTS.STREAM_SATURATED }
          )
          .toBeGreaterThan(parkedText.length);

        const replayedText = await renderedPromptPortion(answerBody);
        expectContiguousPrefix(replayedText);
        // Nothing is persisted mid-run, so a tile that grew here grew from
        // frames the room sent — never from a refetch.
        await expect(chatPage.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '1');
        parkedText = replayedText;
      });

      await test.step('live fan-out resumes on the same socket', async () => {
        await chatPage.releaseHeldStream(testConversation.id);

        await expect
          .poll(
            async () => {
              const growing = await renderedPromptPortion(answerBody);
              return growing.length;
            },
            { timeout: TIMEOUTS.STREAM_SATURATED }
          )
          .toBeGreaterThan(parkedText.length);

        const advancedText = await renderedPromptPortion(answerBody);
        expectContiguousPrefix(advancedText);
        await expect(chatPage.messageList).toHaveAttribute(TEST_SIGNALS.streamingCount, '1');
      });

      await test.step('the run finishes with the whole echo intact', async () => {
        await drainParkedRun(chatPage, testConversation.id, cycleBaseline);
        await chatPage.waitForStreamCycle(cycleBaseline);
        await expect(answerBody).toContainText(PROMPT);
      });

      bodySucceeded = true;
    } finally {
      // A held handler would outlive the test and keep the page's socket in
      // CONNECTING through teardown.
      admitReconnect?.();
      await chatPage.stopHoldingStreams();
      if (bodySucceeded) {
        await drainParkedRun(chatPage, testConversation.id, cycleBaseline);
      } else {
        // eslint-disable-next-line comments/resolvable-cross-reference -- the E2E harness writes its run report there and git ignores it, so the citation is correct and resolves only after a run
        // A throw out of cleanup REPLACES the error being unwound, and `e2e/report/`
        // would then carry the cleanup symptom instead of the diagnosis, so on the
        // failure path a drain error is attached rather than raised.
        await drainParkedRun(chatPage, testConversation.id, cycleBaseline).catch(
          async (drainError: unknown) => {
            await test.info().attach('held-stream-drain-failed', {
              body: drainError instanceof Error ? drainError.message : 'non-Error thrown',
              contentType: 'text/plain',
            });
          }
        );
      }
    }
  });
});
