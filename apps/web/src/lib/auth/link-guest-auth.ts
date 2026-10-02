/**
 * The single owner of link-guest mode: the window in which the app is viewing a
 * shared conversation on a link secret rather than on the visitor's session.
 *
 * While a link auth token is set, the API client sends every request with the
 * token as its link credential and with credentials deliberately omitted (see
 * its link-guest branch), so nothing the server answers during that window is
 * evidence about the signed-in session. That is why the
 * revocation classifier, the `/me` restore path and the session-derived query
 * gates all read the mode from here instead of each deciding for itself what it
 * means: a 401 on a cookie-less request must never be read as a revoked session.
 *
 * The mode is reactive because it is entered from the share route's layout
 * effect — after the providers above it have already rendered — so a consumer
 * that only sampled it during its own first render would read it as inactive.
 */

import * as React from 'react';

/** The base64 link auth token the share URL's secret derives: a secret, sent only as the link credential header. */
let linkAuthTokenBase64: string | null = null;

const listeners = new Set<() => void>();

// Safe to notify synchronously: the mode is only ever set from a layout effect
// and cleared from that effect's cleanup, never during render.
function notifyLinkGuestChange(): void {
  for (const listener of listeners) listener();
}

export function setLinkGuestAuth(authTokenBase64: string): void {
  linkAuthTokenBase64 = authTokenBase64;
  notifyLinkGuestChange();
}

export function getLinkGuestAuth(): string | null {
  return linkAuthTokenBase64;
}

export function clearLinkGuestAuth(): void {
  linkAuthTokenBase64 = null;
  notifyLinkGuestChange();
}

/** Whether the app is currently viewing a share link as a link guest. */
export function isLinkGuestActive(): boolean {
  return linkAuthTokenBase64 !== null;
}

/** Subscribe to mode changes. For use with React's useSyncExternalStore. */
export function subscribeLinkGuestAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the caller whenever link-guest mode is entered or left. */
export function useLinkGuestActive(): boolean {
  return React.useSyncExternalStore(subscribeLinkGuestAuth, isLinkGuestActive);
}
