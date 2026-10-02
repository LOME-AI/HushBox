import { describe, expect, it } from 'vitest';
import { recordPatterns, withoutRecordsBlock } from './patterns.js';

const BLOCK = [
  '# BEGIN records overlay — tracked by .records.git (pnpm records), never by this repository',
  'docs/runs/',
  '',
  'docs/audits/*/',
  '/.records.git/',
  '# END records overlay',
].join('\n');

const GITIGNORE = ['node_modules/', '# a comment', '', '*.log', BLOCK, '*.local*', ''].join('\n');

describe('recordPatterns', () => {
  it('reads the patterns between the block markers', () => {
    expect(recordPatterns(GITIGNORE)).toEqual(['docs/runs/', 'docs/audits/*/']);
  });

  it('leaves out the overlay git directory', () => {
    expect(recordPatterns(GITIGNORE)).not.toContain('/.records.git/');
  });

  it('refuses a file with no block', () => {
    expect(() => recordPatterns('node_modules/\n')).toThrow(/BEGIN records overlay/);
  });

  it('refuses a block that is never closed', () => {
    expect(() => recordPatterns(BLOCK.replace('# END records overlay', ''))).toThrow(
      /END records overlay/
    );
  });
});

describe('withoutRecordsBlock', () => {
  it('drops the block from its first marker to its last', () => {
    expect(withoutRecordsBlock(GITIGNORE)).toBe(
      ['node_modules/', '# a comment', '', '*.log', '*.local*', ''].join('\n')
    );
  });

  it('keeps the bytes outside the block, line endings included', () => {
    const crlf = ['*.log', BLOCK, '*.local*', ''].join('\r\n');

    expect(withoutRecordsBlock(crlf)).toBe('*.log\r\n*.local*\r\n');
  });
});
