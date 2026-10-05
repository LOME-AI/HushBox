import { TEST_IDS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage, PromptPredictionPage } from '../pages';
import { TIMEOUTS } from '../config/timeouts.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { personaEmail } from '../helpers/personas.js';
import type { APIRequestContext, Page } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'mobile' });

/** The screens the new chat's first screen must hold the storage line on. */
const FIT_VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
] as const;

/** The phone widths the context gauge must fit at doubled text. */
const GAUGE_WIDTHS = [320, 360, 375, 390, 414, 430] as const;
const GAUGE_HEIGHT = 844;

/** The least space between the model info and the composer, which the composer's focus tab rises into. */
const MIN_COMPOSER_GAP_PX = 14;

/**
 * Slack for comparing two independently rounded client rects. Engines lay out in
 * sub-pixel units that do not all convert to binary fractions exactly, so two edges
 * that meet can read a hair apart; half a pixel matches the gauge's component
 * geometry test.
 */
const SUBPIXEL_SLACK = 0.5;

/**
 * The fit is owed with at most one recent title wrapping, so of the three titles the
 * Continue list shows, one is long enough to wrap and the other two are short.
 */
const WRAPPING_TITLE =
  'Planning a two-week rail trip through northern Italy with stops for food, hiking and museums';
const ONE_LINE_TITLES = ['Tax questions', 'Sourdough starter'] as const;

async function seedTitledConversation(
  request: APIRequestContext,
  ownerEmail: string,
  title: string
): Promise<void> {
  const response = await idempotentPost(request, '/dev/conversation', {
    data: {
      ownerEmail,
      title,
      messages: [
        { content: title, senderType: 'user' },
        { content: `Echo: ${title}`, senderType: 'ai' },
      ],
    },
  });
  await expectOkResponse(response, 'titled conversation creation');
}

/** How far the document overflows its viewport sideways; zero when nothing scrolls sideways. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

/**
 * The new chat at rest: the app stable and the greeting typed out in full. The placeholder
 * and every suggestion chip type their text too, so the wait reads only the greeting's
 * heading.
 */
async function openNewChatAtRest(chatPage: ChatPage): Promise<void> {
  await chatPage.goto();
  await chatPage.waitForAppStable();
  const greeting = chatPage.page.getByRole('heading', { level: 1 });
  await expect(greeting.getByTestId(TEST_IDS.typingAnimation)).toBeVisible();
  await expect(greeting.getByTestId(TEST_IDS.typingCursor)).toHaveCount(0);
}

test.describe('Mobile viewport height', SPEC_MATRIX, () => {
  test.use({
    viewport: { width: 390, height: 844 }, // iPhone 14
  });

  test('chat input and container adapt to viewport changes', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    const chatWelcome = authenticatedPage.getByTestId(TEST_IDS.chatWelcome);
    const initialHeight = await chatWelcome.evaluate((el) => (el as HTMLElement).style.height);
    expect(initialHeight).toBe('844px');

    await authenticatedPage.setViewportSize({ width: 390, height: 450 });

    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    await authenticatedPage.waitForFunction(
      ({ selector, expectedHeight }: { selector: string; expectedHeight: string }) => {
        const el = document.querySelector<HTMLElement>(selector);
        return el?.style.height === expectedHeight;
      },
      { selector: `[data-testid="${TEST_IDS.chatWelcome}"]`, expectedHeight: '450px' },
      { timeout: TIMEOUTS.SCROLL_STABLE }
    );

    const shrunkHeight = await chatWelcome.evaluate((el) => (el as HTMLElement).style.height);
    expect(shrunkHeight).toBe('450px');
  });
});

test.describe('New chat first screen', SPEC_MATRIX, () => {
  test('holds the storage line on the first screen beside three recent conversations with no notice showing', async ({
    authenticatedPage,
    authenticatedRequest,
  }) => {
    const ownerEmail = personaEmail('test-alice');
    for (const title of [WRAPPING_TITLE, ...ONE_LINE_TITLES]) {
      await seedTitledConversation(authenticatedRequest, ownerEmail, title);
    }
    const chatPage = new ChatPage(authenticatedPage);
    const geometry = new PromptPredictionPage(authenticatedPage);
    const continueList = authenticatedPage.getByTestId(TEST_IDS.continueList);
    const modelInfo = authenticatedPage.getByTestId(TEST_IDS.modelInfo);
    const storageLine = authenticatedPage.getByTestId(TEST_IDS.storageLine);

    for (const viewport of FIT_VIEWPORTS) {
      await test.step(`${String(viewport.width)}x${String(viewport.height)}`, async () => {
        await authenticatedPage.setViewportSize(viewport);
        await openNewChatAtRest(chatPage);

        // The three conversations this test seeded are the account's most recent.
        await expect(continueList.getByRole('link')).toHaveCount(3);
        for (const title of [WRAPPING_TITLE, ...ONE_LINE_TITLES]) {
          await expect(continueList.getByRole('link', { name: title })).toBeVisible();
        }
        await chatPage.waitForAffordabilitySettled();
        await expect(authenticatedPage.getByTestId(TEST_IDS.budgetMessages)).toHaveCount(0);
        await expect(modelInfo).toBeVisible();

        await expect
          .poll(
            async () => {
              const line = await geometry.boxOf(storageLine, 'the storage line');
              return line.y + line.height;
            },
            { message: 'the storage line ends inside the first screen' }
          )
          .toBeLessThanOrEqual(viewport.height + SUBPIXEL_SLACK);
        await expect
          .poll(
            async () => {
              const [info, composer] = await geometry.boxesOf(
                modelInfo,
                chatPage.composer(),
                'the model info or the composer'
              );
              return composer.y - (info.y + info.height);
            },
            { message: 'the gap between the model info and the composer' }
          )
          .toBeGreaterThanOrEqual(MIN_COMPOSER_GAP_PX - SUBPIXEL_SLACK);
        await expect
          .poll(() => sidewaysOverflow(authenticatedPage), {
            message: 'the page scrolls sideways',
          })
          .toBe(0);
      });
    }
  });

  test('keeps the context gauge inside the composer at doubled text on every phone width', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    const geometry = new PromptPredictionPage(authenticatedPage);
    const gauge = authenticatedPage.getByTestId(TEST_IDS.capacityBar);
    await authenticatedPage.setViewportSize({ width: GAUGE_WIDTHS[0], height: GAUGE_HEIGHT });
    await openNewChatAtRest(chatPage);
    await geometry.growRootFontSize(2);

    for (const width of GAUGE_WIDTHS) {
      await test.step(`${String(width)} wide`, async () => {
        await authenticatedPage.setViewportSize({ width, height: GAUGE_HEIGHT });
        await expect(gauge).toBeVisible();

        // The gauge straddles the composer's top border by design, so it lies inside the
        // composer across the composer's width.
        await expect
          .poll(
            async () => {
              const [meter, composer] = await geometry.boxesOf(
                gauge,
                chatPage.composer(),
                'the context gauge or the composer'
              );
              return {
                leftInside: meter.x >= composer.x - SUBPIXEL_SLACK,
                rightInside: meter.x + meter.width <= composer.x + composer.width + SUBPIXEL_SLACK,
              };
            },
            { message: "the context gauge lies inside the composer's box" }
          )
          .toEqual({ leftInside: true, rightInside: true });
      });
    }
  });
});
