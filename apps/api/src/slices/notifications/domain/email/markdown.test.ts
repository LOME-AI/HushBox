import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EMAIL_PALETTE } from '@hushbox/shared/design-tokens';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { defineEmail, defineNewsletterIssue } from './document.js';
import { markdownBlocks, newsletterMarkdownSchema } from './markdown.js';
import { renderEmail } from './render.js';
import { EMAIL_FONT_STACKS, EMAIL_STYLES, elementClass, surfaceClass } from './styles.js';
import type { EmailElement } from './styles.js';

const SENT_AT = new Date(TEST_YEAR_START);
const DARK = EMAIL_PALETTE.dark;
const LIGHT = EMAIL_PALETTE.light;

const issue = defineNewsletterIssue({
  kind: 'newsletterIssue',
  schema: z.object({ body: z.string() }),
  subject: () => 'What shipped this month',
  markdown: (p) => p.body,
  foot: () => ({ unsubscribeUrl: 'https://hushbox.ai/newsletter/unsubscribed?token=t' }),
});

function htmlOf(body: string): string {
  return renderEmail(issue, { body }, { sentAt: SENT_AT }).html;
}

function textOf(body: string): string {
  return renderEmail(issue, { body }, { sentAt: SENT_AT }).text;
}

/** The card's contents from the h1 up to the foot, where the markdown lands. */
function bodyOf(html: string): string {
  const start = html.indexOf('</h1>');
  const end = html.indexOf('email-foot-text', start);
  if (start === -1 || end === -1) throw new Error('no issue body');
  return html.slice(start + '</h1>'.length, html.lastIndexOf('<', end));
}

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

function onlyTag(tags: readonly Tag[]): Tag {
  expect(tags).toHaveLength(1);
  const [tag] = tags;
  if (tag === undefined) throw new Error('no tag');
  return tag;
}

function lightRules(html: string): string {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  return css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
}

/** Every link or image target the writer's guard refuses, and each userinfo shape. */
const REFUSED: readonly (readonly [string, string])[] = [
  ['a javascript: link', '[x](javascript:alert(1))'],
  ['a data: link', '[x](data:text/html,hi)'],
  ['a vbscript: link', '[x](vbscript:msgbox)'],
  ['a file: link', '[x](file:///etc/passwd)'],
  ['an ftp: link', '[x](ftp://example.test/a)'],
  ['a relative link', '[x](/newsletter)'],
  ['a fragment link', '[x](#top)'],
  ['a mailto: link with a query', '[x](mailto:a@example.test?cc=b@example.test)'],
  ['a mailto: link to no address', '[x](mailto:nobody)'],
  ['a link with a user', '[x](https://hushbox.ai@evil.test/)'],
  ['a link with a user and password', '[x](https://u:p@evil.test/)'],
  ['an http: link with a user', '[x](http://hushbox.ai@evil.test/)'],
  ['a reference definition to javascript:', '[x][r]\n\n[r]: javascript:alert(1)'],
  ['an autolink with a user', '<https://hushbox.ai@evil.test/>'],
  ['an image from javascript:', '![alt](javascript:alert(1))'],
  ['an image with a user', '![alt](https://u@evil.test/a.png)'],
  ['a link inside a heading', '## See [x](javascript:alert(1))'],
  ['a link inside bold', '**see [x](javascript:alert(1))**'],
  ['a link inside emphasis', '*see [x](https://u@evil.test/)*'],
  ['a link inside strikethrough', '~~see [x](javascript:alert(1))~~'],
  ['a link in a nested list', '- a\n  - [x](javascript:alert(1))'],
  ['a link in a quote', '> see [x](https://hushbox.ai@evil.test/)'],
  ['a link in a table header', '| [x](javascript:alert(1)) | b |\n| --- | --- |\n| 1 | 2 |'],
  ['a link in a table cell', '| a | b |\n| --- | --- |\n| 1 | [x](https://u@evil.test/) |'],
  ['a user-name autolink inside a link label', '[a <https://u@evil.test/> b](https://ok.test)'],
  ['a javascript: link inside a link label', '[a [b](javascript:1) c](https://ok.test)'],
  [
    'a mailto: autolink with a query inside a link label',
    '[a <mailto:a@b.test?cc=x> b](https://ok.test)',
  ],
  ['a refused link inside bold inside a link label', '[**a [b](javascript:1)**](https://ok.test)'],
  [
    'an allowed image inside a refused link',
    '[![alt](https://example.test/a.png)](javascript:alert(1))',
  ],
  ['a user name written as a reference', '[x](https://hushbox.ai&#64;evil.test/)'],
  ['a javascript: scheme written with a reference', '[x](jav&#97;script:alert(1))'],
  ['an image with a user name written as a reference', '![a](https://u&#64;evil.test/a.png)'],
];

