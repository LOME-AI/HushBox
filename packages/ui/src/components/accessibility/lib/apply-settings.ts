import type { AccessibilityPreferences } from '@hushbox/shared';

/** Maps a class name to whether it should be present after this call. */
type ClassToggle = readonly [className: string, present: boolean];

/** All a11y-* class names this module manages, in stable order. Each entry is conditional. */
function buildToggles(prefs: AccessibilityPreferences): ClassToggle[] {
  return [
    // Contrast
    ['a11y-contrast-increased', prefs.contrast === 'increased'],
    ['a11y-contrast-high', prefs.contrast === 'high'],
    ['a11y-contrast-low', prefs.contrast === 'low'],

    // Saturation
    ['a11y-saturate-0', prefs.saturation === '0'],
    ['a11y-saturate-50', prefs.saturation === '50'],
    ['a11y-saturate-150', prefs.saturation === '150'],

    // Invert
    ['a11y-invert', prefs.invert],

    // Highlight links
    ['a11y-highlight-links', prefs.highlightLinks],

    // Colorblind simulate (CSS in colorblind.css)
    ['a11y-cb-protan', prefs.colorblindSimulate === 'protan'],
    ['a11y-cb-deutan', prefs.colorblindSimulate === 'deutan'],
    ['a11y-cb-tritan', prefs.colorblindSimulate === 'tritan'],
    ['a11y-cb-achroma', prefs.colorblindSimulate === 'achroma'],
    ['a11y-cb-achromatomaly', prefs.colorblindSimulate === 'achromatomaly'],

    // Colorblind correct (Daltonization). CSS for these is a v2 enhancement; classes are
    // applied here so styles can hook in later without a code change.
    ['a11y-cb-correct-protan', prefs.colorblindCorrect === 'protan'],
    ['a11y-cb-correct-deutan', prefs.colorblindCorrect === 'deutan'],
    ['a11y-cb-correct-tritan', prefs.colorblindCorrect === 'tritan'],
    ['a11y-cb-correct-achroma', prefs.colorblindCorrect === 'achroma'],

    // Font size
    ['a11y-font-scale-125', prefs.fontSize === '125'],
    ['a11y-font-scale-150', prefs.fontSize === '150'],
    ['a11y-font-scale-175', prefs.fontSize === '175'],
    ['a11y-font-scale-200', prefs.fontSize === '200'],

    // Letter spacing
    ['a11y-letter-spacing-loose', prefs.letterSpacing === '0.05'],
    ['a11y-letter-spacing-loosest', prefs.letterSpacing === '0.12'],

    // Line height (no class for '1.0' — typography.css has only tall/double)
    ['a11y-line-height-tall', prefs.lineHeight === '1.5'],
    ['a11y-line-height-double', prefs.lineHeight === '2.0'],

    // Paragraph spacing
    ['a11y-para-spacing-double', prefs.paragraphSpacing === '2'],

    // Force left-align
    ['a11y-force-left', prefs.forceLeftAlign],

    // Font family override (the actual --a11y-font-family var is set by the font-loader in Task 51)
    ['a11y-font-override', prefs.fontFamily !== 'system'],

    // Stop animations — combine force settings with prefers-reduced-motion when 'system'
    ['a11y-stop-animations', resolveStopAnimations(prefs.stopAnimations)],

    // Cursor size
    ['a11y-cursor-large', prefs.cursorSize === 'large'],
    ['a11y-cursor-xlarge', prefs.cursorSize === 'xlarge'],

    // Cursor color (only `white` adds a class; black is the pointer.css default)
    ['a11y-cursor-white', prefs.cursorColor === 'white'],

    // Focus indicator — single combined class triggered by any non-default focus setting
    [
      'a11y-focus-strong',
      prefs.focusWidth !== '2' || prefs.focusColor !== 'yellow' || prefs.focusHalo,
    ],
    ['a11y-focus-halo', prefs.focusHalo],
  ];
}

/**
 * Apply accessibility preferences to a root element by toggling `a11y-*` classes
 * and CSS variables for focus width/color. Idempotent — calling twice with the
 * same prefs yields the same classList. Removes inactive classes on each call.
 *
 * @param prefs - The validated accessibility preferences from the Zustand store.
 * @param root - The element to mutate. Defaults to `document.documentElement`.
 */
export function applySettings(
  prefs: AccessibilityPreferences,
  root: HTMLElement = document.documentElement
): void {
  for (const [className, present] of buildToggles(prefs)) {
    root.classList.toggle(className, present);
  }
  // Focus-width and focus-color are exposed as CSS custom properties so the
  // pointer.css `outline: var(--a11y-focus-width)` rule picks them up.
  root.style.setProperty('--a11y-focus-width', `${prefs.focusWidth}px`);
  root.style.setProperty('--a11y-focus-color', prefs.focusColor);
}

/**
 * Resolve the tri-state `stopAnimations` to a boolean.
 * - `force-on` → always on
 * - `force-off` → always off
 * - `system` → mirror the OS `prefers-reduced-motion: reduce` query
 */
function resolveStopAnimations(value: AccessibilityPreferences['stopAnimations']): boolean {
  if (value === 'force-on') return true;
  if (value === 'force-off') return false;
  // value === 'system'
  if (!('window' in globalThis) || typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
