import type { AccessibilityPreferences } from '@hushbox/shared';

type ClassToggle = readonly [className: string, present: boolean];

function buildToggles(prefs: AccessibilityPreferences): ClassToggle[] {
  return [
    ['a11y-contrast-increased', prefs.contrast === 'increased'],
    ['a11y-contrast-high', prefs.contrast === 'high'],
    ['a11y-contrast-low', prefs.contrast === 'low'],

    ['a11y-saturate-0', prefs.saturation === '0'],
    ['a11y-saturate-50', prefs.saturation === '50'],
    ['a11y-saturate-150', prefs.saturation === '150'],

    ['a11y-cb-protan', prefs.colorblindSimulate === 'protan'],
    ['a11y-cb-deutan', prefs.colorblindSimulate === 'deutan'],
    ['a11y-cb-tritan', prefs.colorblindSimulate === 'tritan'],
    ['a11y-cb-achroma', prefs.colorblindSimulate === 'achroma'],
    ['a11y-cb-achromatomaly', prefs.colorblindSimulate === 'achromatomaly'],

    ['a11y-font-scale-125', prefs.fontSize === '125'],
    ['a11y-font-scale-150', prefs.fontSize === '150'],
    ['a11y-font-scale-175', prefs.fontSize === '175'],
    ['a11y-font-scale-200', prefs.fontSize === '200'],

    ['a11y-letter-spacing-loose', prefs.letterSpacing === '0.05'],
    ['a11y-letter-spacing-loosest', prefs.letterSpacing === '0.12'],

    ['a11y-line-height-tall', prefs.lineHeight === '1.5'],
    ['a11y-line-height-double', prefs.lineHeight === '2.0'],

    ['a11y-para-spacing-double', prefs.paragraphSpacing === '2'],

    ['a11y-font-override', prefs.fontFamily !== 'system'],

    ['a11y-cursor-large', prefs.cursorSize === 'large'],
    ['a11y-cursor-xlarge', prefs.cursorSize === 'xlarge'],

    ['a11y-cursor-white', prefs.cursorColor === 'white'],

    // focusWidth === '0' means "no custom focus ring" — leave the browser default alone.
    ['a11y-focus-strong', prefs.focusWidth !== '0'],
    ['a11y-focus-halo', prefs.focusHalo],
  ];
}

export function applySettings(
  prefs: AccessibilityPreferences,
  root: HTMLElement = document.documentElement
): void {
  for (const [className, present] of buildToggles(prefs)) {
    root.classList.toggle(className, present);
  }
  root.style.setProperty('--a11y-focus-width', `${prefs.focusWidth}px`);
  root.style.setProperty('--a11y-focus-color', prefs.focusColor);
}
