/**
 * Inline `<head>` accessibility-bootstrap script.
 *
 * Runs synchronously before bundles load and before first paint. Mirrors the
 * essentials of `applySettings()`, the reduced-motion broadcaster, and the
 * font loader so the chosen contrast, font, motion, etc. are present on
 * `<html>` before any pixels are committed.
 *
 * The `reduced-motion` class is set from the OR of two sources — the
 * stored `stopAnimations` flag and the OS `prefers-reduced-motion: reduce`
 * media query — so the class shows up pre-paint even when the OS alone is
 * driving it and no stored a11y prefs exist.
 *
 * Constraints:
 *  - Must be a self-contained string (no imports).
 *  - Must never throw.
 *  - Keep this in sync with `apply-settings.ts` + `reduced-motion-broadcaster.ts`.
 */
export const A11Y_INIT_SCRIPT: string = String.raw`
(function () {
  try {
    var KEY = 'hushbox.a11y.v1';
    var html = document.documentElement;
    var add = function (name, on) { if (on) html.classList.add(name); };

    var osReducedMotion = false;
    try {
      osReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}

    var raw;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { raw = null; }

    var s = null;
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.state === 'object' && parsed.state !== null) s = parsed.state;
      } catch (e) {}
    }

    var storedStopAnimations = s !== null && s.stopAnimations === true;
    add('reduced-motion', osReducedMotion || storedStopAnimations);

    if (s === null) return;

    add('a11y-contrast-increased', s.contrast === 'increased');
    add('a11y-contrast-high', s.contrast === 'high');
    add('a11y-contrast-low', s.contrast === 'low');

    add('a11y-saturate-0', s.saturation === '0');
    add('a11y-saturate-50', s.saturation === '50');
    add('a11y-saturate-150', s.saturation === '150');

    add('a11y-cb-protan', s.colorblindSimulate === 'protan');
    add('a11y-cb-deutan', s.colorblindSimulate === 'deutan');
    add('a11y-cb-tritan', s.colorblindSimulate === 'tritan');
    add('a11y-cb-achroma', s.colorblindSimulate === 'achroma');
    add('a11y-cb-achromatomaly', s.colorblindSimulate === 'achromatomaly');

    add('a11y-font-scale-88', s.fontSize === '88');
    add('a11y-font-scale-112', s.fontSize === '112');
    add('a11y-font-scale-124', s.fontSize === '124');
    add('a11y-font-scale-141', s.fontSize === '141');

    add('a11y-letter-spacing-loose', s.letterSpacing === '0.05');
    add('a11y-letter-spacing-loosest', s.letterSpacing === '0.12');
    add('a11y-line-height-tight', s.lineHeight === '1.0');
    add('a11y-line-height-tall', s.lineHeight === '1.5');
    add('a11y-line-height-double', s.lineHeight === '2.0');
    add('a11y-para-spacing-double', s.paragraphSpacing === '2');

    add('a11y-cursor-large', s.cursorSize === 'large');
    add('a11y-cursor-xlarge', s.cursorSize === 'xlarge');
    add('a11y-cursor-white', s.cursorColor === 'white');

    add('a11y-focus-strong', s.focusWidth !== '0');
    add('a11y-focus-halo', s.focusHalo === true);

    if (s.focusWidth) html.style.setProperty('--a11y-focus-width', s.focusWidth + 'px');
    if (s.focusColor) html.style.setProperty('--a11y-focus-color', s.focusColor);

    var validFonts = { atkinson: 1, 'open-dyslexic': 1, lexend: 1 };
    if (s.fontFamily && validFonts[s.fontFamily]) {
      var fontId = s.fontFamily;
      var fontUrl = '/fonts/a11y/' + fontId + '.woff2';
      add('a11y-font-override', true);

      var link = document.createElement('link');
      link.setAttribute('rel', 'preload');
      link.setAttribute('as', 'font');
      link.setAttribute('type', 'font/woff2');
      link.setAttribute('crossorigin', 'anonymous');
      link.setAttribute('href', fontUrl);
      document.head.appendChild(link);

      // OpenDyslexic's intrinsic metrics render ~15% larger than the other
      // a11y fonts at the same point size; shrink it via the @font-face
      // size-adjust descriptor so it visually matches when applied.
      var sizeAdjust = fontId === 'open-dyslexic' ? " size-adjust: 85%;" : "";
      var faceStyle = document.createElement('style');
      faceStyle.textContent = "@font-face { font-family: '" + fontId + "'; src: url('" + fontUrl + "') format('woff2'); font-display: block;" + sizeAdjust + " }";
      document.head.appendChild(faceStyle);

      var overrideStyle = document.createElement('style');
      overrideStyle.textContent = "html.a11y-font-override body * { font-family: '" + fontId + "', system-ui, sans-serif !important; }";
      document.head.appendChild(overrideStyle);
    }
  } catch (e) {
  }
})();
`;
