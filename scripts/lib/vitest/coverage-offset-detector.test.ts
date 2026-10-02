import { describe, expect, it, vi } from 'vitest';

import {
  attributeTestFile,
  collectRawCoverage,
  findOffsetDivergences,
  formatOffsetDivergences,
  type RawCoverageFile,
} from './coverage-offset-detector.js';

const raw = (
  entries: readonly { readonly url: string; readonly startOffset?: number }[]
): RawCoverageFile => ({ result: entries });

describe('attributeTestFile', () => {
  it('names the test file whose own module the raw file recorded', () => {
    const file = raw([{ url: 'file:///p/src/a.ts' }, { url: 'file:///p/src/a.test.ts' }]);
    expect(attributeTestFile(file, 'coverage-3.json')).toBe('file:///p/src/a.test.ts');
  });

  it('recognises a spec file as the attribution too', () => {
    const file = raw([{ url: 'file:///p/src/b.spec.tsx' }]);
    expect(attributeTestFile(file, 'coverage-3.json')).toBe('file:///p/src/b.spec.tsx');
  });

  it('falls back to the raw file name when no test module is present', () => {
    const file = raw([{ url: 'file:///p/src/a.ts' }]);
    expect(attributeTestFile(file, 'coverage-3.json')).toBe('coverage-3.json');
  });
});

