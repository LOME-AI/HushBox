/**
 * Whether a connection URL names the machine the process is running on.
 *
 * The one place this policy is written. Dev/test-only tooling that creates or
 * drops databases asserts it before its first statement, so a `DATABASE_URL`
 * that resolves to production aborts instead of executing against it.
 */

// `new URL('postgres://[::1]:5432/db').hostname` returns the bracketed form
// `[::1]`, so the bracketed literal — not the bare `::1` — is what an
// IPv6-loopback dev URL is checked against.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** An unparseable URL is not provably local, so it fails closed (treated as remote). */
export function isLocalHostUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host);
}
