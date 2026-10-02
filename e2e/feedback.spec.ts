import { TEST_IDS } from '@hushbox/shared';
import { expect, test } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import {
  clearAuthRateLimits,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
} from './helpers/auth.js';
import { fetchFeedbackByEmail, openFeedbackModal, submitFeedback } from './helpers/feedback.js';
import type { APIRequestContext, Page } from './fixtures.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The proof is the feedback row read back through the dev route rather than the toast, and whether a submitted note lands in Postgres is not something a rendering engine decides.',
});

const PHONE_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'mobile',
  reason: 'The defect is the drawer closing its own child, identical on every engine.',
});

// The mobile carrier can be the tablet project, which sits in the desktop band, so the phone
// band is set explicitly.
const PHONE_VIEWPORT = { width: 390, height: 844 };

const FRESH_PASSWORD = 'TestPassword123!';

interface SentFeedback {
  readonly body: string;
  readonly rows: Awaited<ReturnType<typeof fetchFeedbackByEmail>>;
}

/**
 * Signs up a fresh user, opens the feedback form through `openForm`, submits a bug report and
 * returns the rows the dev read-back route holds for that user.
 */
async function sendBugFeedback(
  page: Page,
  request: APIRequestContext,
  openForm: (page: Page) => Promise<void>
): Promise<SentFeedback> {
  await clearAuthRateLimits(request, []);
  const email = uniqueEmail('fb');
  const username = uniqueUsername('fb');
  await signUpAndVerify(page, request, { username, email, password: FRESH_PASSWORD });

  const body = `E2E feedback ${crypto.randomUUID()}`;
  await openForm(page);
  await submitFeedback(page, { kind: 'bug', body });
  return { body, rows: await fetchFeedbackByEmail(request, email) };
}

/**
 * A logged-in user sends feedback and the row is proven to persist. The UI
 * submit is gated on app state (the `POST /feedback` 200 and the success
 * toast), and the persistence is proven through the dev read-back route — the
 * side effect, not just the UI (rule 1.5).
 */
test.describe('Feedback', SPEC_MATRIX, () => {
  test('a logged-in user sends bug feedback and the row lands in Postgres', async ({
    unauthenticatedPage: page,
    request,
  }) => {
    const { body, rows } = await sendBugFeedback(page, request, openFeedbackModal);

    // Side-effect proof: the submitted note is now a real row for this user.
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'bug', body }));
  });
});

/**
 * On a phone the account menu lives in the drawer, and choosing Send feedback closes the
 * drawer. The form must outlive that close and still submit.
 */
test.describe('Feedback from the phone drawer', PHONE_MATRIX, () => {
  test('Send feedback chosen in the phone drawer keeps the form open through the drawer closing', async ({
    unauthenticatedPage: page,
    request,
  }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    const { body, rows } = await sendBugFeedback(page, request, async (drawerPage) => {
      await openFeedbackModal(drawerPage);
      await expect(drawerPage.getByTestId(TEST_IDS.sidebar)).toBeHidden();
      await expect(drawerPage.getByTestId(TEST_IDS.feedbackModal)).toBeVisible();
    });

    expect(rows).toContainEqual(expect.objectContaining({ kind: 'bug', body }));
  });
});
