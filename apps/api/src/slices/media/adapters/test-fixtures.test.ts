import { afterEach, describe, expect, it } from 'vitest';
import { RUN_TOKEN_VARIABLE, scratchBucketRunToken } from '@hushbox/db/test-db';
import { createScratchBucket } from './test-fixtures.js';

describe('createScratchBucket', () => {
  const savedEndpoint = process.env['R2_S3_ENDPOINT'];
  const savedToken = process.env[RUN_TOKEN_VARIABLE];

  afterEach(() => {
    process.env['R2_S3_ENDPOINT'] = savedEndpoint;
    process.env[RUN_TOKEN_VARIABLE] = savedToken ?? '';
  });

  it('names the bucket after the run that owns it, so a reclaimer can attribute it', async () => {
    const scratch = await createScratchBucket();
    try {
      expect(scratchBucketRunToken(scratch.bucket)).toBe(savedToken);
    } finally {
      await scratch.destroy();
    }
  });

  it('fails fast when nothing says which run would own the bucket', async () => {
    process.env[RUN_TOKEN_VARIABLE] = '';

    await expect(createScratchBucket()).rejects.toThrow(RUN_TOKEN_VARIABLE);
  });

  it('fails fast when the storage environment is missing', async () => {
    delete process.env['R2_S3_ENDPOINT'];

    await expect(createScratchBucket()).rejects.toThrow('R2_S3_ENDPOINT');
  });

  it('surfaces a failed bucket create', async () => {
    // Path-style request lands as an object PUT into a bucket that does not
    // exist, so the server answers non-2xx and no bucket is ever created.
    process.env['R2_S3_ENDPOINT'] = `${savedEndpoint ?? ''}/no-such-bucket-prefix`;

    await expect(createScratchBucket()).rejects.toThrow('create');
  });
});
