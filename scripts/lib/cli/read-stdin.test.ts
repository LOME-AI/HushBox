import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';

import { readStdin } from './read-stdin.js';

const feed = (...chunks: readonly Buffer[]): AsyncIterable<Uint8Array> => Readable.from(chunks);

describe('readStdin', () => {
  it('returns an empty string for a stream that yields nothing', async () => {
    await expect(readStdin(feed())).resolves.toBe('');
  });

  it('joins the chunks a stream yields', async () => {
    const chunks = [Buffer.from('refs/heads/main a '), Buffer.from('refs/heads/main b\n')];
    await expect(readStdin(feed(...chunks))).resolves.toBe('refs/heads/main a refs/heads/main b\n');
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = Buffer.from('é');
    await expect(readStdin(feed(bytes.subarray(0, 1), bytes.subarray(1)))).resolves.toBe('é');
  });
});
