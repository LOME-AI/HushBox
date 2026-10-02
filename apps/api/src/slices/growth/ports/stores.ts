import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * What the growth slice reads out of its own tables. One entry today: the
 * campaign tags a beacon's `?c=` may name.
 *
 * It is a port rather than a direct query because the domain decides WHEN to
 * read (on a registry miss, never per beacon) and the adapter decides HOW.
 */
export interface GrowthStores {
  /**
   * Every tag whose campaign is active, ordered so two reads of one state
   * answer one value — the registry stores the list, and an unstable order
   * would rewrite it on every refresh for no change.
   */
  readonly listActiveCampaignTags: (db: Database) => ResultAsync<readonly string[], DomainError>;
}
