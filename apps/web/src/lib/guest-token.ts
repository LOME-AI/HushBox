/**
 * Guest token management for unauthenticated users.
 *
 * The token is stored in localStorage and sent with guest chat requests
 * to enable global rate limiting across sessions.
 */

export const GUEST_TOKEN_KEY = 'lome-guest-token';

/**
 * Get or create a guest token.
 * Creates a new UUID if no token exists in localStorage.
 */
export function getGuestToken(): string {
  let token = localStorage.getItem(GUEST_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(GUEST_TOKEN_KEY, token);
  }
  return token;
}

/**
 * Clear the guest token from localStorage.
 * Useful when user signs up (converts from guest to authenticated).
 */
export function clearGuestToken(): void {
  localStorage.removeItem(GUEST_TOKEN_KEY);
}
