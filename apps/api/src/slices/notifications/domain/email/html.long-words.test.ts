import { describe, expect, it } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmailHtml, renderIssueHtml } from './html.js';
import { elementClass } from './styles.js';
import type { EmailBlock, ResolvedNewsletterIssue } from './document.js';
import type { MarkdownBlock, MarkdownRun } from './markdown.js';

const SENT_AT = new Date(TEST_YEAR_START);

interface Tag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[2] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes.set(attribute[1] ?? '', attribute[2] ?? '');
    }
    tags.push({ name: match[1] ?? '', attributes });
  }
  return tags;
}

function tagsWithClass(html: string, className: string): Tag[] {
  return tagsOf(html).filter((tag) =>
    (tag.attributes.get('class') ?? '').split(' ').includes(className)
  );
}

function styleOf(tag: Tag): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of (tag.attributes.get('style') ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
  }
  return declarations;
}

/** Asserts every given tag, of which there is at least one, breaks an unbroken long word. */
function expectEachBreaksLongWords(tags: readonly Tag[]): void {
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) {
    const style = styleOf(tag);
    expect(style.get('overflow-wrap')).toBe('anywhere');
    expect(style.get('word-break')).toBe('break-word');
  }
}

/** Asserts no given tag, of which there is at least one, lets a word break anywhere. */
function expectNoneBreaksAnywhere(tags: readonly Tag[]): void {
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) {
    const style = styleOf(tag);
    expect(style.has('overflow-wrap')).toBe(false);
    expect(style.has('word-break')).toBe(false);
  }
}

function standardHtml(blocks: readonly EmailBlock[]): string {
  return renderEmailHtml(
    { subject: 'The subject', heading: 'The heading', preheader: null, body: { blocks } },
    { sentAt: SENT_AT }
  );
}

function issueHtml(blocks: readonly MarkdownBlock[]): string {
  const issue: ResolvedNewsletterIssue = {
    subject: 'The subject',
    heading: 'The heading',
    blocks,
    readableMarkdown: '',
    foot: {
      reason: 'The reason.',
      unsubscribeUrl: 'https://example.test/unsubscribe',
      postalLine: 'The postal line',
    },
  };
  return renderIssueHtml(issue, { sentAt: SENT_AT });
}

const WORDS: MarkdownBlock = { kind: 'paragraph', content: [{ kind: 'text', text: 'words' }] };

