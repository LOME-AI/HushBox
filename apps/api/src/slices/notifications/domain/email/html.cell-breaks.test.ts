import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { defineNewsletterIssue } from './document.js';
import { renderEmailHtml, renderIssueHtml } from './html.js';
import { renderEmail } from './render.js';
import type { EmailBlock, ResolvedNewsletterIssue } from './document.js';
import type { MarkdownBlock, MarkdownRun } from './markdown.js';

const SENT_AT = new Date(TEST_YEAR_START);
const WBR = '<wbr>';

/** `count` characters from a repeating alphabet, so a misplaced break shows in the text. */
function token(count: number): string {
  return Array.from({ length: count }, (_, index) => String.fromCodePoint(97 + (index % 26))).join(
    ''
  );
}

/** The token as the writer should break it: a `<wbr>` after every 12 characters. */
function brokenEvery12(text: string): string {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += 12) pieces.push(text.slice(start, start + 12));
  return pieces.join(WBR);
}

/** The inner HTML of every table header and data cell, in document order. */
function cellsOf(html: string): string[] {
  return [
    ...html.matchAll(/<td class="email-table-(?:label|value)[^"]*"[^>]*>([\s\S]*?)<\/td>/g),
  ].map((match) => match[1] ?? '');
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

/** A one-row markdown table whose only data cell holds `runs`. */
function markdownCell(runs: readonly MarkdownRun[]): string {
  const header: readonly MarkdownRun[] = [{ kind: 'text', text: 'Name' }];
  const [, cell] = cellsOf(issueHtml([{ kind: 'table', header: [header], rows: [[runs]] }]));
  if (cell === undefined) throw new Error('no data cell');
  return cell;
}

function textCell(text: string): string {
  return markdownCell([{ kind: 'text', text }]);
}

function standardHtml(blocks: readonly EmailBlock[]): string {
  return renderEmailHtml(
    { subject: 'The subject', heading: 'The heading', preheader: null, body: { blocks } },
    { sentAt: SENT_AT }
  );
}

describe('a long token in a table cell takes soft break points', () => {
  it('leaves a 24-character token whole', () => {
    expect(textCell(token(24))).toBe(token(24));
  });

  it('breaks a 25-character token after every 12 characters', () => {
    expect(textCell(token(25))).toBe(brokenEvery12(token(25)));
  });

  it('breaks a 100-character token after every 12 characters', () => {
    expect(textCell(token(100))).toBe(brokenEvery12(token(100)));
  });

  it('leaves the ordinary words around a long token whole', () => {
    expect(textCell(`Feature ${token(30)} done`)).toBe(`Feature ${brokenEvery12(token(30))} done`);
  });

  it('never puts a break inside an escaped character', () => {
    const raw = `${token(11)}&<${token(11)}"'${token(4)}`;
    expect(textCell(raw)).toBe(
      `${token(11)}&amp;${WBR}&lt;${token(11)}${WBR}&quot;&#39;${token(4)}`
    );
  });

  it.each([
    ['a no-break space', '\u00A0'],
    ['a figure space', '\u2007'],
    ['a narrow no-break space', '\u202F'],
    ['a zero-width no-break space', '\uFEFF'],
  ])('counts words joined by %s as one token', (_name, space) => {
    const joined = [token(10), token(10), token(10)].join(space);
    expect(textCell(joined)).toBe(brokenEvery12(joined));
  });

  it('counts a character as the reader sees it', () => {
    const thumbs = '\u{1F44D}'.repeat(25);
    const twelve = '\u{1F44D}'.repeat(12);
    expect(textCell(thumbs)).toBe(`${twelve}${WBR}${twelve}${WBR}\u{1F44D}`);
  });

  it('breaks a long token in a code span', () => {
    expect(markdownCell([{ kind: 'code', text: token(30) }])).toContain(
      `>${brokenEvery12(token(30))}</code>`
    );
  });

  it('breaks a long token in a link label', () => {
    const cell = markdownCell([
      {
        kind: 'link',
        href: 'https://example.test/',
        content: [{ kind: 'text', text: token(30) }],
      },
    ]);
    expect(cell).toContain(`>${brokenEvery12(token(30))}</a>`);
  });

  it('breaks a long token in a header cell', () => {
    const header: readonly MarkdownRun[] = [{ kind: 'text', text: token(30) }];
    const [cell] = cellsOf(issueHtml([{ kind: 'table', header: [header], rows: [] }]));
    expect(cell).toBe(brokenEvery12(token(30)));
  });

  it('breaks a long token in a figures label', () => {
    const [label] = cellsOf(
      standardHtml([{ kind: 'table', layout: 'figures', rows: [[token(30), ['5%']]] }])
    );
    expect(label).toBe(brokenEvery12(token(30)));
  });

  it('breaks a long token in a figures value', () => {
    const [, value] = cellsOf(
      standardHtml([{ kind: 'table', layout: 'figures', rows: [['Fee', [token(30)]]] }])
    );
    expect(value).toBe(brokenEvery12(token(30)));
  });

  it('leaves a facts value to its own break rule', () => {
    const [, value] = cellsOf(
      standardHtml([{ kind: 'table', layout: 'facts', rows: [['Actor', [token(30)]]] }])
    );
    expect(value).toBe(token(30));
  });

  it('leaves a long token outside a table whole', () => {
    const html = issueHtml([{ kind: 'paragraph', content: [{ kind: 'text', text: token(30) }] }]);
    expect(html).toContain(`>${token(30)}</p>`);
    expect(html).not.toContain(WBR);
  });

  it('leaves the text part without soft break points', () => {
    const issue = defineNewsletterIssue({
      kind: 'newsletterIssue',
      schema: z.object({ body: z.string() }),
      subject: () => 'The subject',
      markdown: (p) => p.body,
      foot: () => ({ unsubscribeUrl: 'https://example.test/unsubscribe' }),
    });
    const rendered = renderEmail(
      issue,
      { body: `| Name |\n| --- |\n| ${token(30)} |` },
      { sentAt: SENT_AT }
    );
    expect(rendered.html).toContain(brokenEvery12(token(30)));
    expect(rendered.text).toContain(token(30));
    expect(rendered.text).not.toContain(WBR);
  });
});
