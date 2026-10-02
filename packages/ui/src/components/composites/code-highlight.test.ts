import { describe, it, expect } from 'vitest';
import {
  CODE_TOKEN_KINDS,
  CODE_TOKEN_THEME,
  highlightLines,
  languageForPath,
} from './code-highlight';

describe('languageForPath', () => {
  it('reads the language off a TypeScript path', () => {
    expect(languageForPath('apps/api/src/lib/jobs/pass.ts')).toBe('typescript');
  });

  it('reads the language off a component path', () => {
    expect(languageForPath('apps/web/src/components/chat/message-item.tsx')).toBe('tsx');
  });

  it('reads the language off a path in another language entirely', () => {
    expect(languageForPath('scripts/report.py')).toBe('python');
  });

  it('ignores the case of the extension', () => {
    expect(languageForPath('docs/README.MD')).toBe('markdown');
  });

  it('has no language for an extension it cannot highlight', () => {
    expect(languageForPath('packages/db/drizzle/0001_snapshot.bin')).toBeNull();
  });

  it('has no language for a file with no extension at all', () => {
    expect(languageForPath('scripts/Dockerfile')).toBeNull();
  });

  it('does not read a directory name as an extension', () => {
    expect(languageForPath('apps/api.ts/handler')).toBeNull();
  });
});

describe('highlightLines', () => {
  it('returns one row of tokens per line of source', () => {
    const rows = highlightLines(['const a = 1;', 'const b = 2;'], 'typescript');

    expect(rows).toHaveLength(2);
  });

  it('names the kind of a keyword', () => {
    const [row] = highlightLines(['const a = 1;'], 'typescript');

    expect(row?.[0]).toEqual({ text: 'const', kind: 'keyword' });
  });

  it('names the kind of a comment', () => {
    const [row] = highlightLines(['// a note'], 'typescript');

    expect(row?.at(-1)).toEqual({ text: '// a note', kind: 'comment' });
  });

  it('leaves plain text with no kind of its own', () => {
    const [row] = highlightLines(['plain'], 'typescript');

    expect(row?.[0]).toEqual({ text: 'plain', kind: null });
  });

  it('loses no source text to tokenizing', () => {
    const source = ['export function add(left: number): string {', '  return `${left}`;', '}'];

    const rows = highlightLines(source, 'typescript');

    expect(rows.map((row) => row.map((token) => token.text).join(''))).toEqual(source);
  });

  it('highlights a language whose grammar is nothing like the default one', () => {
    const [row] = highlightLines(['SELECT 1;'], 'sql');

    expect(row?.[0]).toEqual({ text: 'SELECT', kind: 'keyword' });
  });

  it('keeps an empty line as a row of its own', () => {
    const rows = highlightLines(['const a = 1;', '', 'const b = 2;'], 'typescript');

    expect(rows).toHaveLength(3);
  });

  it('leaves a line of only whitespace with nothing to paint', () => {
    const rows = highlightLines(['   '], 'typescript');

    expect(rows[0]?.map((token) => token.kind)).toEqual([null]);
  });
});

describe('CODE_TOKEN_THEME', () => {
  it.each(CODE_TOKEN_KINDS)('hands a %s token back as its code-token variable', (kind) => {
    expect(JSON.stringify(CODE_TOKEN_THEME)).toContain(`var(--code-token-${kind})`);
  });

  it('hands untyped text back as the code foreground variable', () => {
    expect(JSON.stringify(CODE_TOKEN_THEME)).toContain('var(--code-foreground)');
  });
});
