import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { defineNewsletterIssue } from './document.js';
import { isAllowedEmailHref } from './html.js';
import { markdownBlocks, newsletterMarkdownSchema } from './markdown.js';
import { renderEmail } from './render.js';
import type { MarkdownBlock, MarkdownRun } from './markdown.js';

/**
 * An issue body the schema accepts renders without throwing and writes no link the writer
 * refuses or that carries a user name, wherever in the markdown the link stands. The
 * generator, `issueMarkdown`, nests links and images inside headings, emphasis, bold,
 * strikethrough, lists of any depth, quotes and table cells, and links inside a link's
 * label (inline and autolinks), with targets drawn from
 * refused shapes (some written with character references) and from `fc.webUrl()`, so both
 * outcomes of the schema are exercised.
 */

const SENT_AT = new Date(TEST_YEAR_START);

const issue = defineNewsletterIssue({
  kind: 'newsletterIssue',
  schema: z.object({ body: z.string() }),
  subject: () => 'Issue',
  markdown: (p) => p.body,
  foot: () => ({ unsubscribeUrl: 'https://hushbox.ai/newsletter/unsubscribed?token=t' }),
});

const REFUSED_TARGETS = [
  'javascript:alert(1)',
  'data:text/html,hi',
  '/newsletter',
  '#top',
  'mailto:a@example.test?cc=b@example.test',
  'https://hushbox.ai@evil.test/',
  'https://u:p@evil.test/a',
  'https://hushbox.ai&#64;evil.test/',
  'jav&#97;script:alert(1)',
] as const;

const target = fc.oneof(
  fc.constantFrom(...REFUSED_TARGETS),
  fc.webUrl(),
  fc.constant('mailto:hello@hushbox.ai')
);

const word = fc.constantFrom('news', 'shipped', 'groups', 'today');

const inline: fc.Arbitrary<string> = fc.oneof(
  word,
  target.map((href) => `[link](${href})`),
  target.map((href) => `![alt](${href})`),
  fc.tuple(target, target).map(([image, href]) => `[![alt](${image})](${href})`),
  target.map((href) => `**[bold](${href})**`),
  target.map((href) => `*[em](${href})*`),
  target.map((href) => `~~[del](${href})~~`),
  fc.tuple(target, target).map(([inner, outer]) => `[a [b](${inner}) c](${outer})`),
  fc
    .tuple(fc.oneof(fc.webUrl(), fc.constant('https://u@evil.test/')), target)
    .map(([inner, outer]) => `[a <${inner}> b](${outer})`)
);

const line = fc.array(inline, { minLength: 1, maxLength: 4 }).map((parts) => parts.join(' '));

function nestedList(depth: number, text: string): string {
  return Array.from({ length: depth }, (_, level) => `${'  '.repeat(level)}- ${text}`).join('\n');
}

const block = fc.oneof(
  line,
  line.map((text) => `## ${text}`),
  line.map((text) => `> ${text}`),
  fc.tuple(fc.integer({ min: 1, max: 6 }), line).map(([depth, text]) => nestedList(depth, text)),
  fc.tuple(line, line).map(([head, cell]) => `| ${head} | b |\n| --- | --- |\n| a | ${cell} |`)
);

const issueMarkdown = fc
  .array(block, { minLength: 1, maxLength: 4 })
  .map((blocks) => blocks.join('\n\n'));

function attributeValue(raw: string): string {
  return raw
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function carriesUserinfo(href: string): boolean {
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  return url.username !== '' || url.password !== '';
}

function isUnsendable(href: string): boolean {
  return !isAllowedEmailHref(href) || carriesUserinfo(href);
}

function runTargetsOf(runs: readonly MarkdownRun[]): string[] {
  return runs.flatMap((run): string[] => {
    if (run.kind === 'link' || run.kind === 'labelLink') {
      return [run.href, ...runTargetsOf(run.content)];
    }
    return run.kind === 'strong' || run.kind === 'em' || run.kind === 'del'
      ? runTargetsOf(run.content)
      : [];
  });
}

/** Every link target the mapped blocks carry, written or not, found independently of the schema. */
function targetsOf(blocks: readonly MarkdownBlock[]): string[] {
  return blocks.flatMap((block): string[] => {
    if (block.kind === 'heading' || block.kind === 'paragraph') return runTargetsOf(block.content);
    if (block.kind === 'quote') return targetsOf(block.blocks);
    if (block.kind === 'list') return block.items.flatMap((item) => targetsOf(item));
    if (block.kind === 'table') {
      return [...block.header, ...block.rows.flat()].flatMap((cell) => runTargetsOf(cell));
    }
    return [];
  });
}

/** Every href the HTML writes that the writer's rule refuses or that names a user. */
function unsendableHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)]
    .map((match) => attributeValue(match[1] ?? ''))
    .filter((href) => isUnsendable(href));
}

