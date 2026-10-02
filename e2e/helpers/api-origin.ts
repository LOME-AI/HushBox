import { requireEnv } from './env.js';

/**
 * The backend host:port. Backend routes are bare (no `/api/` prefix) after the
 * rewrite, so "is this a backend request?" is decided by the API host:port —
 * localhost/127.0.0.1 on `HB_API_PORT` — not by a path substring. The same
 * host:port also serves the conversation WebSocket, so host-matching covers
 * both. Read once at module load (`requireEnv` fail-fasts if the stack env
 * wasn't generated).
 */
export const apiPort = requireEnv('HB_API_PORT');
const API_REQUEST_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Whether `url` is a backend (API/WebSocket) request: its host is
 * localhost/127.0.0.1 AND its port is `HB_API_PORT`. Pure and browser-free.
 * An unparseable URL is treated as not-backend.
 */
export function isApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return API_REQUEST_HOSTS.has(parsed.hostname) && parsed.port === apiPort;
}

/**
 * `recordHar.urlFilter` matching backend traffic by the API origin
 * (`://localhost:<port>/` or `://127.0.0.1:<port>/`), built from `HB_API_PORT`
 * so worktree-offset ports stay correct without hardcoding. Covers `http(s)://`
 * and the `ws(s)://` WebSocket on the same host:port. `apiPort` is digits, so
 * it carries no regex metacharacters.
 */
export const API_HAR_URL_FILTER = new RegExp(String.raw`://(?:localhost|127\.0\.0\.1):${apiPort}/`);
