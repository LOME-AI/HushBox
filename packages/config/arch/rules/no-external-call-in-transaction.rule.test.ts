import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './no-external-call-in-transaction.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const STORES_PATH = 'apps/api/src/slices/billing/adapters/stores.ts';

describe('no-external-call-in-transaction', () => {
  it('accepts a transaction whose body only touches the db', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await tx.insert(ledger).values(legs);
        return tx.update(wallets).set({ balance }).where(cond);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a bare fetch inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await tx.insert(payments).values(row);
        await fetch('https://provider.example/charge', { method: 'POST' });
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: STORES_PATH });
    expect(violations[0]?.message).toMatch(/fetch/);
  });

  it('flags a globalThis.fetch inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await globalThis.fetch('https://provider.example/charge');
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a fetch nested deeper inside the transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await Promise.all(rows.map((row) => fetch(row.url)));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a fetch that lives outside any transaction (pattern D keeps the external call out)', () => {
    const project = projectWith(
      STORES_PATH,
      `async function preClaimThenCharge() {
        await db.transaction(async (tx) => tx.insert(payments).values(row));
        const external = await fetch('https://provider.example/charge');
        await db.transaction(async (tx) => tx.update(payments).set({ external }).where(cond));
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/adapters/stores.test.ts',
      `db.transaction(async (tx) => {
        await fetch('https://provider.example/charge');
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a transaction call with no callback argument', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/settle.ts',
      'export const handle = db.transaction();\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a transaction whose body calls through a non-name callee', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/settle.ts',
      `db.transaction(async (tx) => {
        await handlers[0]();
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores browser-environment test files', () => {
    const project = projectWith(
      'apps/web/src/lib/device-key-store.test.tsx',
      `db.transaction(async (tx) => {
        await fetch('https://provider.example/charge');
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a Redis client call inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await tx.insert(ledger).values(legs);
        await redis.set(holdKey, hold);
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: STORES_PATH, line: 3 });
    expect(violations[0]?.message).toMatch(/Redis/);
  });

  it('flags a client call whose receiver names Redis only earlier in its chain', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await withClient(deps.redis).set(holdKey, hold);
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/Redis/);
  });

  it('flags a Redis registry helper inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await redisSet(redis, HOLD_KEY, walletId, hold);
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/Redis/);
  });

  it('accepts a Redis call that lives outside any transaction', () => {
    const project = projectWith(
      STORES_PATH,
      `async function holdThenSettle() {
        await redisSet(redis, HOLD_KEY, walletId, hold);
        await redis.get(holdKey);
        await db.transaction(async (tx) => tx.insert(ledger).values(legs));
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a registry helper that makes no Redis round trip inside a transaction', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        const entry = redisMGetEntry(HOLD_KEY, walletId);
        await tx.insert(ledger).values({ ...legs, key: entry.key });
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an injected storage-port call inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await deps.storage.put(key, bytes);
        await tx.insert(contentItems).values(row);
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: STORES_PATH, line: 2 });
    expect(violations[0]?.message).toMatch(/Storage/);
  });

  it('flags an injected telemetry-port call inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        telemetry.error('settlement_failed', { errorCode });
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/Telemetry/);
  });

  it('accepts a transaction whose body calls through a computed receiver', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await sinks[0].record(row);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a pure domain call inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        const price = pricing.compute(usage);
        await stores.insertLegs(tx, legsFor(price));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a fetch inside a transaction in a package', () => {
    const project = projectWith(
      'packages/db/src/workers-validation/evidence.ts',
      `db.transaction(async (tx) => {
        await fetch('https://provider.example/charge');
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/db/src/workers-validation/evidence.ts',
      line: 2,
    });
  });
});
