/**
 * Inline `<head>` theme-bootstrap script.
 *
 * Runs synchronously before bundles load and before first paint, so a stored
 * `themeMode` that disagrees with the OS preference does not flash the wrong
 * theme on cold load. Every surface that paints HushBox chrome — the app, the
 * admin and docket consoles, the marketing site — resolves the theme through
 * this one string.
 *
 * `classList.toggle` rather than `classList.add`, so a `dark` class already on
 * the element is removed when the resolution is light.
 *
 * Constraints:
 *  - Must be a self-contained string (no imports): an inline script that
 *    imports a module becomes non-blocking, which defeats pre-paint.
 *  - Must never throw — `localStorage` and `matchMedia` both throw in
 *    locked-down browser modes.
 *  - The storage key is the one the runtime theme writers read and write.
 */
export const THEME_INIT_SCRIPT: string = String.raw`
(function () {
  try {
    var saved = window.localStorage.getItem('themeMode');
    var osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', saved === 'dark' || (!saved && osDark));
  } catch (e) {}
})();
`;
