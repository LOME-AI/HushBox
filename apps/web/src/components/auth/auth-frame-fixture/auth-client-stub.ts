/**
 * Stands in for the app's auth client inside `auth-frame.browser.test.ts`'s fixture. The
 * frame is rendered through its route's component alone, so the route guard that reads the
 * session never runs; the real client's module graph (the API client, its environment, the
 * crypto caches) is left out of a page that measures layout.
 * @toolContract
 */
export const authClient = {
  getSession: (): Promise<{ data: null }> => Promise.resolve({ data: null }),
};
