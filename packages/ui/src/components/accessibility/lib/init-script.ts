/**
 * Inline `<head>` accessibility-bootstrap script.
 *
 * Runs synchronously before bundles load and before first paint. Mirrors the
 * essentials of `applySettings()` and `font-loader` so the chosen contrast,
 * theme, font, motion, etc. are present on `<html>` before any pixels are
 * committed — eliminating FOUC.
 *
 * Constraints:
 *  - Must be a self-contained string (no imports). Both apps inline it via
 *    `<script>` set:html (Astro) or `dangerouslySetInnerHTML` (Vite/SPA).
 *  - Must never throw. Bad localStorage data → no-op.
 *  - Must NOT depend on the bundled JS — duplicates the class-mapping logic
 *    intentionally so it works even if the bundle 404s.
 *
 * Keep this in sync with `apply-settings.ts` — any new setting added there
 * with FOUC potential needs an entry here too.
 */
export const A11Y_INIT_SCRIPT: string = String.raw`
(function () {
  try {
    var KEY = 'hushbox.a11y.v1';
    var raw;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return; }
    var s = parsed && parsed.state;
    if (!s || typeof s !== 'object') return;

    var html = document.documentElement;
    var add = function (name, on) { if (on) html.classList.add(name); };

    // Contrast
    add('a11y-contrast-increased', s.contrast === 'increased');
    add('a11y-contrast-high', s.contrast === 'high');
    add('a11y-contrast-low', s.contrast === 'low');

    // Saturation
    add('a11y-saturate-0', s.saturation === '0');
    add('a11y-saturate-50', s.saturation === '50');
    add('a11y-saturate-150', s.saturation === '150');

    // Invert / highlight links
    add('a11y-invert', s.invert === true);
    add('a11y-highlight-links', s.highlightLinks === true);

    // Colorblind simulate
    add('a11y-cb-protan', s.colorblindSimulate === 'protan');
    add('a11y-cb-deutan', s.colorblindSimulate === 'deutan');
    add('a11y-cb-tritan', s.colorblindSimulate === 'tritan');
    add('a11y-cb-achroma', s.colorblindSimulate === 'achroma');
    add('a11y-cb-achromatomaly', s.colorblindSimulate === 'achromatomaly');

    // Colorblind correct (CSS for these is a v2 enhancement)
    add('a11y-cb-correct-protan', s.colorblindCorrect === 'protan');
    add('a11y-cb-correct-deutan', s.colorblindCorrect === 'deutan');
    add('a11y-cb-correct-tritan', s.colorblindCorrect === 'tritan');
    add('a11y-cb-correct-achroma', s.colorblindCorrect === 'achroma');

    // Font scale
    add('a11y-font-scale-125', s.fontSize === '125');
    add('a11y-font-scale-150', s.fontSize === '150');
    add('a11y-font-scale-175', s.fontSize === '175');
    add('a11y-font-scale-200', s.fontSize === '200');

    // Letter / line / paragraph spacing
    add('a11y-letter-spacing-loose', s.letterSpacing === '0.05');
    add('a11y-letter-spacing-loosest', s.letterSpacing === '0.12');
    add('a11y-line-height-tall', s.lineHeight === '1.5');
    add('a11y-line-height-double', s.lineHeight === '2.0');
    add('a11y-para-spacing-double', s.paragraphSpacing === '2');
    add('a11y-force-left', s.forceLeftAlign === true);

    // Cursor
    add('a11y-cursor-large', s.cursorSize === 'large');
    add('a11y-cursor-xlarge', s.cursorSize === 'xlarge');
    add('a11y-cursor-white', s.cursorColor === 'white');

    // Stop animations — tri-state honors prefers-reduced-motion when 'system'
    var stopAnim = false;
    if (s.stopAnimations === 'force-on') stopAnim = true;
    else if (s.stopAnimations === 'force-off') stopAnim = false;
    else if (s.stopAnimations === 'system') {
      try {
        stopAnim = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) { stopAnim = false; }
    }
    add('a11y-stop-animations', stopAnim);

    // Focus indicator — combined class fires on any non-default focus setting
    var focusStrong = (s.focusWidth && s.focusWidth !== '2')
      || (s.focusColor && s.focusColor !== 'yellow')
      || (s.focusHalo === true);
    add('a11y-focus-strong', focusStrong);
    add('a11y-focus-halo', s.focusHalo === true);

    // CSS custom properties — picked up by pointer.css outline rule
    if (s.focusWidth) html.style.setProperty('--a11y-focus-width', s.focusWidth + 'px');
    if (s.focusColor) html.style.setProperty('--a11y-focus-color', s.focusColor);

    // Font family override + synchronous preload to avoid font-snap on reload.
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

      var faceStyle = document.createElement('style');
      faceStyle.textContent = "@font-face { font-family: '" + fontId + "'; src: url('" + fontUrl + "') format('woff2'); font-display: block; }";
      document.head.appendChild(faceStyle);

      var overrideStyle = document.createElement('style');
      overrideStyle.textContent = "html.a11y-font-override body * { font-family: '" + fontId + "', system-ui, sans-serif !important; }";
      document.head.appendChild(overrideStyle);
    }
  } catch (e) {
    // Never throw — accessibility init must not break the page.
  }
})();
`;
