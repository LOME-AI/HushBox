import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '@hushbox/shared/durations';
import { rideOutSeconds } from '../../../../lib/jobs/backoff.js';
import { DESCRIPTOR_VERSION } from './normalize.js';
import {
  CATALOG_REFRESH_JOB_DECLARATION,
  CATALOG_REFRESH_JOB_TYPE,
  catalogRefreshEnqueueRegistration,
} from './refresh-job-declaration.js';
import { createCatalogRefreshJobRegistration } from './refresh-job.js';
import type { JobExecution } from '../../../../lib/jobs/index.js';
import type { RefreshCatalogDeps } from './refresh.js';

function neverResolved(): RefreshCatalogDeps {
  throw new Error('the declaration tests never run the handler');
}

function executionFor(descriptorVersion: string): JobExecution<{ descriptorVersion: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload: { descriptorVersion },
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

/** The jitter source at its midpoint, which yields the nominal backoff. */
const NOMINAL_JITTER = (): number => 0.5;

describe('the catalog refresh job declaration', () => {
  it('names the job catalog.refresh.v1', () => {
    expect(CATALOG_REFRESH_JOB_TYPE).toBe('catalog.refresh.v1');
    expect(CATALOG_REFRESH_JOB_DECLARATION.type).toBe(CATALOG_REFRESH_JOB_TYPE);
  });

  it('declares the natural idempotency class, because the refresh converges by upsert', () => {
    expect(CATALOG_REFRESH_JOB_DECLARATION.idempotency).toBe('natural');
  });

  it('runs on the bulk shard', () => {
    expect(CATALOG_REFRESH_JOB_DECLARATION.shard).toBe('bulk');
  });

  it('retries across more than an hour of outage before the row dead-letters', () => {
    const rideOutMs =
      rideOutSeconds(CATALOG_REFRESH_JOB_DECLARATION.maxFailures, NOMINAL_JITTER) * 1000;
    expect(rideOutMs).toBeGreaterThan(HOUR_MS);
  });

  it('accepts a payload naming a descriptor version', () => {
    const { schema } = CATALOG_REFRESH_JOB_DECLARATION;
    expect(schema.safeParse({ descriptorVersion: DESCRIPTOR_VERSION }).success).toBe(true);
  });

  it('rejects a payload with an empty descriptor version', () => {
    expect(
      CATALOG_REFRESH_JOB_DECLARATION.schema.safeParse({ descriptorVersion: '' }).success
    ).toBe(false);
  });

  it('rejects a payload with no descriptor version', () => {
    expect(CATALOG_REFRESH_JOB_DECLARATION.schema.safeParse({}).success).toBe(false);
  });
});

describe('the dispatcher catalog refresh registration', () => {
  it('carries the declaration', () => {
    const registration = createCatalogRefreshJobRegistration({ resolveRefresh: neverResolved });
    expect(registration).toMatchObject(CATALOG_REFRESH_JOB_DECLARATION);
  });
});

describe('the enqueue-side catalog refresh registration', () => {
  it('carries the declaration', () => {
    expect(catalogRefreshEnqueueRegistration).toMatchObject(CATALOG_REFRESH_JOB_DECLARATION);
  });

  it('refuses to run its handler, which only the dispatcher registration can', async () => {
    await expect(
      catalogRefreshEnqueueRegistration.handler(executionFor(DESCRIPTOR_VERSION))
    ).rejects.toThrow(/dispatcher/);
  });
});
