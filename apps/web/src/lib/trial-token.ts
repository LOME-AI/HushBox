/**
 * Trial token management for unauthenticated users.
 *
 * The token is stored in localStorage and sent with trial chat requests
 * to enable global rate limiting across sessions.
 */

export const TRIAL_TOKEN_KEY = 'hushbox-trial-token';

/**
 * Get or create a trial token.
 * Creates a new UUID if no token exists in localStorage.
 */
export function getTrialToken(): string {
  let token = localStorage.getItem(TRIAL_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(TRIAL_TOKEN_KEY, token);
  }
  return token;
}

/**
 * Clear the trial token from localStorage.
 * Useful when user signs up (converts from trial to authenticated).
 */
export function clearTrialToken(): void {
  localStorage.removeItem(TRIAL_TOKEN_KEY);
}
