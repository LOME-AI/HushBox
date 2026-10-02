import { describe, it, expect } from 'vitest';

import { r2PutArgs } from './r2.js';
import { wranglerPersistPath } from '../../wrangler-dev.js';

describe('which store an object is written to', () => {
  it('writes a local object into the store of the stack it runs under', () => {
    expect(r2PutArgs('bucket/object', '/var/artifact', 'e2e')).toEqual([
      'r2',
      'object',
      'put',
      'bucket/object',
      '--file',
      '/var/artifact',
      '--local',
      '--persist-to',
      wranglerPersistPath('e2e'),
    ]);
  });

  it('names no local store when publishing to the production bucket', () => {
    const args = r2PutArgs('bucket/object', '/var/artifact', 'remote');

    expect(args).toContain('--remote');
    expect(args).not.toContain('--persist-to');
  });

  // The scan in ./store-writers.ts accepts a call to this builder in place of the
  // flags themselves, so the builder answering with neither would make that
  // acceptance a hole.
  it.each([['remote'], ['development'], ['e2e']] as const)(
    'says where a %s write lands, whichever target it is given',
    (target) => {
      const args = r2PutArgs('bucket/object', '/var/artifact', target);

      expect(args.includes('--remote') || args.includes('--persist-to')).toBe(true);
    }
  );
});
