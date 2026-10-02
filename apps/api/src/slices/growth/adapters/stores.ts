import { eq } from 'drizzle-orm';
import { campaigns } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { GrowthStores } from '../ports/index.js';

/**
 * The growth slice's reads. The campaign list is the only one: every other
 * growth table is written by the rollup and read by the admin plane, never by
 * a request path.
 */
export function createGrowthStores(): GrowthStores {
  return {
    listActiveCampaignTags(db) {
      return fromPromise(
        db
          .select({ tag: campaigns.tag })
          .from(campaigns)
          .where(eq(campaigns.status, 'active'))
          .orderBy(campaigns.tag),
        (cause) => unavailableError('growth campaign read failed', cause)
      ).map((rows) => rows.map((row) => row.tag));
    },
  };
}
