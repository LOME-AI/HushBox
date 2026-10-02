import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { expect } from './expect.js';
import { requireEnv } from './env.js';
import { withRequestRetry } from './resilient-request.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ChatPage } from '../pages/index.js';
import type { Page } from '@playwright/test';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * Verify a removed member has actually lost access: the conversation read their
 * own credentials can still issue answers not-found, and the UI navigation lands
 * away from the conversation.
 *
 * The API read is the load-bearing half. A redirect on its own is satisfied by
 * any navigation away, including one an unrelated failure caused, so it proves
 * routing rather than revocation.
 *
 * Caller-side precondition: not-found is existence-hiding — a non-member and a
 * conversation that never existed answer alike — so this proves revocation only
 * where the caller established the principal's access earlier in the same test.
 *
 * The navigation triggers per-conversation prefetches (`/conversations|
 * budgets|members|keys|links/{id}`) for resources the principal no longer has
 * access to — each returns 404 NOT_FOUND before the router
 * redirects away. Opt out here so every caller doesn't have to repeat the
 * pattern.
 */
export async function expectAccessRevoked(page: Page, conversationId: string): Promise<void> {
  expectApiErrors(page, [
    /404 Not Found GET .*\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: the server responded with a status of 404/]);

  const readAfterRevoke = await withRequestRetry(page.request).get(
    `${apiUrl}/conversations/${conversationId}`
  );
  expect(readAfterRevoke.status()).toBe(404);

  const chatPage = new ChatPage(page);
  await chatPage.gotoConversation(conversationId);

  await expect(page).not.toHaveURL(new RegExp(conversationId), {
    timeout: TIMEOUTS.ROUTE,
  });
}
