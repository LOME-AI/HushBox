import { runSettlement } from '../lib/idempotency/index.js';
import { createAnnouncementsStores } from '../slices/announcements/index.js';
import type { Database } from '@hushbox/db';

/**
 * Set the global banner to disabled with no messages. Dev/test only: the
 * harness restore that must never be refused, so it writes through the
 * announcements store directly and bypasses the rate-limited `banner.set`
 * admin op, its audit row and its inverse.
 */
export async function resetBanner(db: Database): Promise<void> {
  const stores = createAnnouncementsStores(db);
  await runSettlement(db, async (tx) => {
    await stores.config.setWithinTx(tx, { enabled: false, messages: [] });
  });
}
