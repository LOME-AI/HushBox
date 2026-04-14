import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafePath, renderPage, resolvePort } from './preview-readme.js';

const MINIMAL_CSS = '.markdown-body { color: #24292f; }';

describe('resolvePort', () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env['HB_README_PREVIEW_PORT'];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env['HB_README_PREVIEW_PORT'];
    } else {
      process.env['HB_README_PREVIEW_PORT'] = originalValue;
    }
  });

  it('returns the port number from HB_README_PREVIEW_PORT', () => {
    process.env['HB_README_PREVIEW_PORT'] = '6419';

    expect(resolvePort()).toBe(6419);
  });

  it('returns worktree-offset port when env var is set differently', () => {
    process.env['HB_README_PREVIEW_PORT'] = '6461';

    expect(resolvePort()).toBe(6461);
  });

  it('throws when HB_README_PREVIEW_PORT is not set', () => {
    delete process.env['HB_README_PREVIEW_PORT'];

    expect(() => resolvePort()).toThrow('HB_README_PREVIEW_PORT is not set');
  });

  it('throws when HB_README_PREVIEW_PORT is not a valid port', () => {
    process.env['HB_README_PREVIEW_PORT'] = 'not-a-number';

    expect(() => resolvePort()).toThrow('invalid');
  });

  it('throws when HB_README_PREVIEW_PORT is out of range', () => {
    process.env['HB_README_PREVIEW_PORT'] = '99999';

    expect(() => resolvePort()).toThrow('invalid');
  });
});

describe('isSafePath', () => {
  it('accepts simple relative paths', () => {
    expect(isSafePath('/packages/ui/src/assets/icons/globe.svg')).toBe(true);
    expect(isSafePath('/.github/readme/banner-dark.svg')).toBe(true);
  });

  it('rejects paths containing ..', () => {
    expect(isSafePath('/../etc/passwd')).toBe(false);
    expect(isSafePath('/foo/../../etc/passwd')).toBe(false);
  });

  it('rejects the root path', () => {
    expect(isSafePath('/')).toBe(false);
  });
});

describe('renderPage', () => {
  it('returns a full HTML document', () => {
    const html = renderPage('# Hello', MINIMAL_CSS);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
  });

  it('embeds the provided CSS', () => {
    const html = renderPage('# Hello', MINIMAL_CSS);

    expect(html).toContain(MINIMAL_CSS);
  });

  it('renders markdown headings', () => {
    const html = renderPage('# Hello World', MINIMAL_CSS);

    expect(html).toContain('<h1');
    expect(html).toContain('Hello World');
  });

  it('renders GFM tables', () => {
    const markdown = `
| A | B |
|---|---|
| 1 | 2 |
`;
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders GitHub alert blocks via marked-alert', () => {
    const markdown = `> [!NOTE]\n> Important message`;
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('markdown-alert');
    expect(html).toContain('markdown-alert-note');
  });

  it('applies syntax highlighting to fenced code blocks', () => {
    const markdown = '```typescript\nconst x = 42;\n```';
    const html = renderPage(markdown, MINIMAL_CSS);

    expect(html).toContain('hljs');
    expect(html).toContain('language-typescript');
  });

  it('includes the live-reload EventSource script', () => {
    const html = renderPage('# test', MINIMAL_CSS);

    expect(html).toContain("new EventSource('/reload')");
  });

  it('sets markdown-body class on body', () => {
    const html = renderPage('# test', MINIMAL_CSS);

    expect(html).toContain('class="markdown-body"');
  });
});
