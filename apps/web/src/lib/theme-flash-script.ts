/**
 * Pre-paint theme resolution for `apps/web/index.html`.
 *
 * Mirrors `apps/marketing/src/components/ThemeScript.astro` (storage key
 * `themeMode`, dark iff explicit `dark` or unset-with-OS-dark) so an explicit
 * theme that disagrees with the OS preference applies the `dark` class before
 * first paint and the React `ThemeProvider` mount causes no flip.
 *
 * Two exports kept byte-identical in logic:
 * - `resolvePrePaintDark` — the testable resolution, exercised directly.
 * - `THEME_FLASH_SCRIPT` — the inline `<script>` body embedded verbatim in
 *   index.html (an inline script can't import a module without becoming
 *   non-blocking, which would defeat pre-paint). `theme-flash-script.test.ts`
 *   asserts the embedding and parity so the two never drift.
 */

interface PrePaintDeps {
  getThemeMode: () => string | null;
  prefersDark: () => boolean;
}

/**
 * Resolves whether the `dark` class should be present before first paint.
 * Swallows storage/matchMedia errors (access can throw) and defaults to light.
 */
export function resolvePrePaintDark(deps: PrePaintDeps): boolean {
  try {
    const saved = deps.getThemeMode();
    return saved === 'dark' || (!saved && deps.prefersDark());
  } catch {
    return false;
  }
}

export const THEME_FLASH_SCRIPT = `try {
  var saved = localStorage.getItem('themeMode');
  var osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = saved === 'dark' || (!saved && osDark);
  document.documentElement.classList.toggle('dark', dark);
} catch (e) {}`;
