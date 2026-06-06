import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

/**
 * The E2E build bakes in `VITE_E2E`, which
 * forces the app's merged reduced-motion signal on app-wide — independent of
 * per-browser `prefers-reduced-motion` emulation, which doesn't reliably
 * propagate to WebKit. The app mirrors that merged signal onto the
 * `reduced-motion` class on `<html>` (the single CSS hook every reduce-motion
 * rule keys off; see packages/ui reduced-motion-broadcaster). This contract
 * proves motion is actually disabled in the running E2E build rather than
 * trusting the build flag.
 */
test.describe('Motion-off contract', () => {
  test('the E2E build forces reduced-motion app-wide', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    // The A11yProvider installs the reduced-motion class on mount; gate on app
    // stability so the provider effect has run before asserting.
    await chatPage.waitForAppStable();

    // App-authored signal: the merged reduced-motion truth mirrored onto <html>.
    await expect(authenticatedPage.locator('html')).toHaveClass(/\breduced-motion\b/);
  });
});
