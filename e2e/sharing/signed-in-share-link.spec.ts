import { ROUTES } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages/index.js';
import { setupConversationWithSidebar } from '../helpers/group-test-setup.js';
import { createInviteLink } from '../helpers/invite-link.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The proof is which requests the client issues on a share document and whether it navigates to login; request credentials and route transitions are decided by app code, not by a rendering engine.',
});

/**
 * A signed-in visitor opening someone else's share link must stay signed in.
 *
 * On a share document the API client issues every request with credentials
 * deliberately omitted, so any 401 there is the expected answer to an anonymous
 * request rather than evidence about the visitor's session. Reading one as a
 * revoked session used to clear the visitor's auth markers, purge their device
 * key and hard-navigate them to login.
 *
 * The two assertions are deliberate:
 *
 * - **No 401 is observed at all.** The suite's own `expectSharedConversationLoaded`
 *   opts out of exactly this 401 class for already-logged-in callers, so relying
 *   on the api-error guard here would suppress the evidence this test exists to
 *   collect. The response listener is the proof instead.
 * - **The page never navigates to the login route.** That is the user-visible
 *   harm, and it is observed within the share document itself.
 *
 * Nothing is asserted about Web Storage after a navigation: the harness re-seeds
 * storage on every document, so a storage read past a navigation goes green
 * whether or not the session survived.
 */
test.describe('Signed-in visitor on a share link', SPEC_MATRIX, () => {
  test('keeps the session and never bounces to login', async ({
    authenticatedPage,
    testBobPage,
    testConversation,
  }) => {
    const { sidebar } = await setupConversationWithSidebar(authenticatedPage, testConversation.id);

    const { url } = await createInviteLink(authenticatedPage, sidebar, {
      withHistory: true,
      extractLinkId: false,
    });

    const unauthorized: string[] = [];
    testBobPage.on('response', (response) => {
      if (response.status() === 401) {
        unauthorized.push(`${response.request().method()} ${new URL(response.url()).pathname}`);
      }
    });

    const loginNavigations: string[] = [];
    testBobPage.on('framenavigated', (frame) => {
      if (frame === testBobPage.mainFrame() && new URL(frame.url()).pathname === ROUTES.LOGIN) {
        loginNavigations.push(frame.url());
      }
    });

    await testBobPage.goto(url, { waitUntil: 'domcontentloaded' });

    // Gate on the shared conversation actually rendering and decrypting, so the
    // two assertions below read a settled document rather than a racing one.
    await new ChatPage(testBobPage).waitForConversationLoaded();

    expect(unauthorized).toEqual([]);
    expect(loginNavigations).toEqual([]);
    await expect(testBobPage).toHaveURL(/\/share\/c\//);
  });
});
