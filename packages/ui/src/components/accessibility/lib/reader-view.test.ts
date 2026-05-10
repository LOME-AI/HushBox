import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { extractArticle, setChatReaderMode } from './reader-view';

const ARTICLE_HTML = `
  <!DOCTYPE html>
  <html>
    <head>
      <title>The Importance of Accessible Software</title>
    </head>
    <body>
      <header><nav>Site nav</nav></header>
      <article>
        <h1>The Importance of Accessible Software</h1>
        <p class="byline">By Jane Doe</p>
        <p>
          Accessibility is not an optional feature in modern software. It is a
          fundamental requirement that ensures every person, regardless of ability,
          can interact with the tools and services they need to participate fully
          in modern life. When we talk about accessibility we mean far more than
          colour contrast or screen reader support, although those matter greatly.
        </p>
        <p>
          We mean clear typography that people with low vision can read without
          straining their eyes. We mean motion controls that protect people with
          vestibular disorders from being made unwell by gratuitous animation. We
          mean keyboard navigation paths that work for people who cannot use a
          mouse, and structured page landmarks that let screen reader users skim a
          page the way sighted users skim with their eyes.
        </p>
        <p>
          Accessibility is also a discipline of empathy. The same patterns that
          help a person with a permanent disability also help a person holding a
          baby in one arm, or someone trying to read a page on a tiny phone in
          bright sunlight. Building for the edge cases improves the experience for
          everyone in the middle, and that is the quiet, compounding payoff of
          taking accessibility seriously from the very first commit of a project.
        </p>
      </article>
      <footer>Site footer</footer>
    </body>
  </html>
`;

describe('extractArticle', () => {
  it('returns the title and content for an article-like Document', () => {
    const document_ = new DOMParser().parseFromString(ARTICLE_HTML, 'text/html');
    const result = extractArticle(document_);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('The Importance of Accessible Software');
    expect(result?.contentHtml).toContain('Accessibility is not an optional feature');
    expect(result?.textContent).toContain('Accessibility is not an optional feature');
    expect(result?.length).toBeGreaterThan(100);
  });

  it('exposes byline metadata when Readability finds it', () => {
    const document_ = new DOMParser().parseFromString(ARTICLE_HTML, 'text/html');
    const result = extractArticle(document_);
    // Readability may or may not pick up byline depending on heuristics; assert the
    // shape is present (string or null), never undefined.
    expect(result).not.toBeNull();
    expect(result?.byline === null || typeof result?.byline === 'string').toBe(true);
  });

  it('returns null for a Document with no extractable article content', () => {
    const empty = document.implementation.createHTMLDocument('Empty');
    const result = extractArticle(empty);
    expect(result).toBeNull();
  });

  it('does not mutate the original Document when given a clone', () => {
    const original = new DOMParser().parseFromString(ARTICLE_HTML, 'text/html');
    const beforeHtml = original.documentElement.outerHTML;
    const clone = original.cloneNode(true) as Document;
    extractArticle(clone);
    expect(original.documentElement.outerHTML).toBe(beforeHtml);
  });

  it('produces a result whose content is an HTML string', () => {
    const document_ = new DOMParser().parseFromString(ARTICLE_HTML, 'text/html');
    const result = extractArticle(document_);
    expect(result).not.toBeNull();
    expect(typeof result?.contentHtml).toBe('string');
  });

  it('coerces undefined Readability fields to safe defaults (null/empty/zero)', () => {
    // Force Readability.parse to return all-undefined fields to exercise the
    // nullish-coalesce branches in extractArticle.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse').mockReturnValueOnce({
      title: undefined,
      byline: undefined,
      excerpt: undefined,
      content: undefined,
      textContent: undefined,
      length: undefined,
      dir: undefined,
      siteName: undefined,
      lang: undefined,
      publishedTime: undefined,
    });
    const document_ = new DOMParser().parseFromString(ARTICLE_HTML, 'text/html');
    const result = extractArticle(document_);
    expect(result).toEqual({
      title: null,
      byline: null,
      excerpt: null,
      contentHtml: '',
      textContent: '',
      length: 0,
    });
    parseSpy.mockRestore();
  });
});

describe('setChatReaderMode', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('html');
  });

  afterEach(() => {
    delete document.documentElement.dataset['readerMode'];
  });

  it('adds the data-reader-mode attribute when enabled', () => {
    setChatReaderMode(true, root);
    expect(root.dataset['readerMode']).toBe('');
  });

  it('removes the data-reader-mode attribute when disabled', () => {
    root.dataset['readerMode'] = '';
    setChatReaderMode(false, root);
    expect(root.dataset['readerMode']).toBeUndefined();
  });

  it('is idempotent — enabling twice leaves the attribute present', () => {
    setChatReaderMode(true, root);
    setChatReaderMode(true, root);
    expect(root.dataset['readerMode']).toBe('');
  });

  it('is idempotent — disabling twice leaves the attribute absent', () => {
    setChatReaderMode(false, root);
    setChatReaderMode(false, root);
    expect(root.dataset['readerMode']).toBeUndefined();
  });

  it('defaults to document.documentElement when no root is provided', () => {
    setChatReaderMode(true);
    expect(document.documentElement.dataset['readerMode']).toBe('');
    setChatReaderMode(false);
    expect(document.documentElement.dataset['readerMode']).toBeUndefined();
  });
});
