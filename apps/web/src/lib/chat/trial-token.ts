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
 * The stored trial token, or null — the read that does NOT mint one.
 *
 * A display-only read must never persist a token: minting on sight would write
 * localStorage for every anonymous visitor, including one who has sent nothing.
 * With the header absent the server answers off the caller's IP counter, which
 * is the same identity the send gate applies.
 */
export function peekTrialToken(): string | null {
  return localStorage.getItem(TRIAL_TOKEN_KEY);
}

/**
 * Store the server-authoritative trial token, replacing any locally minted one.
 */
export function setTrialToken(token: string): void {
  localStorage.setItem(TRIAL_TOKEN_KEY, token);
}
