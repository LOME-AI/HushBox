import { describe, expect, it } from 'vitest';
import { markdownContinuation } from '@/lib/chat/markdown-continuation';

describe('markdownContinuation: code fences', () => {
  it('closes an open fence before a row and reopens it after', () => {
    const before = 'After the upgrade:\n\n```sql\nSELECT relname\nFROM pg_stat_user_tables';
    const after = '\nWHERE last_analyze IS NULL;\n```\n\nAny table listed kept its statistics.';

    expect(markdownContinuation(before, after)).toEqual({
      before: `${before}\n\`\`\``,
      after: '```sql\nWHERE last_analyze IS NULL;\n```\n\nAny table listed kept its statistics.',
    });
  });

  it('closes a fence that already ends on a newline without adding a blank code line', () => {
    const result = markdownContinuation('```\nline one\n', 'line two\n```');
    expect(result.before).toBe('```\nline one\n```');
    expect(result.after).toBe('```\nline two\n```');
  });

  it('matches a tilde fence and its length, so the close is a valid close', () => {
    const result = markdownContinuation('~~~~python\nprint(1)', 'print(2)\n~~~~');
    expect(result.before).toBe('~~~~python\nprint(1)\n~~~~');
    expect(result.after).toBe('~~~~python\nprint(2)\n~~~~');
  });

  it('leaves text whose fences are all closed untouched', () => {
    const before = '```js\nconst a = 1;\n```\n\nDone.';
    expect(markdownContinuation(before, 'Next.')).toEqual({ before, after: 'Next.' });
  });

  it('does not take a shorter run of backticks for the close of a longer fence', () => {
    const before = '````\n```\nstill code';
    expect(markdownContinuation(before, 'more').before).toBe(`${before}\n\`\`\`\``);
  });

  it('does not take a fence line with an info string for a close', () => {
    const before = '```\ncode\n```js';
    expect(markdownContinuation(before, 'x').before).toBe(`${before}\n\`\`\``);
  });

  it('does not take a backtick line whose info string holds a backtick for a fence', () => {
    const before = '```not`a fence\nmore';
    expect(markdownContinuation(before, 'after')).toEqual({ before, after: 'after' });
  });

  it('ignores a fence indented four spaces, which is an indented code line', () => {
    const before = 'Text\n    ```\nmore';
    expect(markdownContinuation(before, 'after')).toEqual({ before, after: 'after' });
  });
});

describe('markdownContinuation: tables', () => {
  const TABLE = '| Feature | Version |\n| --- | --- |\n| uuidv7 | 18 |';

  it('repeats the header and delimiter rows when the text after the row continues the table', () => {
    const result = markdownContinuation(TABLE, '\n| async io | 18 |');
    expect(result.before).toBe(TABLE);
    expect(result.after).toBe('| Feature | Version |\n| --- | --- |\n| async io | 18 |');
  });

  it('does not reopen a table when the text after the row starts a paragraph', () => {
    expect(markdownContinuation(TABLE, 'That is all.')).toEqual({
      before: TABLE,
      after: 'That is all.',
    });
  });

  it('does not reopen a table a blank line already ended', () => {
    const before = `${TABLE}\n\nA paragraph.`;
    expect(markdownContinuation(before, '| x | y |').after).toBe('| x | y |');
  });

  it('keeps a table open through a trailing line without pipes, which is still one of its rows', () => {
    const result = markdownContinuation(`${TABLE}\nplain row`, '| async io | 18 |');
    expect(result.after).toBe('| Feature | Version |\n| --- | --- |\n| async io | 18 |');
  });

  it('does not take pipes without a delimiter row for a table', () => {
    const before = 'a | b\nc | d';
    expect(markdownContinuation(before, '| e | f |').after).toBe('| e | f |');
  });
});

describe('markdownContinuation: numbered lists', () => {
  it('resumes a numbered list at the next number across a row', () => {
    const before = 'Before you upgrade:\n\n1. Read the notes.\n2. Check the extensions.';
    const result = markdownContinuation(before, '\n1. Move accounts off MD5.');
    expect(result.before).toBe(before);
    expect(result.after).toBe('3. Move accounts off MD5.');
  });

  it('resumes a list whose text ends on a newline', () => {
    expect(markdownContinuation('1. a\n2. b\n', '1. c').after).toBe('3. c');
  });

  it('counts items of a lazily numbered list rather than trusting the last marker', () => {
    const result = markdownContinuation('1. a\n1. b\n1. c', '1. d');
    expect(result.after).toBe('4. d');
  });

  it('continues from the number the list started at', () => {
    const result = markdownContinuation('5) five\n6) six', '1) seven');
    expect(result.after).toBe('7) seven');
  });

  it('counts an item whose text wraps onto an indented or lazy continuation line', () => {
    const before = '1. first\n   wrapped\n2. second\nlazy line\n\n   indented paragraph';
    expect(markdownContinuation(before, '1. third').after).toBe('3. third');
  });

  it('keeps counting past a bullet list nested inside an item', () => {
    expect(markdownContinuation('1. a\n   - sub\n1. b', '1. c').after).toBe('3. c');
  });

  it('does not continue a list that a heading ended', () => {
    expect(markdownContinuation('1. a\n# Heading', '1. b').after).toBe('1. b');
  });

  it('leaves the text after the row alone when it does not open with a list item', () => {
    expect(markdownContinuation('1. a\n2. b', 'A closing paragraph.').after).toBe(
      'A closing paragraph.'
    );
  });

  it('does not continue a list that a paragraph after a blank line ended', () => {
    expect(markdownContinuation('1. a\n2. b\n\nA paragraph.', '1. c').after).toBe('1. c');
  });

  it('does not continue a list whose delimiter differs from the next item', () => {
    expect(markdownContinuation('1. a\n2. b', '1) c').after).toBe('1) c');
  });

  it('does not continue a bullet list as a numbered one', () => {
    expect(markdownContinuation('- a\n- b', '1. c').after).toBe('1. c');
  });
});
