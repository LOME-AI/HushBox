import { getFont, type AccessibilityFont } from '../fonts/registry';

const loadedFonts = new Set<string>();

/**
 * Lazy-load and activate the chosen accessibility font.
 * Idempotent — calling with the same id twice does not re-load the binary.
 * Calling with 'system' clears the override (does NOT unload — fonts stay cached).
 */
export async function activateFont(id: AccessibilityFont['id']): Promise<void> {
  const font = getFont(id);
  if (!font) throw new Error(`Unknown accessibility font id: ${id}`);

  if (id === 'system' || font.url === null) {
    document.documentElement.classList.remove('a11y-font-override');
    document.documentElement.style.removeProperty('--a11y-font-family');
    return;
  }

  if (!loadedFonts.has(id)) {
    const face = new FontFace(id, `url(${font.url}) format('woff2')`, { display: 'block' });
    await face.load();
    document.fonts.add(face);
    loadedFonts.add(id);
  }

  document.documentElement.style.setProperty('--a11y-font-family', `"${id}"`);
  document.documentElement.classList.add('a11y-font-override');
}

/** For tests — reset the cache so the next activateFont call re-loads. */
export function _resetFontLoaderForTesting(): void {
  loadedFonts.clear();
}
