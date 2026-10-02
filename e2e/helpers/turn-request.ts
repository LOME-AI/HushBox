import { TIMEOUTS } from '../config/timeouts.js';
import type { Page, Request } from '@playwright/test';

/**
 * The composer's turn-start POST (`POST /chat`, no trailing segment). The
 * request leaves only once the conversation room's socket is ready, so a first
 * send's wait spans the room's cold start.
 */
export function nextTurnRequest(page: Page): Promise<Request> {
  return page.waitForRequest(
    (request) => request.method() === 'POST' && /\/chat(?:\?|$)/.test(request.url()),
    { timeout: TIMEOUTS.STREAM_SATURATED }
  );
}
