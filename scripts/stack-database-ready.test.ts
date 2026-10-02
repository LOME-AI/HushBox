import { describe, expect, it } from 'vitest';

import { ensureStackDatabaseReady } from './stack-database-ready.js';

const DEVELOPMENT_URL = 'postgres://postgres:postgres@neon.localhost/hushbox';
const E2E_URL = 'postgres://postgres:postgres@neon.localhost/hushbox_e2e';

describe('the stack-database gate', () => {
  it('creates the database the loaded connection string names', async () => {
    const asked: string[] = [];

    const outcome = await ensureStackDatabaseReady(
      { DATABASE_URL: E2E_URL },
      {
        ensureDatabase: ({ databaseName }) => {
          asked.push(databaseName);
          return Promise.resolve(true);
        },
      }
    );

    expect({ asked, outcome }).toEqual({
      asked: ['hushbox_e2e'],
      outcome: { databaseName: 'hushbox_e2e', created: true },
    });
  });

  it('reports a database the cluster already holds as one it did not create', async () => {
    const outcome = await ensureStackDatabaseReady(
      { DATABASE_URL: DEVELOPMENT_URL },
      { ensureDatabase: () => Promise.resolve(false) }
    );

    expect(outcome).toEqual({ databaseName: 'hushbox', created: false });
  });

  it('hands the connection the gate was pointed at to the maintenance step', async () => {
    const targets: string[] = [];

    await ensureStackDatabaseReady(
      { DATABASE_URL: E2E_URL },
      {
        ensureDatabase: ({ databaseUrl }) => {
          targets.push(databaseUrl);
          return Promise.resolve(true);
        },
      }
    );

    expect(targets).toEqual([E2E_URL]);
  });

  it('refuses when no stack environment is loaded', async () => {
    await expect(
      ensureStackDatabaseReady({}, { ensureDatabase: () => Promise.resolve(true) })
    ).rejects.toThrow(/DATABASE_URL/);
  });
});
