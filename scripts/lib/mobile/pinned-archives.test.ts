import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CMDLINE_TOOLS_ARCHIVE,
  CMDLINE_TOOLS_BUILD,
  MAESTRO_ARCHIVE,
  MAESTRO_VERSION,
  verifyArchive,
  type PinnedArchive,
} from './pinned-archives.js';

const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function archiveHolding(contents: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pinned-archive-test-'));
  scratchRoots.push(root);
  const file = path.join(root, 'archive.zip');
  await writeFile(file, contents);
  return file;
}

const pinOf = (contents: string): PinnedArchive => ({
  url: 'https://example.invalid/archive.zip',
  sha256: createHash('sha256').update(contents).digest('hex'),
});

describe('verifyArchive', () => {
  it('accepts a download whose SHA-256 is the pinned one', async () => {
    const file = await archiveHolding('the pinned bytes');

    expect(() => {
      verifyArchive(file, pinOf('the pinned bytes'));
    }).not.toThrow();
  });

  it('refuses a download whose SHA-256 differs from the pinned one', async () => {
    const file = await archiveHolding('substituted bytes');

    expect(() => {
      verifyArchive(file, pinOf('the pinned bytes'));
    }).toThrow(/checksum mismatch for https:\/\/example\.invalid\/archive\.zip/);
  });
});

describe('the pinned Maestro archive', () => {
  it('is the release asset of the pinned version', () => {
    expect(MAESTRO_ARCHIVE.url).toBe(
      `https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip`
    );
  });

  it('carries a SHA-256 digest', () => {
    expect(MAESTRO_ARCHIVE.sha256).toMatch(/^[\da-f]{64}$/);
  });
});

describe('the pinned Android command-line tools archive', () => {
  it('is the Linux archive of the pinned build', () => {
    expect(CMDLINE_TOOLS_ARCHIVE.url).toBe(
      `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip`
    );
  });

  it('carries a SHA-256 digest', () => {
    expect(CMDLINE_TOOLS_ARCHIVE.sha256).toMatch(/^[\da-f]{64}$/);
  });
});
