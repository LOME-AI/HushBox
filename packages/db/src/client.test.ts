import { describe, it, expect, beforeAll } from 'vitest';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './client';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:4444/lome_chat';

describe('LOCAL_NEON_DEV_CONFIG', () => {
  it('has correct wsProxy function with string port', () => {
    const result = LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', '4444');
    expect(result).toBe('localhost:4444/v1');
  });

  it('has correct wsProxy function with number port', () => {
    const result = LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', 4444);
    expect(result).toBe('localhost:4444/v1');
  });

  it('has useSecureWebSocket set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.useSecureWebSocket).toBe(false);
  });

  it('has pipelineTLS set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.pipelineTLS).toBe(false);
  });

  it('has pipelineConnect set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.pipelineConnect).toBe(false);
  });
});

describe('createDb', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  it('creates a database instance', () => {
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
    expect(typeof db.insert).toBe('function');
    expect(typeof db.update).toBe('function');
    expect(typeof db.delete).toBe('function');
  });
});