const ALLOWED: readonly (readonly [string, string])[] = [
  ['an https: link', '[x](https://hushbox.ai/blog)'],
  ['an http: link', '[x](http://example.test/)'],
  ['a mailto: link to a bare address', '[x](mailto:hello@hushbox.ai)'],
  ['a bare www address', 'see www.example.test today'],
  ['a bare email address', 'write to hello@hushbox.ai'],
  ['an https: image', '![alt](https://example.test/a.png)'],
  ['raw HTML carrying a javascript: link', '<a href="javascript:alert(1)">x</a>'],
  ['an unused reference definition', 'text\n\n[r]: javascript:alert(1)'],
  ['plain text', 'no links here'],
  ['a link whose query is written with a reference', '[x](https://example.com/?a=1&amp;b=2)'],
  [
    'a refused image inside an allowed link, written as its label',
    '[![alt](javascript:alert(1))](https://example.test/)',
  ],
];

describe('newsletterMarkdownSchema', () => {
  it.each(REFUSED)('refuses %s', (_name, source) => {
    expect(newsletterMarkdownSchema.safeParse(source).success).toBe(false);
  });

  it.each(ALLOWED)('accepts %s', (_name, source) => {
    expect(newsletterMarkdownSchema.safeParse(source).success).toBe(true);
  });

  it.each(REFUSED)('refuses %s at resolution, before the writer', (_name, source) => {
    expect(() => htmlOf(source)).toThrow(z.ZodError);
  });

  it.each(ALLOWED)('renders %s', (_name, source) => {
    expect(() => htmlOf(source)).not.toThrow();
  });
});

describe('markdownBlocks', () => {
  it('maps a paragraph of text', () => {
    expect(markdownBlocks('Hello there')).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: 'Hello there' }] },
    ]);
  });

  it('maps nothing from an empty source', () => {
    expect(markdownBlocks('')).toEqual([]);
  });
});

const standard = defineEmail({
  kind: 'standard',
  schema: z.object({}),
  subject: () => 'What shipped this month',
  preheader: () => 'Preview',
  body: () => ({
    blocks: [
      { kind: 'heading', text: 'One' },
      { kind: 'paragraph', content: [{ kind: 'strong', text: 'big' }] },
    ],
  }),
});

function firstTag(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  if (match === null) throw new Error(`no match for ${String(pattern)}`);
  return match[0];
}

describe('the newsletter issue beside a standard email', () => {
  const standardHtml = renderEmail(standard, {}, { sentAt: SENT_AT }).html;
  const issueHtml = htmlOf('## One\n\n**big**');

  it('writes its h1 exactly as a standard email does', () => {
    expect(firstTag(issueHtml, /<h1 [^>]*>/)).toBe(firstTag(standardHtml, /<h1 [^>]*>/));
  });

  it('writes its section heading exactly as a standard email does', () => {
    expect(firstTag(issueHtml, /<h2 [^>]*>/)).toBe(firstTag(standardHtml, /<h2 [^>]*>/));
  });

  it('writes bold exactly as a standard email does', () => {
    expect(firstTag(issueHtml, /<strong[^>]*>/)).toBe(firstTag(standardHtml, /<strong[^>]*>/));
  });
});

