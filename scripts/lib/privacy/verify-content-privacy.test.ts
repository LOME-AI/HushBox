import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chunkBySizeBudget,
  parseBatchCheck,
  parseBatchOutput,
  parseIndexListing,
  readAllowlistFromIndex,
  readIndexBlobs,
} from './verify-content-privacy.js';

const ISO_INSTANT = ['2026-08-16', 'T', '14', ':', '30', ':', '45', 'Z'].join('');

describe('chunkBySizeBudget', () => {
  it('groups blobs until the byte budget is reached', () => {
    const blobs = [
      { path: 'a', objectId: 'a'.repeat(40), size: 4 },
      { path: 'b', objectId: 'b'.repeat(40), size: 4 },
      { path: 'c', objectId: 'c'.repeat(40), size: 4 },
    ];

    expect(chunkBySizeBudget(blobs, 8).map((batch) => batch.map((blob) => blob.path))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('gives a blob larger than the whole budget a batch of its own', () => {
    const blobs = [
      { path: 'a', objectId: 'a'.repeat(40), size: 2 },
      { path: 'huge', objectId: 'd'.repeat(40), size: 99 },
      { path: 'b', objectId: 'b'.repeat(40), size: 2 },
    ];

    expect(chunkBySizeBudget(blobs, 8).map((batch) => batch.map((blob) => blob.path))).toEqual([
      ['a'],
      ['huge'],
      ['b'],
    ]);
  });

  it('returns no batches for no blobs', () => {
    expect(chunkBySizeBudget([], 8)).toEqual([]);
  });
});

describe('git batch parsing', () => {
  const OBJECT_ID = 'a'.repeat(40);
  const entry = { path: 'a.md', objectId: OBJECT_ID };

  it('fails loudly when a batch answer is truncated', () => {
    expect(() => parseBatchOutput(Buffer.from(`${OBJECT_ID} blob 4`), [entry])).toThrow(
      /no record/
    );
  });

  it('fails loudly when a batch answer reports a missing object', () => {
    const output = Buffer.from(`${OBJECT_ID} missing\n`);

    expect(() => parseBatchOutput(output, [entry])).toThrow(/could not resolve/);
  });

  it('fails loudly when the batch-check answer is short', () => {
    expect(() => parseBatchCheck('', [entry, { path: 'b.md', objectId: OBJECT_ID }])).toThrow(
      /could not resolve/
    );
  });

  it('fails loudly when batch-check reports a missing object', () => {
    expect(() => parseBatchCheck(`${OBJECT_ID} missing\n`, [entry])).toThrow(/could not resolve/);
  });

  // A positional read of field two turns this record into a plausible size, and
  // a wrong size slices the payload at the wrong offset for every record after.
  it('rejects an unresolved record whose third token happens to be a number', () => {
    const record = 'some path 40 missing';

    expect(() => parseBatchCheck(record, [entry])).toThrow(/could not resolve/);
  });

  it('rejects a resolution whose type is not a blob', () => {
    expect(() => parseBatchCheck(`${OBJECT_ID} tree 40`, [entry])).toThrow(/could not resolve/);
  });
});

describe('parseIndexListing', () => {
  const OBJECT_ID = 'b'.repeat(40);

  it('reads the object id and path of each staged entry', () => {
    const listing = `100644 ${OBJECT_ID} 0\tdocs/a.md\u0000100644 ${OBJECT_ID} 0\tsrc/b.ts\u0000`;

    expect(parseIndexListing(listing)).toEqual([
      { path: 'docs/a.md', objectId: OBJECT_ID },
      { path: 'src/b.ts', objectId: OBJECT_ID },
    ]);
  });

  it('keeps a tab inside a path with the path', () => {
    const listing = `100644 ${OBJECT_ID} 0\tdocs/a\tb.md\u0000`;

    expect(parseIndexListing(listing)[0]?.path).toBe('docs/a\tb.md');
  });

  it('skips a gitlink, whose id names another repository’s commit rather than a blob', () => {
    const listing = `160000 ${OBJECT_ID} 0\tvendor/thing\u0000100644 ${OBJECT_ID} 0\tdocs/a.md\u0000`;

    expect(parseIndexListing(listing).map((entry) => entry.path)).toEqual(['docs/a.md']);
  });

  it('reads a resolved entry once, ignoring the conflict stages beside it', () => {
    const listing =
      `100644 ${OBJECT_ID} 1\tdocs/a.md\u0000` +
      `100644 ${OBJECT_ID} 0\tdocs/a.md\u0000` +
      `100644 ${OBJECT_ID} 2\tdocs/a.md\u0000`;

    expect(parseIndexListing(listing)).toEqual([{ path: 'docs/a.md', objectId: OBJECT_ID }]);
  });

  it('reads a path carrying only conflict stages exactly once', () => {
    const ours = 'c'.repeat(40);
    const listing = `100644 ${OBJECT_ID} 2\tdocs/a.md\u0000100644 ${ours} 3\tdocs/a.md\u0000`;

    expect(parseIndexListing(listing)).toEqual([{ path: 'docs/a.md', objectId: OBJECT_ID }]);
  });

  it('refuses a record carrying no object-id field at all', () => {
    expect(() => parseIndexListing(`100644\tdocs/a.md\u0000`)).toThrow(/cannot address/);
  });

  it('refuses a record whose object id is not one', () => {
    expect(() => parseIndexListing(`100644 nope 0\tdocs/a.md\u0000`)).toThrow(/cannot address/);
  });
});

describe('the index readers over a repository', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'content-privacy-test-'));
    execaSync('git', ['-C', rootDir, 'init', '--quiet']);
    write('privacy-allowlist.json', `${JSON.stringify({ entries: [] }, null, 2)}\n`);
    stage();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function write(relativePath: string, contents: string): void {
    const absolute = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  function stage(): void {
    execaSync('git', ['-C', rootDir, 'add', '--all']);
  }

  it('reads blob content from the index rather than the worktree', async () => {
    write('a.md', 'staged content\n');
    stage();
    write('a.md', 'worktree content\n');

    const blobs = await readIndexBlobs(rootDir, ['a.md']);

    expect(blobs.map((blob) => blob.path)).toEqual(['a.md']);
    expect(Buffer.from(blobs[0]?.bytes ?? []).toString('utf8')).toBe('staged content\n');
  });

  it('fails loudly when a requested path is absent from the index', async () => {
    await expect(readIndexBlobs(rootDir, ['missing.md'])).rejects.toThrow(/missing\.md/);
  });

  function ruleNamedAllowlist(): string {
    return `${JSON.stringify(
      {
        entries: [
          {
            clause: 'content',
            description: 'the byte is the evidence the record is making',
            path: 'docs/a.md',
            rule: 'undecodable-encoding',
            evidence: {
              is: 'a separator quoted in prose',
              shownBy: 'used as a separator',
            },
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  it('reads the staged allowlist entry whole, evidence block intact', async () => {
    write('privacy-allowlist.json', ruleNamedAllowlist());
    stage();

    await expect(readAllowlistFromIndex(rootDir)).resolves.toEqual([
      {
        clause: 'content',
        description: 'the byte is the evidence the record is making',
        path: 'docs/a.md',
        rule: 'undecodable-encoding',
        evidence: {
          is: 'a separator quoted in prose',
          shownBy: 'used as a separator',
        },
      },
    ]);
  });

  it('reads the allowlist from the index, so an unstaged edit cannot take effect', async () => {
    stage();
    write(
      'privacy-allowlist.json',
      `${JSON.stringify({ entries: [{ description: 'unstaged', path: 'docs/a.md' }] }, null, 2)}\n`
    );

    await expect(readAllowlistFromIndex(rootDir)).resolves.toEqual([]);
  });

  it('fails loudly when the allowlist is absent from the index', async () => {
    execaSync('git', ['-C', rootDir, 'rm', '--cached', '--quiet', 'privacy-allowlist.json']);

    await expect(readAllowlistFromIndex(rootDir)).rejects.toThrow(/privacy-allowlist\.json/);
  });

  it('refuses a tracked path carrying a newline rather than desynchronising records', async () => {
    write('a.md', 'nothing to see\n');
    write('b\nc.md', 'nothing to see either\n');
    stage();

    await expect(readIndexBlobs(rootDir, ['a.md'])).rejects.toThrow(/newline/);
  });

  it('reads the file a path names, not a blob its name resolves to as a revision', async () => {
    write('clean.txt', 'nothing to see\n');
    write('0:clean.txt', `ran at ${['14', '30'].join(':')}\n`);
    stage();

    const blobs = await readIndexBlobs(rootDir, ['0:clean.txt']);

    expect(Buffer.from(blobs[0]?.bytes ?? []).toString('utf8')).toContain('ran at');
  });

  it('keeps blobs matched to their own paths across a newline-free tree', async () => {
    write('a.md', 'first\n');
    write('b.md', `ran at ${ISO_INSTANT}\n`);
    write('c.md', 'third\n');
    stage();

    const blobs = await readIndexBlobs(rootDir, ['a.md', 'b.md', 'c.md']);

    expect(blobs.map((entry) => Buffer.from(entry.bytes).toString('utf8'))).toEqual([
      'first\n',
      `ran at ${ISO_INSTANT}\n`,
      'third\n',
    ]);
  });
});
