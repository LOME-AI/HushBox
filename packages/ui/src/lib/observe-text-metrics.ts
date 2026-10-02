/**
 * Runs `onChange` whenever text may have changed its drawn size without its box changing:
 * fonts finish loading, the root element's classes or style change (the accessibility
 * settings' text size, face and spacing, which live there) or the window resizes (the
 * root text size follows a media query). Framework-neutral, so a component calls it from
 * a layout effect and a static page from its own script. Returns the release.
 */
export function observeTextMetrics(onChange: () => void): () => void {
  const root = new MutationObserver(() => {
    onChange();
  });
  root.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  globalThis.addEventListener('resize', onChange);
  // Test DOMs have no FontFaceSet, and a component under test still mounts.
  const fonts = 'fonts' in document ? document.fonts : undefined;
  fonts?.addEventListener('loadingdone', onChange);
  return () => {
    root.disconnect();
    globalThis.removeEventListener('resize', onChange);
    fonts?.removeEventListener('loadingdone', onChange);
  };
}
