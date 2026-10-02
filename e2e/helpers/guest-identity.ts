import { test } from '@playwright/test';
import { projectGuestIp } from '../../scripts/lib/playwright/identities.js';

/**
 * The address a spec presents when its traffic must be a guest rather than the
 * project's own caller — a sessionless reader of a share link, a link guest, a
 * trial send. Off Cloudflare every sessionless caller that presents no address
 * hashes to one shared `unknown` identity, so guest traffic that does not
 * present one of these spends a single suite-wide window — the 120/60s
 * guest-conversation and 30/60s public share-read caps among them.
 *
 * Derived from the running project and worker slot (`projectGuestIp`), never
 * written out: a literal is one window every project shares, which is what the
 * per-project caller identity exists to end, and the dev reset that clears
 * these windows derives the same address from the same two values.
 *
 * Must be called inside a test or a test-scoped fixture — reads `test.info()`
 * lazily, the same way persona resolution does, so a module-scope constant is
 * not an option.
 */
export function guestIp(): string {
  const info = test.info();
  return projectGuestIp(info.project.name, info.parallelIndex);
}
