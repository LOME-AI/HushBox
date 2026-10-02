import { useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { ROUTES } from '@hushbox/shared';
import { APP_RETURN_TO_BILLING_URL } from '@hushbox/shared/billing-portal';
import { closeInAppBrowser, isInAppBrowserOpen } from '../browser.js';
import { isNative } from '../platform.js';

/** Safe default when an incoming deep link can't be trusted. */
const FALLBACK_PATH = '/';

/**
 * Internal routes a deep link outside the custom scheme may reach, as exact
 * paths or prefixes.
 *
 * Token-sensitive auth routes (`/verify`, `/billing-portal`, `/login`,
 * `/signup`) and dev-only routes are deliberately excluded: a deep link must
 * not be able to drive navigation to them with attacker-supplied query tokens.
 */
const ALLOWED_PREFIXES = [
  '/chat',
  '/share/m',
  '/share/c',
  '/settings',
  '/usage',
  '/billing',
  '/accessibility',
] as const;

/**
 * Whether a deep link may drive navigation to `pathname`.
 *
 * Exported so the platform-parity test can ask the allowlist itself, rather
 * than restate {@link ALLOWED_PREFIXES} and its matching rule.
 */
export function isAllowedPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

const RETURN_LINK = new URL(APP_RETURN_TO_BILLING_URL);

type CustomSchemeLink = 'return-link' | 'other' | 'not-custom-scheme';

/**
 * Sorts a URL by the app's custom scheme. Any web page or app can fire that scheme, so its
 * one purpose is the billing portal's return link: the exact scheme, host and path, whatever
 * query or hash rides on it. A lone trailing slash still matches, since an OS or browser may
 * append one. Every other custom-scheme URL goes to {@link FALLBACK_PATH}.
 */
function classifyCustomScheme(url: string): CustomSchemeLink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not-custom-scheme';
  }
  if (parsed.protocol !== RETURN_LINK.protocol) return 'not-custom-scheme';
  const isReturnLink =
    parsed.host === RETURN_LINK.host && parsed.pathname.replace(/\/$/, '') === RETURN_LINK.pathname;
  return isReturnLink ? 'return-link' : 'other';
}

/**
 * Closes the sheet the billing portal was opened in. iOS always asks the plugin. Android asks
 * only while the sheet has not reported finished.
 */
function closePortalSheet(): void {
  if (Capacitor.getPlatform() === 'ios' || isInAppBrowserOpen()) {
    void closeInAppBrowser();
  }
}

/**
 * Parses an untrusted deep-link URL into a safe in-app path.
 *
 * Returns the validated `pathname + search + hash`, or {@link FALLBACK_PATH}
 * when the URL is malformed, protocol-relative (`//host`), or targets a route
 * outside the allowlist.
 *
 * The fragment is forwarded because the share routes read their decryption key
 * out of it; stripping it would leave shared content undecryptable. Nothing
 * narrows the fragment's content, so {@link ALLOWED_PREFIXES} is the only bound
 * on which routes receive attacker-influenced fragment bytes.
 */
function toSafePath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return FALLBACK_PATH;
  }

  if (!isAllowedPath(parsed.pathname)) return FALLBACK_PATH;

  return parsed.pathname + parsed.search + parsed.hash;
}

/**
 * Listens for universal/app links opened from outside the app.
 *
 * The billing portal's return link, on the app's custom scheme, passes the
 * Billing route to the callback and closes the in-app browser sheet; any other
 * custom-scheme URL falls back to a safe default route. Every other URL is
 * validated against an allowlist of deep-linkable routes before delegating to
 * the callback, which should navigate via TanStack Router; malformed or
 * non-allowlisted links fall back to the same default. No-op on web.
 *
 * @param onDeepLink - Receives a validated URL path (e.g. `/chat/123`)
 */
export function useDeepLinks(onDeepLink?: (path: string) => void): void {
  const callbackRef = useRef(onDeepLink);
  callbackRef.current = onDeepLink;

  useEffect(() => {
    if (!isNative()) return;

    const listener = App.addListener('appUrlOpen', ({ url }) => {
      const customScheme = classifyCustomScheme(url);
      if (customScheme === 'return-link') {
        callbackRef.current?.(ROUTES.BILLING);
        closePortalSheet();
        return;
      }
      callbackRef.current?.(customScheme === 'other' ? FALLBACK_PATH : toSafePath(url));
    });

    return () => {
      void (async () => {
        const handle = await listener;
        await handle.remove();
      })();
    };
  }, []);
}
