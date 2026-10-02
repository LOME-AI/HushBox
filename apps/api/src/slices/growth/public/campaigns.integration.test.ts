import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, campaigns, createDb } from '@hushbox/db';

import { runSettlement } from '../../../lib/idempotency/index.js';
import { archiveCampaignWithinTx, createCampaignWithinTx } from './campaigns.js';

import type { DomainError } from '../../../lib/errors/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for growth campaign write integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const minted: string[] = [];

/** A tag no other test holds, recorded so the suite cleans up exactly what it created. */
function freshTag(): string {
  const tag = `mint-${crypto.randomUUID().slice(0, 8)}`;
  minted.push(tag);
  return tag;
}

afterAll(async () => {
  if (minted.length > 0) await db.delete(campaigns).where(inArray(campaigns.tag, minted));
});

async function rowFor(tag: string): Promise<{ label: string; status: string } | undefined> {
  const rows = await db
    .select({ label: campaigns.label, status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.tag, tag));
  return rows[0];
}

describe('createCampaignWithinTx', () => {
  it('lands an active campaign that survives the caller transaction', async () => {
    const tag = freshTag();
    const created = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Spring launch' })
    );
    const row = created._unsafeUnwrap();

    expect(row).toEqual({
      tag,
      label: 'Spring launch',
      status: 'active',
      createdAt: expect.any(Date),
    });
    expect(await rowFor(tag)).toEqual({ label: 'Spring launch', status: 'active' });
  });

  it('writes nothing when the caller transaction rolls back', async () => {
    const tag = freshTag();

    await expect(
      runSettlement(db, async (tx) => {
        const result = await createCampaignWithinTx(tx, { tag, label: 'abandoned' });
        expect(result.isOk()).toBe(true);
        throw new Error('the caller abandons its own transaction');
      })
    ).rejects.toThrow('the caller abandons its own transaction');

    expect(await rowFor(tag)).toBeUndefined();
  });

  it('stores the label without its surrounding whitespace', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: '  Podcast  ' })
    );
    expect(await rowFor(tag)).toEqual({ label: 'Podcast', status: 'active' });
  });

  it('refuses a tag the shared tag schema rejects', async () => {
    const result = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag: 'Spring Launch', label: 'Spring launch' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses the seeded tag that means no campaign', async () => {
    const result = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag: 'direct', label: 'Direct' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await rowFor('direct')).toEqual({ label: 'Direct', status: 'active' });
  });

  it('refuses the seeded tag that means the campaign could not be told', async () => {
    const result = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag: 'unknown', label: 'Unknown' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a tag shaped like a per-person identifier', async () => {
    // A real minted identifier rather than a written-out one: the shape is the
    // subject of the test, and a literal of that shape is itself a privacy
    // finding wherever it is written.
    const result = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag: crypto.randomUUID(), label: 'one visitor' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a label that is only whitespace', async () => {
    const tag = freshTag();
    const result = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: '   ' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await rowFor(tag)).toBeUndefined();
  });

  it('answers the standing row when the same campaign is created twice', async () => {
    const tag = freshTag();
    const first = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Replayed' })
    );
    const second = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Replayed' })
    );
    expect(second._unsafeUnwrap()).toEqual(first._unsafeUnwrap());
  });

  it('refuses a tag an active campaign with another label already holds', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) => createCampaignWithinTx(tx, { tag, label: 'Held' }));
    const result = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Something else' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
    expect(await rowFor(tag)).toEqual({ label: 'Held', status: 'active' });
  });

  it('stores the new label when a create returns an archived campaign to active', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Retired name' })
    );
    await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, tag));

    const recreated = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Revived name' })
    );

    expect(recreated._unsafeUnwrap().status).toBe('active');
    expect(await rowFor(tag)).toEqual({ label: 'Revived name', status: 'active' });
  });
});

describe('archiveCampaignWithinTx', () => {
  it('retires the campaign the create landed and keeps its row', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) => createCampaignWithinTx(tx, { tag, label: 'Retiring' }));

    const archived = await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, tag));

    expect(archived._unsafeUnwrap().status).toBe('archived');
    expect(await rowFor(tag)).toEqual({ label: 'Retiring', status: 'archived' });
  });

  it('restores the campaign the archive retired when the create runs again', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) => createCampaignWithinTx(tx, { tag, label: 'Round trip' }));
    await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, tag));

    const restored = await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Round trip' })
    );

    expect(restored._unsafeUnwrap().status).toBe('active');
    expect(await rowFor(tag)).toEqual({ label: 'Round trip', status: 'active' });
  });

  it('answers the archived row when the campaign is already archived', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Twice retired' })
    );
    const first = await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, tag));
    const second = await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, tag));
    expect(second._unsafeUnwrap()).toEqual(first._unsafeUnwrap());
  });

  it('writes nothing when the caller transaction rolls back', async () => {
    const tag = freshTag();
    await runSettlement(db, async (tx) =>
      createCampaignWithinTx(tx, { tag, label: 'Kept active' })
    );

    await expect(
      runSettlement(db, async (tx) => {
        const result = await archiveCampaignWithinTx(tx, tag);
        expect(result.isOk()).toBe(true);
        throw new Error('the caller abandons its own transaction');
      })
    ).rejects.toThrow('the caller abandons its own transaction');

    expect(await rowFor(tag)).toEqual({ label: 'Kept active', status: 'active' });
  });

  it('refuses to retire the seeded tag that means no campaign', async () => {
    const result = await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, 'direct'));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await rowFor('direct')).toEqual({ label: 'Direct', status: 'active' });
  });

  it('refuses to retire the seeded tag that means the campaign could not be told', async () => {
    const result = await runSettlement(db, async (tx) => archiveCampaignWithinTx(tx, 'unknown'));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await rowFor('unknown')).toEqual({ label: 'Unknown', status: 'active' });
  });

  it('answers not found for a tag no campaign holds', async () => {
    const result = await runSettlement(db, async (tx) =>
      archiveCampaignWithinTx(tx, 'no-campaign-holds-this-tag')
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});

describe('a campaign statement the database cannot answer', () => {
  it('resolves to an unavailable value where the bare statement rejects', async () => {
    const tag = freshTag();
    let error: DomainError | undefined;

    await runSettlement(db, async (tx) => {
      // The counter-case is the first assertion: one failing statement aborts
      // the transaction, so every later statement on it rejects inside the
      // driver. What follows is a claim about this door converting that
      // rejection into a value the caller can classify.
      await expect(tx.execute(sql`select 1 / 0`)).rejects.toThrow();
      const refusal = await createCampaignWithinTx(tx, { tag, label: 'never lands' });
      error = refusal._unsafeUnwrapErr();
    });

    expect(error?.code).toBe('unavailable');
    expect(error?.cause).toBeInstanceOf(Error);
  });
});
