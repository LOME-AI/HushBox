import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, campaigns, createDb } from '@hushbox/db';
import { createGrowthStores } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for growth store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createGrowthStores();

/** Only the tags this file inserted, so a shared database is never emptied by it. */
const inserted: string[] = [];

afterAll(async () => {
  if (inserted.length > 0) await db.delete(campaigns).where(inArray(campaigns.tag, inserted));
});

/** A tag no other suite can be running under. */
function tag(): string {
  return `c-${crypto.randomUUID().slice(0, 8)}`;
}

async function insertCampaign(status: 'active' | 'archived'): Promise<string> {
  const value = tag();
  inserted.push(value);
  await db.insert(campaigns).values({ tag: value, label: `label ${value}`, status });
  return value;
}

/** Whether the read answered a tag, without asserting anything about rows other suites own. */
async function activeTags(): Promise<readonly string[]> {
  const result = await stores.listActiveCampaignTags(db);
  return result._unsafeUnwrap();
}

describe('listActiveCampaignTags', () => {
  it('answers a tag whose campaign is running', async () => {
    const running = await insertCampaign('active');
    expect(await activeTags()).toContain(running);
  });

  // Archived, never deleted: the row is the referent of growth rows kept
  // forever, so it has to stay resolvable while ceasing to count new visits.
  it('does not answer a tag whose campaign was archived', async () => {
    const retired = await insertCampaign('archived');
    expect(await activeTags()).not.toContain(retired);
  });

  // The whole list is stored under one Redis key and rewritten on every
  // refresh, so an unstable order would rewrite it for no change.
  it('answers the same order for the same state', async () => {
    await insertCampaign('active');
    expect(await activeTags()).toEqual(await activeTags());
  });

  it('answers the seeded tags every growth row can reference', async () => {
    const tags = await activeTags();
    expect(tags).toContain('direct');
    expect(tags).toContain('unknown');
  });

  // The beacon is unauthenticated, so the one database read on that path has
  // to fail as a value rather than as a throw the route cannot answer for.
  it('surfaces an unavailable error when the database cannot be reached', async () => {
    const unreachable = createDb('postgresql://nobody@127.0.0.1:1/none', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    const result = await stores.listActiveCampaignTags(unreachable);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
