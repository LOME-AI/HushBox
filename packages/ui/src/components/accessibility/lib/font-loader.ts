import atkinsonUrl from '../fonts/atkinson-hyperlegible.woff2';
import lexendUrl from '../fonts/lexend.woff2';
import openDyslexicUrl from '../fonts/open-dyslexic.woff2';

type AccessibilityFontId = 'system' | 'atkinson' | 'open-dyslexic' | 'lexend';

const FONT_URLS: Record<Exclude<AccessibilityFontId, 'system'>, string> = {
  atkinson: atkinsonUrl,
  lexend: lexendUrl,
  'open-dyslexic': openDyslexicUrl,
};

const loadedFonts = new Set<string>();

export async function activateFont(id: AccessibilityFontId): Promise<void> {
  if (id === 'system') {
    document.documentElement.classList.remove('a11y-font-override');
    document.documentElement.style.removeProperty('--a11y-font-family');
    return;
  }

  const url = FONT_URLS[id];
  if (!loadedFonts.has(id)) {
    const face = new FontFace(id, `url(${url}) format('woff2')`, { display: 'block' });
    await face.load();
    document.fonts.add(face);
    loadedFonts.add(id);
  }

  document.documentElement.style.setProperty('--a11y-font-family', `"${id}"`);
  document.documentElement.classList.add('a11y-font-override');
}

export function _resetFontLoaderForTesting(): void {
  loadedFonts.clear();
}