describe('the newsletter issue body', () => {
  it.each(['# One', '## One', '###### One'])(
    'writes the heading %s as a section heading under the h1',
    (source) => {
      const html = htmlOf(source);
      const heading = onlyTag(tagsWithClass(html, elementClass('sectionHeading')));
      expect(heading.name).toBe('h2');
      expect(html.indexOf('<h2')).toBeGreaterThan(html.indexOf('</h1>'));
      expect(html).toMatch(/<h2 [^>]*>One<\/h2>/);
    }
  );

  it('writes a link in the accent with no underline', () => {
    const link = onlyTag(
      tagsWithClass(htmlOf('[the blog](https://example.com)'), elementClass('link'))
    );
    expect(link.attributes.get('href')).toBe('https://example.com');
    expect(styleOf(link).get('color')).toBe(DARK.accent);
    expect(styleOf(link).get('text-decoration')).toBe('none');
  });

  it('writes bold at weight 700', () => {
    expect(htmlOf('**big**')).toContain('<strong style="font-weight:700;">big</strong>');
  });

  it('writes emphasis in italic', () => {
    expect(htmlOf('*soft*')).toContain('<em style="font-style:italic;">soft</em>');
  });

  it('keeps a struck-through text with a line through it', () => {
    expect(htmlOf('~~gone~~')).toContain('<del style="text-decoration:line-through;">gone</del>');
  });

  it('writes a paragraph in the paragraph style', () => {
    const paragraph = onlyTag(tagsWithClass(htmlOf('Plain words.'), elementClass('paragraph')));
    expect(paragraph.name).toBe('p');
    expect(styleOf(paragraph).get('font-family')).toBe(EMAIL_FONT_STACKS.serif);
    expect(styleOf(paragraph).get('color')).toBe(DARK.text);
  });

  it('writes a hard break as a line break in its paragraph', () => {
    expect(bodyOf(htmlOf('one\\\ntwo'))).toMatch(/one<br>two/);
  });

  it('writes a bulleted list whose items take the paragraph style', () => {
    const html = htmlOf('- one\n- two');
    expect(tagsOf(bodyOf(html)).filter((tag) => tag.name === 'ul')).toHaveLength(1);
    const items = tagsOf(bodyOf(html)).filter((tag) => tag.name === 'li');
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.attributes.get('class')).toBe(elementClass('paragraph'));
      expect(styleOf(item).get('color')).toBe(DARK.text);
    }
  });

  it('writes a numbered list from its first number', () => {
    const list = onlyTag(
      tagsOf(bodyOf(htmlOf('3. three\n4. four'))).filter((t) => t.name === 'ol')
    );
    expect(list.attributes.get('start')).toBe('3');
  });

  it('indents each list level 24px', () => {
    const lists = tagsOf(bodyOf(htmlOf('- a\n  - b'))).filter((tag) => tag.name === 'ul');
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(styleOf(list).get('padding-left')).toBe('24px');
  });

  it('nests lists at every depth with no cap', () => {
    const source = ['- 1', '  - 2', '    - 3', '      - 4', '        - 5', '          - 6'].join(
      '\n'
    );
    const lists = tagsOf(bodyOf(htmlOf(source))).filter((tag) => tag.name === 'ul');
    expect(lists).toHaveLength(6);
    expect(bodyOf(htmlOf(source))).toMatch(/(<ul [^>]*><li [^>]*><p [^>]*>\d[\s\S]*?){6}/);
  });

  it('sets a nested list as close under its item as sibling items sit', () => {
    const paragraphs = tagsOf(bodyOf(htmlOf('- a\n  - b'))).filter((tag) => tag.name === 'p');
    expect(paragraphs.map((tag) => styleOf(tag).get('margin'))).toEqual(['0 0 0', '0 0 0']);
  });

  it('keeps a gap between the paragraphs of one list item', () => {
    const paragraphs = tagsOf(bodyOf(htmlOf('- a\n\n  b'))).filter((tag) => tag.name === 'p');
    expect(paragraphs.map((tag) => styleOf(tag).get('margin'))).toEqual(['0 0 8px', '0 0 0']);
  });

  it('writes a code block inside a list item on the code well', () => {
    const html = htmlOf('- item\n\n  ```\n  code\n  ```');
    const code = onlyTag(tagsWithClass(bodyOf(html), elementClass('code')));
    expect(code.name).toBe('pre');
    expect(bodyOf(html)).toMatch(/<li [^>]*>[\s\S]*<pre [^>]*>code<\/pre><\/li>/);
  });

  it('writes an escaped character as itself', () => {
    expect(bodyOf(htmlOf(String.raw`\*not bold\*`))).toContain('>*not bold*</p>');
  });

  it('writes a task checkbox as literal text before its item, with no form control', () => {
    const html = htmlOf('- [ ] open\n- [x] done');
    expect(bodyOf(html)).toContain('[ ] open');
    expect(bodyOf(html)).toContain('[x] done');
    expect(html).not.toContain('<input');
  });

  it('writes a code block in mono on the code well', () => {
    const code = onlyTag(tagsWithClass(htmlOf('```\nconst a = 1;\n```'), elementClass('code')));
    expect(code.name).toBe('pre');
    expect(styleOf(code).get('font-family')).toBe(EMAIL_FONT_STACKS.mono);
    expect(styleOf(code).get('background-color')).toBe(DARK.codeWell);
    expect(styleOf(code).get('color')).toBe(DARK[EMAIL_STYLES.code.colour]);
  });

  it('escapes a code block', () => {
    expect(bodyOf(htmlOf('```\n<b>&</b>\n```'))).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('writes inline code in mono on the code well', () => {
    const code = onlyTag(tagsWithClass(htmlOf('run `pnpm dev` now'), elementClass('code')));
    expect(code.name).toBe('code');
    expect(styleOf(code).get('font-family')).toBe(EMAIL_FONT_STACKS.mono);
    expect(styleOf(code).get('background-color')).toBe(DARK.codeWell);
  });

  it('maps the code well to its light palette value', () => {
    expect(lightRules(htmlOf('`x`'))).toContain(
      `.${elementClass('code')}-fill { background-color: ${LIGHT.codeWell} !important; }`
    );
  });

  it('writes a horizontal rule as a 1px line in the rule colour', () => {
    const rule = onlyTag(
      tagsWithClass(bodyOf(htmlOf('above\n\n---\n\nbelow')), surfaceClass('rule'))
    );
    expect(styleOf(rule).get('border-top')).toBe(`1px solid ${DARK.rule}`);
  });

  it('writes raw HTML as visible text', () => {
    const html = htmlOf('<b>hi</b>');
    expect(bodyOf(html)).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('writes a raw HTML link as text and makes no link of it', () => {
    const html = htmlOf('<a href="javascript:alert(1)">x</a>');
    expect(bodyOf(html)).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;');
    expect(bodyOf(html)).not.toContain('<a');
  });

  it('writes a script tag as visible text', () => {
    const html = htmlOf('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(bodyOf(html)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('writes an image as a link to it labelled with its alt text', () => {
    const html = htmlOf('![A chart](https://example.com/a.png)');
    const link = onlyTag(tagsWithClass(html, elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://example.com/a.png');
    expect(bodyOf(html)).toMatch(/>A chart<\/a>/);
    expect(html).not.toContain('<img');
  });

  it('labels an image with no alt text by its address', () => {
    expect(bodyOf(htmlOf('![](https://example.com/a.png)'))).toMatch(
      />https:\/\/example\.com\/a\.png<\/a>/
    );
  });

  it('writes an image inside a link as the alt text of that one link', () => {
    const html = htmlOf('[![Logo](https://example.com/l.png)](https://example.com/)');
    const link = onlyTag(tagsWithClass(html, elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://example.com/');
    expect(bodyOf(html)).toMatch(/>Logo<\/a>/);
  });

  it('writes a block quote as muted paragraphs with no side stripe', () => {
    const html = htmlOf('> Quoted words.');
    const quote = onlyTag(tagsWithClass(bodyOf(html), elementClass('finePrint')));
    expect(quote.name).toBe('p');
    expect(bodyOf(html)).toContain('Quoted words.');
    expect(bodyOf(html)).not.toMatch(/border-left/);
    expect(bodyOf(html)).not.toContain('<blockquote');
  });

  it('writes the items of a list inside a block quote muted', () => {
    const items = tagsOf(bodyOf(htmlOf('> - quoted item'))).filter((tag) => tag.name === 'li');
    expect(onlyTag(items).attributes.get('class')).toBe(elementClass('finePrint'));
  });

  it('writes a table as the figures table', () => {
    const html = htmlOf('| Fee | Rate |\n| --- | --- |\n| HushBox | 5% |');
    const labels = tagsWithClass(bodyOf(html), elementClass('tableLabel'));
    const values = tagsWithClass(bodyOf(html), elementClass('tableValue'));
    expect(labels).toHaveLength(3);
    expect(onlyTag(values).attributes.get('style')).toContain(
      'text-align:right;font-variant-numeric:tabular-nums;'
    );
    expect(bodyOf(html)).toMatch(/>HushBox<\/td>/);
    expect(bodyOf(html)).toMatch(/>5%<\/td>/);
  });

  it('escapes every text it writes', () => {
    const html = htmlOf('## <i>h</i>\n\n**<i>b</i>** [<i>l</i>](https://example.com/?a=1&b="2")');
    expect(html).not.toContain('<i>');
    expect(html).toContain('href="https://example.com/?a=1&amp;b=&quot;2&quot;"');
  });

  it('decodes a named character reference in the HTML part', () => {
    const body = bodyOf(htmlOf('Q&amp;A'));
    expect(body).toContain('>Q&amp;A</p>');
    expect(body).not.toContain('&amp;amp;');
  });

  it('decodes a named character reference in the text part', () => {
    expect(textOf('Q&amp;A')).toContain('\n\nQ&A\n\n');
  });

  it('decodes an accented letter written as a reference in both parts', () => {
    expect(bodyOf(htmlOf('caf&eacute;'))).toContain('>café</p>');
    expect(textOf('caf&eacute;')).toContain('\n\ncafé\n\n');
  });

  it('decodes a numeric character reference', () => {
    expect(bodyOf(htmlOf('&#72;&#x69;'))).toContain('>Hi</p>');
  });

  it('leaves a reference without its semicolon as typed', () => {
    expect(bodyOf(htmlOf('&copy 2026'))).toContain('>&amp;copy 2026</p>');
  });

  it('decodes the query of a link target', () => {
    const link = onlyTag(
      tagsWithClass(htmlOf('[x](https://example.com/?a=1&amp;b=2)'), elementClass('link'))
    );
    expect(link.attributes.get('href')).toBe('https://example.com/?a=1&amp;b=2');
  });

  it('decodes an image target and its alt text', () => {
    const html = htmlOf('![caf&eacute;](https://example.com/a.png?w=1&amp;h=2)');
    const link = onlyTag(tagsWithClass(html, elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://example.com/a.png?w=1&amp;h=2');
    expect(bodyOf(html)).toMatch(/>café<\/a>/);
  });

  it('keeps a reference inside code as typed', () => {
    expect(bodyOf(htmlOf('`&amp;`'))).toMatch(/>&amp;amp;<\/code>/);
  });

  it('keeps a reference inside a code span as typed in the text part', () => {
    expect(textOf('Code `&amp;` beside &amp;')).toContain('\n\nCode `&amp;` beside &\n\n');
  });

  it('keeps a reference inside a fenced code block as typed in both parts', () => {
    const source = '```\n&amp; &copy;\n```\n\nafter &amp;';
    expect(bodyOf(htmlOf(source))).toContain('>&amp;amp; &amp;copy;</pre>');
    expect(textOf(source)).toContain('\n\n```\n&amp; &copy;\n```\n\nafter &\n\n');
  });

  it('keeps a reference inside an indented code block as typed in the text part', () => {
    expect(textOf('    &amp;\n\nafter &amp;')).toContain('\n\n    &amp;\n\nafter &\n\n');
  });

  it('keeps a reference inside code within a quote as typed in the text part', () => {
    const source = '> say `&amp;` &amp;\n> ```\n> &amp;\n> ```';
    expect(textOf(source)).toContain('> say `&amp;` &\n> ```\n> &amp;\n> ```');
  });

  it('keeps a reference inside code within a nested list item as typed in the text part', () => {
    const source = '- a &amp;\n  - b `&amp;`\n\n    ```\n    &amp;\n    ```';
    expect(textOf(source)).toContain('- a &\n  - b `&amp;`\n\n    ```\n    &amp;\n    ```');
  });

  it('shows inline raw HTML as typed in both parts, its references undecoded', () => {
    const source = 'a <b title="&amp;">x</b> &amp;';
    expect(bodyOf(htmlOf(source))).toContain(
      '>a &lt;b title=&quot;&amp;amp;&quot;&gt;x&lt;/b&gt; &amp;</p>'
    );
    expect(textOf(source)).toContain('\n\na <b title="&amp;">x</b> &\n\n');
  });

  it('shows a raw HTML block as typed in both parts, its references undecoded', () => {
    const source = '<div>&copy;</div>\n\nafter &copy;';
    expect(bodyOf(htmlOf(source))).toContain('>&lt;div&gt;&amp;copy;&lt;/div&gt;</p>');
    expect(textOf(source)).toContain('\n\n<div>&copy;</div>\n\nafter ©\n\n');
  });

  it('shows an escaped reference as its literal text in both parts', () => {
    const source = String.raw`\&amp; beside &amp;`;
    expect(bodyOf(htmlOf(source))).toContain('>&amp;amp; beside &amp;</p>');
    expect(textOf(source)).toContain('\n\n&amp; beside &\n\n');
  });

  it('drops the backslash of every escape from the text part, as the HTML part does', () => {
    const source = String.raw`\*not emphasis\*`;
    expect(bodyOf(htmlOf(source))).toContain('>*not emphasis*</p>');
    expect(textOf(source)).toContain('\n\n*not emphasis*\n\n');
  });

  it('writes a link inside a link label as its text, inside the one outer link', () => {
    const source = '[a <https://ok.test/> b](https://ok.test/)';
    const html = htmlOf(source);
    const link = onlyTag(tagsWithClass(html, elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://ok.test/');
    expect(bodyOf(html)).toMatch(/>a https:\/\/ok\.test\/ b<\/a>/);
    expect(textOf(source)).toContain('\n\n[a <https://ok.test/> b](https://ok.test/)\n\n');
  });

  it('reads an escape in image alt text as link text reads it, in both parts', () => {
    const source = String.raw`![a \&amp; b](https://a.com/i.png)`;
    expect(bodyOf(htmlOf(source))).toMatch(/>a &amp;amp; b<\/a>/);
    expect(textOf(source)).toContain('\n\n![a &amp; b](https://a.com/i.png)\n\n');
  });

  it('writes image alt text as its words without their formatting', () => {
    const source = '![**b** *e* ~~d~~ `c` [l](https://example.com/)](https://example.com/i.png)';
    expect(bodyOf(htmlOf(source))).toMatch(/>b e d c l<\/a>/);
  });

  it('writes a hard break in image alt text as a space', () => {
    expect(bodyOf(htmlOf('![a\\\nb](https://example.com/i.png)'))).toMatch(/>a b<\/a>/);
  });

  it('writes a backslash hard line break as a line break in the text part', () => {
    const source = 'one\\\ntwo';
    expect(bodyOf(htmlOf(source))).toContain('>one<br>two</p>');
    expect(textOf(source)).toContain('\n\none\ntwo\n\n');
  });

  it('keeps an escaped reference in a link address literal in both parts', () => {
    const source = String.raw`[x](https://a.com/?q=\&amp;)`;
    const link = onlyTag(tagsWithClass(htmlOf(source), elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://a.com/?q=&amp;amp;');
    expect(textOf(source)).toContain('\n\n[x](https://a.com/?q=&amp;)\n\n');
  });

  it('decodes only the unescaped reference in an image address', () => {
    const source = String.raw`![a](https://a.com/i.png?q=\&amp;&amp;)`;
    const link = onlyTag(tagsWithClass(htmlOf(source), elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://a.com/i.png?q=&amp;amp;&amp;');
    expect(textOf(source)).toContain('\n\n![a](https://a.com/i.png?q=&amp;&)\n\n');
  });

  it('keeps an escaped reference in a reference definition literal in both parts', () => {
    const source = '[x][r]\n\n' + String.raw`[r]: https://a.com/?q=\&amp;`;
    const link = onlyTag(tagsWithClass(htmlOf(source), elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://a.com/?q=&amp;amp;');
    expect(textOf(source)).toContain('[r]: https://a.com/?q=&amp;');
  });

  it('checks the address exactly as the writer writes it', () => {
    const source = String.raw`[x](https://hushbox.ai/\&#64;evil.test/)`;
    expect(newsletterMarkdownSchema.safeParse(source).success).toBe(true);
    const link = onlyTag(tagsWithClass(htmlOf(source), elementClass('link')));
    expect(link.attributes.get('href')).toBe('https://hushbox.ai/&amp;#64;evil.test/');
  });

  it('keeps an escape typed with its table in a cell whose pipe the lexer unescaped', () => {
    const source = String.raw`| a \| b \&amp; | c &amp; |` + '\n| --- | --- |\n| d | e |';
    expect(bodyOf(htmlOf(source))).toContain('b &amp;amp;');
    expect(textOf(source)).toContain(String.raw`| a \| b \&amp; | c &amp; |`);
  });

  it('keeps code typed in a table cell whose pipe the lexer unescaped', () => {
    const source = '| a \\| b `&amp;` | c |\n| --- | --- |\n| d | e |';
    expect(bodyOf(htmlOf(source))).toMatch(/>&amp;amp;<\/code>/);
    expect(textOf(source)).toContain('`&amp;`');
  });

  it('keeps a reference inside code within a table cell as typed in the text part', () => {
    const source = '| a &amp; | `&amp;` |\n| --- | --- |\n| `&amp;` | &amp; |';
    expect(textOf(source)).toContain('| a & | `&amp;` |\n| --- | --- |\n| `&amp;` | & |');
  });

  it('writes Unsubscribe in the foot link colour, in the foot text type', () => {
    const link = onlyTag(tagsWithClass(htmlOf('words'), elementClass('footLink')));
    expect(styleOf(link).get('color')).toBe(DARK[EMAIL_STYLES.footLink.colour]);
    expect(EMAIL_STYLES.footLink.face).toBe(EMAIL_STYLES.footText.face);
    expect(EMAIL_STYLES.footLink.sizePx).toBe(EMAIL_STYLES.footText.sizePx);
  });

  it.each([
    ['sectionHeading', '## Heading'],
    ['code', '`x`'],
    ['footText', 'words'],
  ] as const)(
    'writes the %s colour and type from the style table',
    (element: EmailElement, source) => {
      const style = EMAIL_STYLES[element];
      const tag = onlyTag(tagsWithClass(htmlOf(source), elementClass(element)));
      expect(styleOf(tag).get('color')).toBe(DARK[style.colour]);
      expect(styleOf(tag).get('font-family')).toBe(EMAIL_FONT_STACKS[style.face]);
      expect(styleOf(tag).get('font-weight')).toBe(String(style.weight));
    }
  );
});
