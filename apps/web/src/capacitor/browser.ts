import { Browser } from '@capacitor/browser';
import { MARKETING_BASE_URL } from '@hushbox/shared';
import { isNative } from './platform.js';
import type { PluginListenerHandle } from '@capacitor/core';

let sheetOpen = false;
let finishedListener: Promise<PluginListenerHandle> | undefined;

/** Opens a URL in the in-app browser sheet (native) or a new tab (web). */
export async function openExternalUrl(url: string): Promise<void> {
  if (isNative()) {
    finishedListener ??= Browser.addListener('browserFinished', () => {
      sheetOpen = false;
    });
    await finishedListener;
    await Browser.open({ url });
    sheetOpen = true;
  } else {
    window.open(url, '_blank');
  }
}

/**
 * Whether a sheet {@link openExternalUrl} opened is still recorded as up: neither the plugin's
 * `browserFinished` nor {@link closeInAppBrowser} has cleared it since.
 */
export function isInAppBrowserOpen(): boolean {
  return sheetOpen;
}

/** The iOS plugin's rejection when no sheet is presented, the very state a close aims for. */
const NOTHING_TO_CLOSE = 'No active window to close!';

/** Closes the in-app browser sheet; resolves when there was none to close. */
export async function closeInAppBrowser(): Promise<void> {
  try {
    await Browser.close();
  } catch (error) {
    if (!(error instanceof Error && error.message === NOTHING_TO_CLOSE)) throw error;
  }
  sheetOpen = false;
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