describe('newsletter markdown, over generated issue bodies', () => {
  it('finds an unsendable href in written HTML', () => {
    expect(unsendableHrefs('<a href="https://u@evil.test/">x</a>')).toEqual([
      'https://u@evil.test/',
    ]);
  });

  it('renders every accepted body and writes no unsendable link', () => {
    let acceptedWithLinks = 0;
    fc.assert(
      fc.property(issueMarkdown, (body) => {
        if (!newsletterMarkdownSchema.safeParse(body).success) return;
        const { html } = renderEmail(issue, { body }, { sentAt: SENT_AT });
        if (html.includes('class="email-link"')) acceptedWithLinks += 1;
        expect(unsendableHrefs(html)).toEqual([]);
        expect(targetsOf(markdownBlocks(body)).filter((href) => isUnsendable(href))).toEqual([]);
      })
    );
    expect(acceptedWithLinks).toBeGreaterThan(0);
  });

  it('refuses at resolution every body the schema refuses', () => {
    let refused = 0;
    fc.assert(
      fc.property(issueMarkdown, (body) => {
        if (newsletterMarkdownSchema.safeParse(body).success) return;
        refused += 1;
        expect(() => renderEmail(issue, { body }, { sentAt: SENT_AT })).toThrow(z.ZodError);
      })
    );
    expect(refused).toBeGreaterThan(0);
  });
});

/**
 * A reader sees the same characters in both parts: references decode everywhere but code,
 * raw HTML and escapes, which both parts show as typed. The generator, `referenceMarkdown`,
 * writes `&copy;` only where it decodes (in text and in image alt text), and `&amp;` only
 * inside a code span, a fenced block, inline or block raw HTML, or escaped (in text, in a
 * link or image address, or in image alt text). It adds backslash hard breaks, nests all of
 * it in quotes, list items indented by spaces or a tab, and table cells, and returns the
 * source with how many `&amp;` it wrote. No backslash reaches either part.
 */
interface ReferenceSource {
  readonly source: string;
  readonly typed: number;
}

const TYPED_INLINE = [
  '`&amp;`',
  '<b title="&amp;">x</b>',
  String.raw`\&amp;`,
  String.raw`[q](https://example.com/?q=\&amp;)`,
  String.raw`![i](https://example.com/i.png?q=\&amp;)`,
  String.raw`![a \&amp; b](https://example.com/i.png)`,
] as const;
const TYPED_PARTS: ReadonlySet<string> = new Set(TYPED_INLINE);
const DECODED_INLINE = ['&copy;', '![&copy;](https://example.com/c.png)'] as const;
const FENCED = ['```', '&amp;', '```'];
const HTML_BLOCK = ['<div>&amp;</div>'];
const HARD_BREAK = ['words\\', 'words'];

const referenceLine = fc
  .array(fc.constantFrom('words', ...DECODED_INLINE, ...TYPED_INLINE), {
    minLength: 1,
    maxLength: 4,
  })
  .map(
    (parts): ReferenceSource => ({
      source: parts.join(' '),
      typed: parts.filter((part) => TYPED_PARTS.has(part)).length,
    })
  );

const referenceLeaf: fc.Arbitrary<{ readonly lines: readonly string[]; readonly typed: number }> =
  fc.oneof(
    referenceLine.map((line) => ({ lines: [line.source], typed: line.typed })),
    fc.constant({ lines: FENCED, typed: 1 }),
    fc.constant({ lines: HTML_BLOCK, typed: 1 }),
    fc.constant({ lines: HARD_BREAK, typed: 0 })
  );

const referenceBlock = fc.oneof(
  referenceLeaf,
  referenceLeaf.map((leaf) => ({
    lines: leaf.lines.map((line) => `> ${line}`),
    typed: leaf.typed,
  })),
  fc.tuple(referenceLeaf, fc.constantFrom('  ', '\t')).map(([leaf, indent]) => ({
    lines: leaf.lines.map((line, index) => (index === 0 ? `- ${line}` : `${indent}${line}`)),
    typed: leaf.typed,
  })),
  fc.tuple(referenceLine, referenceLine).map(([head, cell]) => ({
    lines: [`| ${head.source} | b |`, '| --- | --- |', `| a | ${cell.source} |`],
    typed: head.typed + cell.typed,
  }))
);

const referenceMarkdown = fc.array(referenceBlock, { minLength: 1, maxLength: 4 }).map(
  (blocks): ReferenceSource => ({
    source: blocks.map((block) => block.lines.join('\n')).join('\n\n'),
    typed: blocks.reduce((sum, block) => sum + block.typed, 0),
  })
);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('character references, over generated issue bodies', () => {
  it('shows the reader the same characters in both parts', () => {
    fc.assert(
      fc.property(referenceMarkdown, ({ source, typed }) => {
        const { html, text } = renderEmail(issue, { body: source }, { sentAt: SENT_AT });
        expect(text).not.toContain('&copy;');
        expect(html).not.toContain('&amp;copy;');
        expect(text).not.toContain('\\');
        expect(occurrences(text, '&amp;')).toBe(typed);
        expect(occurrences(html, '&amp;amp;')).toBe(typed);
      })
    );
  });
});