describe('findOffsetDivergences', () => {
  it('reports nothing when every url carries one offset', () => {
    const files = [
      raw([
        { url: 'file:///p/src/a.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 209 },
      ]),
      raw([
        { url: 'file:///p/src/b.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 209 },
      ]),
    ].map((file, index) => ({ name: `coverage-${String(index)}.json`, file }));

    expect(findOffsetDivergences(files)).toEqual([]);
  });

  it('reports a url recorded under two distinct offsets', () => {
    const files = [
      raw([
        { url: 'file:///p/src/a.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 209 },
      ]),
      raw([
        { url: 'file:///p/src/b.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 0 },
      ]),
    ].map((file, index) => ({ name: `coverage-${String(index)}.json`, file }));

    expect(findOffsetDivergences(files)).toEqual([
      {
        url: 'file:///p/src/s.ts',
        offsets: [
          { startOffset: 0, testFiles: ['file:///p/src/b.test.ts'] },
          { startOffset: 209, testFiles: ['file:///p/src/a.test.ts'] },
        ],
      },
    ]);
  });

  it('lists every test file contributing an offset', () => {
    const files = [
      raw([
        { url: 'file:///p/src/a.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 209 },
      ]),
      raw([
        { url: 'file:///p/src/b.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 209 },
      ]),
      raw([
        { url: 'file:///p/src/c.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 0 },
      ]),
    ].map((file, index) => ({ name: `coverage-${String(index)}.json`, file }));

    const [divergence] = findOffsetDivergences(files);
    expect(divergence?.offsets).toEqual([
      { startOffset: 0, testFiles: ['file:///p/src/c.test.ts'] },
      { startOffset: 209, testFiles: ['file:///p/src/a.test.ts', 'file:///p/src/b.test.ts'] },
    ]);
  });

  it('orders several divergent modules by url so the message is stable across runs', () => {
    const files = [
      raw([
        { url: 'file:///p/src/a.test.ts', startOffset: 209 },
        { url: 'file:///p/src/z.ts', startOffset: 209 },
        { url: 'file:///p/src/m.ts', startOffset: 209 },
      ]),
      raw([
        { url: 'file:///p/src/b.test.ts', startOffset: 209 },
        { url: 'file:///p/src/z.ts', startOffset: 0 },
        { url: 'file:///p/src/m.ts', startOffset: 0 },
      ]),
    ].map((file, index) => ({ name: `coverage-${String(index)}.json`, file }));

    expect(findOffsetDivergences(files).map((divergence) => divergence.url)).toEqual([
      'file:///p/src/m.ts',
      'file:///p/src/z.ts',
    ]);
  });

  it('treats a missing startOffset as zero, matching the coverage provider', () => {
    const files = [
      raw([{ url: 'file:///p/src/a.test.ts' }, { url: 'file:///p/src/s.ts' }]),
      raw([
        { url: 'file:///p/src/b.test.ts', startOffset: 209 },
        { url: 'file:///p/src/s.ts', startOffset: 0 },
      ]),
    ].map((file, index) => ({ name: `coverage-${String(index)}.json`, file }));

    // s.ts is offset 0 in both files; only the two test modules differ, and each
    // is recorded by one file only, so nothing diverges.
    expect(findOffsetDivergences(files)).toEqual([]);
  });

  it('tolerates a raw file with no result array', () => {
    const files = [{ name: 'coverage-0.json', file: {} }];
    expect(findOffsetDivergences(files)).toEqual([]);
  });
});

describe('collectRawCoverage', () => {
  it('reads every coverage json in the directory', () => {
    const entries = collectRawCoverage('/cov/.tmp', {
      readdir: () => ['coverage-0.json', 'coverage-1.json'],
      readFile: (file) =>
        file.endsWith('coverage-0.json')
          ? '{"result":[{"url":"file:///p/a.test.ts","startOffset":209}]}'
          : '{"result":[{"url":"file:///p/b.test.ts","startOffset":209}]}',
    });

    expect(entries.map((entry) => entry.name)).toEqual(['coverage-0.json', 'coverage-1.json']);
  });

  it('skips a truncated raw file rather than failing the run', () => {
    // A killed run leaves a half-written coverage file behind; observed in
    // a leftover .tmp directory in this repo.
    const entries = collectRawCoverage('/cov/.tmp', {
      readdir: () => ['coverage-0.json', 'coverage-1.json'],
      readFile: (file) =>
        file.endsWith('coverage-0.json') ? '{"result":[' : '{"result":[{"url":"file:///p/b.ts"}]}',
    });

    expect(entries.map((entry) => entry.name)).toEqual(['coverage-1.json']);
  });

  it('ignores non-json directory entries', () => {
    const entries = collectRawCoverage('/cov/.tmp', {
      readdir: () => ['notes.txt', 'coverage-0.json'],
      readFile: () => '{"result":[]}',
    });

    expect(entries.map((entry) => entry.name)).toEqual(['coverage-0.json']);
  });

  it('yields nothing when the directory is absent', () => {
    const readdir = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(collectRawCoverage('/cov/.tmp', { readdir, readFile: () => '' })).toEqual([]);
  });
});

describe('formatOffsetDivergences', () => {
  const divergences = [
    {
      url: 'file:///p/src/s.ts',
      offsets: [
        { startOffset: 0, testFiles: ['file:///p/src/b.test.ts'] },
        { startOffset: 209, testFiles: ['file:///p/src/a.test.ts'] },
      ],
    },
  ];

  it('names the module whose offsets disagree', () => {
    expect(formatOffsetDivergences('ops', divergences).join('\n')).toContain('/p/src/s.ts');
  });

  it('names each offset and the test files that recorded it', () => {
    const text = formatOffsetDivergences('ops', divergences).join('\n');
    expect(text).toContain('offset 0');
    expect(text).toContain('b.test.ts');
    expect(text).toContain('offset 209');
    expect(text).toContain('a.test.ts');
  });

  it('states that the coverage numbers are wrong, not merely suspect', () => {
    const text = formatOffsetDivergences('ops', divergences).join('\n');
    expect(text).toContain('COVERAGE OFFSET DIVERGENCE');
  });

  it('caps the test files it prints so one bad module cannot flood the log', () => {
    const many = Array.from(
      { length: 12 },
      (_, index) => `file:///p/src/t${String(index)}.test.ts`
    );
    const text = formatOffsetDivergences('ops', [
      {
        url: 'file:///p/src/s.ts',
        offsets: [
          { startOffset: 0, testFiles: many },
          { startOffset: 209, testFiles: ['file:///p/src/a.test.ts'] },
        ],
      },
    ]).join('\n');

    expect(text).toContain('+7 more');
  });
});
