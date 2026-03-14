import { Browser } from '@capacitor/browser';
import { MARKETING_BASE_URL } from '@hushbox/shared';
import { isNative } from './platform.js';

/** Opens a URL in the system browser (native) or a new tab (web). */
export async function openExternalUrl(url: string): Promise<void> {
  if (isNative()) {
    await Browser.open({ url });
  } else {
    window.open(url, '_blank');
  }
}

/**
 * Opens a marketing site page by path.
 *
 * On native, constructs the full URL (Browser.open requires absolute URLs).
 * On web, uses the relative path (same domain).
 */
export async function openExternalPage(path: string): Promise<void> {
  if (isNative()) {
    await Browser.open({ url: `${MARKETING_BASE_URL}${path}` });
  } else {
    window.open(path, '_blank');
  }
}