describe('an unbroken long word breaks instead of widening the email', () => {
  describe('in a standard email', () => {
    it('breaks in the heading', () => {
      expectEachBreaksLongWords(tagsWithClass(standardHtml([]), elementClass('heading')));
    });

    it('breaks in a paragraph', () => {
      const html = standardHtml([{ kind: 'paragraph', content: ['words'] }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('paragraph')));
    });

    it('breaks in a mono paragraph', () => {
      const html = standardHtml([{ kind: 'paragraph', face: 'mono', content: ['user.lock'] }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('opLine')));
    });

    it('breaks in fine print', () => {
      const html = standardHtml([{ kind: 'finePrint', content: ['words'] }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('finePrint')));
    });

    it('breaks in a section heading', () => {
      const html = standardHtml([{ kind: 'heading', text: 'A section' }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('sectionHeading')));
    });

    it('breaks in a link label in body text', () => {
      const html = standardHtml([
        {
          kind: 'paragraph',
          content: [{ kind: 'link', text: 'the page', href: 'https://example.test/page' }],
        },
      ]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('link')));
    });

    it('writes no break rule on a figures cell, so its column keeps its longest word', () => {
      const html = standardHtml([
        { kind: 'table', layout: 'figures', rows: [['Label', ['value']]] },
      ]);
      expectNoneBreaksAnywhere([
        ...tagsWithClass(html, elementClass('tableLabel')),
        ...tagsWithClass(html, elementClass('tableValue')),
      ]);
    });

    it('writes no break rule on a facts label', () => {
      const html = standardHtml([{ kind: 'table', layout: 'facts', rows: [['Label', ['value']]] }]);
      expectNoneBreaksAnywhere(tagsWithClass(html, elementClass('tableLabel')));
    });

    it.each(['figures', 'facts'] as const)(
      'writes no break rule on a link in a %s cell',
      (layout) => {
        const html = standardHtml([
          {
            kind: 'table',
            layout,
            rows: [['Label', [{ kind: 'link', text: 'page', href: 'https://example.test/' }]]],
          },
        ]);
        expectNoneBreaksAnywhere(tagsWithClass(html, elementClass('link')));
      }
    );

    it('breaks in a facts value', () => {
      const html = standardHtml([{ kind: 'table', layout: 'facts', rows: [['Label', ['value']]] }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('tableValue')));
    });

    it('breaks in a log row title', () => {
      const html = standardHtml([
        { kind: 'table', layout: 'log', rows: [{ title: 'user.lock', meta: ['by admin'] }] },
      ]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('logTitle')));
    });

    it('breaks in a log row meta line', () => {
      const html = standardHtml([
        { kind: 'table', layout: 'log', rows: [{ title: 'user.lock', meta: ['by admin'] }] },
      ]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('logMeta')));
    });
  });

  describe('in a newsletter issue', () => {
    it('breaks in the heading', () => {
      expectEachBreaksLongWords(tagsWithClass(issueHtml([WORDS]), elementClass('heading')));
    });

    it('breaks in a markdown heading', () => {
      const html = issueHtml([{ kind: 'heading', content: [{ kind: 'text', text: 'A section' }] }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('sectionHeading')));
    });

    it('breaks in a paragraph', () => {
      expectEachBreaksLongWords(tagsWithClass(issueHtml([WORDS]), elementClass('paragraph')));
    });

    it('breaks in a quoted paragraph', () => {
      const html = issueHtml([{ kind: 'quote', blocks: [WORDS] }]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('finePrint')));
    });

    it('breaks in a list item', () => {
      const html = issueHtml([{ kind: 'list', ordered: false, start: 1, items: [[WORDS]] }]);
      expectEachBreaksLongWords(tagsOf(html).filter((tag) => tag.name === 'li'));
    });

    it('breaks in a quoted list item', () => {
      const html = issueHtml([
        { kind: 'quote', blocks: [{ kind: 'list', ordered: true, start: 1, items: [[WORDS]] }] },
      ]);
      expectEachBreaksLongWords(tagsOf(html).filter((tag) => tag.name === 'li'));
    });

    it('writes no break rule on a header or body cell of a table', () => {
      const cellRuns: readonly MarkdownRun[] = [{ kind: 'text', text: 'cell' }];
      const html = issueHtml([
        { kind: 'table', header: [cellRuns, cellRuns], rows: [[cellRuns, cellRuns]] },
      ]);
      const cells = [
        ...tagsWithClass(html, elementClass('tableLabel')),
        ...tagsWithClass(html, elementClass('tableValue')),
      ];
      expect(cells).toHaveLength(4);
      expectNoneBreaksAnywhere(cells);
    });

    it('writes no break rule on a link in a table cell', () => {
      const cellRuns: readonly MarkdownRun[] = [
        { kind: 'link', href: 'https://example.test/', content: [{ kind: 'text', text: 'page' }] },
      ];
      const html = issueHtml([{ kind: 'table', header: [cellRuns], rows: [[cellRuns]] }]);
      expectNoneBreaksAnywhere(tagsWithClass(html, elementClass('link')));
    });

    it('breaks in a link label', () => {
      const html = issueHtml([
        {
          kind: 'paragraph',
          content: [
            {
              kind: 'link',
              href: 'https://example.test/page',
              content: [{ kind: 'text', text: 'the page' }],
            },
          ],
        },
      ]);
      expectEachBreaksLongWords(tagsWithClass(html, elementClass('link')));
    });
  });
});
