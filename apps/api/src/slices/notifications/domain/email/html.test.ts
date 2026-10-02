import { describe, expect, it, vi } from 'vitest';
import { EMAIL_PALETTE } from '@hushbox/shared/design-tokens';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmailHtml } from './html.js';
import {
  EMAIL_FONT_STACKS,
  EMAIL_STYLES,
  EMAIL_SURFACES,
  elementClass,
  surfaceClass,
} from './styles.js';
import type { EmailBody, ResolvedEmail } from './document.js';
import type { EmailElement } from './styles.js';

const SENT_AT = new Date(TEST_YEAR_START);
const REFERENCE_YEAR = SENT_AT.getUTCFullYear();
const DARK = EMAIL_PALETTE.dark;
const LIGHT = EMAIL_PALETTE.light;

interface Tag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly source: string;
}

function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[2] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes.set(attribute[1] ?? '', attribute[2] ?? '');
    }
    tags.push({ name: match[1] ?? '', attributes, source: match[0] });
  }
  return tags;
}

function classesOf(tag: Tag): string[] {
  return (tag.attributes.get('class') ?? '').split(' ').filter((name) => name !== '');
}

function tagsWithClass(html: string, className: string): Tag[] {
  return tagsOf(html).filter((tag) => classesOf(tag).includes(className));
}

function onlyTagWithClass(html: string, className: string): Tag {
  const tags = tagsWithClass(html, className);
  expect(tags).toHaveLength(1);
  const [tag] = tags;
  if (tag === undefined) throw new Error(`no tag carries ${className}`);
  return tag;
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

function headStyle(html: string): string {
  const match = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (match?.[1] === undefined) throw new Error('no head style block');
  return match[1];
}

function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start === -1) throw new Error(`no @media ${query}`);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`unclosed @media ${query}`);
}

function ruleFor(css: string, className: string): string {
  const match = new RegExp(String.raw`\.${className}\s*\{([^}]*)\}`).exec(css);
  if (match?.[1] === undefined) throw new Error(`no rule for .${className}`);
  return match[1];
}

function bodyOf(html: string): string {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/.exec(html);
  if (match?.[1] === undefined) throw new Error('no body');
  return match[1];
}

function emailWith(body: EmailBody, overrides: Partial<ResolvedEmail> = {}): ResolvedEmail {
  return {
    subject: 'The subject',
    heading: 'The heading',
    preheader: 'The preview',
    body,
    ...overrides,
  };
}

/** One email holding every element the renderer writes. */
const EVERY_ELEMENT: ResolvedEmail = emailWith({
  blocks: [
    {
      kind: 'paragraph',
      content: [
        'Read ',
        { kind: 'link', text: 'the page', href: 'https://example.test/page' },
        ', ',
        { kind: 'strong', text: 'bold' },
        ' and ',
        { kind: 'mono', text: 'id-1' },
      ],
    },
    { kind: 'paragraph', face: 'mono', content: ['user.lock'] },
    { kind: 'heading', text: 'A section' },
    { kind: 'table', layout: 'figures', rows: [['HushBox', ['5%']]] },
    { kind: 'table', layout: 'facts', rows: [['Actor', ['admin@example.test']]] },
    {
      kind: 'table',
      layout: 'log',
      rows: [{ title: 'user.lock', meta: ['by admin on user ', { kind: 'mono', text: 'id-1' }] }],
    },
  ],
  action: { kind: 'link', label: 'Open', href: 'https://example.test/open' },
  afterAction: [{ kind: 'finePrint', content: ['Fine print.'] }],
});

const ELEMENTS = Object.keys(EMAIL_STYLES) as EmailElement[];

/** Elements only a newsletter issue writes; `markdown.test.ts` holds their paint. */
const ISSUE_ONLY: ReadonlySet<EmailElement> = new Set(['code', 'footText', 'footLink']);
const STANDARD_ELEMENTS = ELEMENTS.filter((element) => !ISSUE_ONLY.has(element));

const BUTTON_FILL = 'email-button-fill';

/** Inline runs and the wordmark's accent take their host's face and size. */
const INHERITS_TYPE: ReadonlySet<EmailElement> = new Set([
  'wordmarkAccent',
  'link',
  'fallbackLink',
  'bottomLink',
]);

describe('renderEmailHtml', () => {
  describe('the dark default', () => {
    const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });

    it.each(STANDARD_ELEMENTS)(
      'writes the %s colour inline as its dark palette value',
      (element) => {
        const tags = tagsWithClass(html, elementClass(element));
        expect(tags.length).toBeGreaterThan(0);
        for (const tag of tags) {
          expect(styleOf(tag).get('color')).toBe(DARK[EMAIL_STYLES[element].colour]);
        }
      }
    );

    it.each(STANDARD_ELEMENTS.filter((element) => !INHERITS_TYPE.has(element)))(
      'writes the %s face, size and weight from the style table',
      (element) => {
        const style = EMAIL_STYLES[element];
        const tags = tagsWithClass(html, elementClass(element));
        expect(tags.length).toBeGreaterThan(0);
        for (const tag of tags) {
          const declarations = styleOf(tag);
          expect(declarations.get('font-family')).toBe(EMAIL_FONT_STACKS[style.face]);
          expect(declarations.get('font-size')).toBe(`${String(style.sizePx)}px`);
          expect(declarations.get('font-weight')).toBe(String(style.weight));
        }
      }
    );

    it('paints the canvas and card surfaces with their dark palette values', () => {
      const canvas = tagsWithClass(html, surfaceClass('canvas'));
      expect(canvas.length).toBeGreaterThan(0);
      for (const tag of canvas) {
        expect(styleOf(tag).get('background-color')).toBe(DARK[EMAIL_SURFACES.canvas.background]);
      }
      const card = onlyTagWithClass(html, surfaceClass('card'));
      expect(styleOf(card).get('background-color')).toBe(DARK[EMAIL_SURFACES.card.background]);
      expect(styleOf(card).get('border')).toBe(`1px solid ${DARK[EMAIL_SURFACES.card.border]}`);
    });

    it('draws every rule in its dark palette value', () => {
      const rules = tagsWithClass(html, surfaceClass('rule'));
      expect(rules.length).toBeGreaterThan(0);
      for (const tag of rules) {
        const border = [...styleOf(tag)].find(([property]) => property.startsWith('border'));
        expect(border?.[1]).toBe(`1px solid ${DARK[EMAIL_SURFACES.rule.border]}`);
      }
    });

    it('fills the button cell and the button link from the button row', () => {
      const fills = tagsWithClass(html, BUTTON_FILL);
      expect(fills.map((tag) => tag.name)).toEqual(['td', 'a']);
      for (const tag of fills) {
        expect(styleOf(tag).get('background-color')).toBe(DARK[EMAIL_STYLES.button.background]);
      }
      expect(fills[0]?.attributes.get('bgcolor')).toBe(DARK[EMAIL_STYLES.button.background]);
    });

    it('fills the button with the accent', () => {
      expect(EMAIL_STYLES.button.background).toBe('accent');
    });

    it('writes the button label in the on-accent colour', () => {
      const button = onlyTagWithClass(html, elementClass('button'));
      expect(button.name).toBe('a');
      expect(styleOf(button).get('color')).toBe(DARK.onAccent);
    });

    it('draws the heading in the text colour, not the accent', () => {
      const heading = onlyTagWithClass(html, elementClass('heading'));
      expect(heading.name).toBe('h1');
      expect(styleOf(heading).get('color')).toBe(DARK.text);
    });

    it('draws every link without an underline', () => {
      const links = tagsOf(html).filter((tag) => tag.name === 'a');
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(styleOf(link).get('text-decoration')).toBe('none');
      }
    });
  });

  describe('the light variant', () => {
    const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
    const light = (): string => mediaBlock(headStyle(html), '(prefers-color-scheme: light)');

    it.each(ELEMENTS)('maps the %s class to its light palette value', (element) => {
      expect(ruleFor(light(), elementClass(element))).toContain(
        `color: ${LIGHT[EMAIL_STYLES[element].colour]} !important`
      );
    });

    it('maps the canvas surface to its light palette value', () => {
      expect(ruleFor(light(), surfaceClass('canvas'))).toBe(
        ` background-color: ${LIGHT[EMAIL_SURFACES.canvas.background]} !important; `
      );
    });

    it('maps the card surface to its light palette values', () => {
      expect(ruleFor(light(), surfaceClass('card'))).toBe(
        ` background-color: ${LIGHT[EMAIL_SURFACES.card.background]} !important; border-color: ${LIGHT[EMAIL_SURFACES.card.border]} !important; `
      );
    });

    it('maps the rule surface to its light palette value', () => {
      expect(ruleFor(light(), surfaceClass('rule'))).toBe(
        ` border-color: ${LIGHT[EMAIL_SURFACES.rule.border]} !important; `
      );
    });

    it('maps the button fill to its light palette value', () => {
      expect(ruleFor(light(), BUTTON_FILL)).toBe(
        ` background-color: ${LIGHT[EMAIL_STYLES.button.background]} !important; `
      );
    });

    it('declares support for both colour schemes', () => {
      const metas = tagsOf(html).filter((tag) => tag.name === 'meta');
      const schemeMetas = metas.filter((tag) =>
        ['color-scheme', 'supported-color-schemes'].includes(tag.attributes.get('name') ?? '')
      );
      expect(schemeMetas.map((tag) => tag.attributes.get('content'))).toEqual([
        'dark light',
        'dark light',
      ]);
      expect(headStyle(html)).toMatch(/:root\s*\{[^}]*color-scheme: dark light;/);
    });
  });

  describe('the light condition', () => {
    it('writes the light variant under the shared light-scheme condition', async () => {
      vi.resetModules();
      vi.doMock('@hushbox/shared/design-tokens', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@hushbox/shared/design-tokens')>()),
        EMAIL_LIGHT_SCHEME_CONDITION: '@media (prefers-color-scheme: light) and (min-width: 1px)',
      }));
      try {
        const html = await import('./html.js');
        const written = html.renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
        expect(headStyle(written)).toContain(
          '@media (prefers-color-scheme: light) and (min-width: 1px) {'
        );
      } finally {
        vi.doUnmock('@hushbox/shared/design-tokens');
        vi.resetModules();
      }
    });
  });

  describe('the kit measurements', () => {
    const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });

    it('holds the column at 600px', () => {
      const column = onlyTagWithClass(html, 'email-column');
      expect(column.attributes.get('width')).toBe('600');
      expect(styleOf(column).get('max-width')).toBe('600px');
    });

    it('pads the card 40px and rounds it 12px', () => {
      expect(styleOf(onlyTagWithClass(html, 'email-card-pad')).get('padding')).toBe('40px');
      expect(styleOf(onlyTagWithClass(html, surfaceClass('card'))).get('border-radius')).toBe(
        '12px'
      );
    });

    it('sets the heading at 22px', () => {
      expect(styleOf(onlyTagWithClass(html, elementClass('heading'))).get('font-size')).toBe(
        '22px'
      );
    });

    it('rounds the button 6px', () => {
      const fills = tagsWithClass(html, BUTTON_FILL);
      expect(fills).toHaveLength(2);
      for (const tag of fills) {
        expect(styleOf(tag).get('border-radius')).toBe('6px');
      }
    });

    it('stretches the button across the card', () => {
      const button = onlyTagWithClass(html, elementClass('button'));
      expect(styleOf(button).get('display')).toBe('block');
      const wrap = onlyTagWithClass(html, 'email-button-wrap');
      expect(wrap.attributes.get('width')).toBe('100%');
    });

    it('takes the phone padding on a screen at most 30em wide', () => {
      const phone = mediaBlock(headStyle(html), '(max-width: 30em)');
      expect(ruleFor(phone, 'email-card-pad')).toContain('padding: 24px 20px !important');
      expect(ruleFor(phone, 'email-canvas-pad')).toContain('padding: 24px 12px !important');
      expect(tagsWithClass(html, 'email-canvas-pad')).toHaveLength(1);
    });
  });

  describe('the frame', () => {
    it('opens the column with the wordmark over a rule', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      const top = onlyTagWithClass(html, 'email-top');
      expect(classesOf(top)).toContain(surfaceClass('rule'));
      expect(styleOf(top).get('border-bottom')).toBe(
        `1px solid ${DARK[EMAIL_SURFACES.rule.border]}`
      );
      expect(html).toMatch(
        /class="email-wordmark"[^>]*>Hush<span class="email-wordmark-accent"[^>]*>Box<\/span><\/span>/
      );
    });

    it('closes the column with the copyright and questions lines under a rule', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      const bottom = onlyTagWithClass(html, elementClass('bottom'));
      expect(styleOf(bottom).get('border-top')).toBe(
        `1px solid ${DARK[EMAIL_SURFACES.rule.border]}`
      );
      expect(html).toContain(`&copy; ${String(REFERENCE_YEAR)} LOME-AI LLC`);
      expect(html).toMatch(
        /Questions\? <a class="email-bottom-link" href="mailto:hello@hushbox\.ai"[^>]*>hello@hushbox\.ai<\/a>/
      );
    });

    it('takes the copyright year from the send date', () => {
      const aYearLater = new Date(TEST_YEAR_START);
      aYearLater.setUTCFullYear(REFERENCE_YEAR + 1);
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: aYearLater });
      expect(html).toContain(`&copy; ${String(REFERENCE_YEAR + 1)} LOME-AI LLC`);
    });

    it('titles the document with the subject', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      expect(html).toContain('<title>The subject</title>');
    });

    it('writes the heading as the one h1', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toMatch(/<h1 [^>]*>The heading<\/h1>/);
    });

    it('writes the preview line as the first element of the body', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      expect(bodyOf(html).trimStart()).toMatch(
        /^<div class="email-preheader"[^>]*>The preview<\/div>/
      );
    });

    it('hides the preview line', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      const preview = styleOf(onlyTagWithClass(html, 'email-preheader'));
      expect(preview.get('display')).toBe('none');
      expect(preview.get('max-height')).toBe('0');
      expect(preview.get('overflow')).toBe('hidden');
    });

    it('writes no preview element when the email has no preview line', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }, { preheader: null }), {
        sentAt: SENT_AT,
      });
      expect(html).not.toContain('email-preheader');
    });

    it('quotes every attribute value', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      for (const tag of tagsOf(html)) {
        const unquoted = tag.source
          .replace(/^<[a-z0-9]+/, '')
          .replace(/>$/, '')
          .replaceAll(/\s[a-z-]+="[^"]*"/g, '');
        expect(unquoted.trim(), tag.source).toBe('');
      }
    });

    it('loads no web font, image or remote resource', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      expect(html).not.toContain('<img');
      expect(html).not.toContain('@font-face');
      expect(html).not.toContain('url(');
      expect(html).not.toContain('<link');
      expect(html).not.toContain('@import');
    });
  });

  describe('the card', () => {
    it('writes the blocks in order after the heading', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      const order = [
        'The heading',
        'Read ',
        'user.lock</p>',
        'A section',
        '5%',
        'admin@example.test',
        'by admin on user ',
        '>Open</a>',
        'Or paste this link into your browser:',
        'Fine print.',
      ].map((marker) => html.indexOf(marker));
      expect(order.every((position) => position !== -1)).toBe(true);
      expect(order).toEqual(order.toSorted((a, b) => a - b));
    });

    it('writes a section heading as an h2', () => {
      const html = renderEmailHtml(
        emailWith({ blocks: [{ kind: 'heading', text: 'A section' }] }),
        {
          sentAt: SENT_AT,
        }
      );
      expect(html).toMatch(/<h2 class="email-section-heading"[^>]*>A section<\/h2>/);
    });

    it('writes a paragraph in the serif unless it asks for mono', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [
            { kind: 'paragraph', face: 'serif', content: ['Serif'] },
            { kind: 'paragraph', face: 'mono', content: ['Mono'] },
          ],
        }),
        { sentAt: SENT_AT }
      );
      expect(html).toMatch(/<p class="email-paragraph"[^>]*>Serif<\/p>/);
      expect(html).toMatch(/<p class="email-op-line"[^>]*>Mono<\/p>/);
    });

    it('writes strong text at weight 700', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      expect(html).toContain('<strong style="font-weight:700;">bold</strong>');
    });

    it('writes mono text in the mono face at 13px', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      expect(html).toContain(
        `<span style="font-family:${EMAIL_FONT_STACKS.mono};font-size:13px;">id-1</span>`
      );
    });

    it('writes a link with its href', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      expect(html).toMatch(
        /<a class="email-link" href="https:\/\/example\.test\/page"[^>]*>the page<\/a>/
      );
    });

    it('aligns a figures value right in tabular figures', () => {
      const html = renderEmailHtml(
        emailWith({ blocks: [{ kind: 'table', layout: 'figures', rows: [['Fee', ['5%']]] }] }),
        { sentAt: SENT_AT }
      );
      const value = styleOf(onlyTagWithClass(html, elementClass('tableValue')));
      expect(value.get('text-align')).toBe('right');
      expect(value.get('font-variant-numeric')).toBe('tabular-nums');
    });

    it('keeps a facts label to its width and wraps the value on the left', () => {
      const html = renderEmailHtml(
        emailWith({ blocks: [{ kind: 'table', layout: 'facts', rows: [['Actor', ['a']]] }] }),
        { sentAt: SENT_AT }
      );
      const label = styleOf(onlyTagWithClass(html, elementClass('tableLabel')));
      expect(label.get('white-space')).toBe('nowrap');
      const value = styleOf(onlyTagWithClass(html, elementClass('tableValue')));
      expect(value.get('text-align')).toBe('left');
      expect(value.get('overflow-wrap')).toBe('anywhere');
    });

    it('writes a log row as its title over its meta line', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [
            { kind: 'table', layout: 'log', rows: [{ title: 'job.redrive', meta: ['by a'] }] },
          ],
        }),
        { sentAt: SENT_AT }
      );
      expect(html).toMatch(
        /<span class="email-log-title"[^>]*>job\.redrive<\/span><span class="email-log-meta"[^>]*>by a<\/span>/
      );
    });

    it('rules every table row', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [
            {
              kind: 'table',
              layout: 'figures',
              rows: [
                ['A', ['1']],
                ['B', ['2']],
              ],
            },
          ],
        }),
        { sentAt: SENT_AT }
      );
      const cells = tagsOf(html).filter(
        (tag) =>
          tag.name === 'td' &&
          classesOf(tag).includes(surfaceClass('rule')) &&
          !classesOf(tag).includes('email-top') &&
          !classesOf(tag).includes(elementClass('bottom'))
      );
      expect(cells).toHaveLength(4);
    });

    it('follows a link action with its paste-this-link line', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [],
          action: { kind: 'link', label: 'Verify', href: 'https://example.test/verify?t=1&u=2' },
        }),
        { sentAt: SENT_AT }
      );
      expect(html).toMatch(
        /<a class="email-button email-button-fill" href="https:\/\/example\.test\/verify\?t=1&amp;u=2"[^>]*>Verify<\/a>/
      );
      expect(html).toMatch(
        /<p class="email-fallback"[^>]*>Or paste this link into your browser:<br><a class="email-fallback-link" href="https:\/\/example\.test\/verify\?t=1&amp;u=2"[^>]*>https:\/\/example\.test\/verify\?t=1&amp;u=2<\/a><\/p>/
      );
    });

    it('follows a mail action with its write-to line', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [],
          action: { kind: 'mail', label: 'Email us', address: 'team@example.test' },
        }),
        { sentAt: SENT_AT }
      );
      expect(html).toMatch(/href="mailto:team@example\.test"[^>]*>Email us<\/a>/);
      expect(html).toMatch(
        /<p class="email-fallback"[^>]*>Or write to <a class="email-fallback-link" href="mailto:team@example\.test"[^>]*>team@example\.test<\/a><\/p>/
      );
    });

    it('writes one action at most', () => {
      const html = renderEmailHtml(EVERY_ELEMENT, { sentAt: SENT_AT });
      expect(tagsWithClass(html, elementClass('button'))).toHaveLength(1);
    });

    it('takes no bottom margin on the last element in the card', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [
            { kind: 'paragraph', content: ['First'] },
            { kind: 'paragraph', content: ['Last'] },
          ],
        }),
        { sentAt: SENT_AT }
      );
      const paragraphs = tagsWithClass(html, elementClass('paragraph'));
      expect(paragraphs.map((tag) => styleOf(tag).get('margin'))).toEqual(['0 0 16px', '0 0 0']);
    });

    it('takes no bottom margin on the fallback line when nothing follows the action', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [],
          action: { kind: 'link', label: 'Go', href: 'https://example.test' },
        }),
        { sentAt: SENT_AT }
      );
      expect(styleOf(onlyTagWithClass(html, elementClass('fallback'))).get('margin')).toBe('0 0 0');
    });

    it('takes no bottom margin on the heading of an empty body', () => {
      const html = renderEmailHtml(emailWith({ blocks: [] }), { sentAt: SENT_AT });
      expect(styleOf(onlyTagWithClass(html, elementClass('heading'))).get('margin')).toBe('0 0 0');
    });
  });

  describe('escaping', () => {
    const HOSTILE = `<b onmouseover="x">Tom & 'Jerry'</b>`;
    const ESCAPED = '&lt;b onmouseover=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/b&gt;';

    it('escapes the subject, heading and preview line', () => {
      const html = renderEmailHtml(
        emailWith({ blocks: [] }, { subject: HOSTILE, heading: HOSTILE, preheader: HOSTILE }),
        { sentAt: SENT_AT }
      );
      expect(html).toContain(`<title>${ESCAPED}</title>`);
      expect(html).toMatch(new RegExp(`<h1 [^>]*>${ESCAPED}</h1>`));
      expect(html).toMatch(new RegExp(`class="email-preheader"[^>]*>${ESCAPED}</div>`));
      expect(html).not.toContain('<b ');
    });

    it('escapes every text a block carries', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [
            { kind: 'heading', text: HOSTILE },
            {
              kind: 'paragraph',
              content: [
                HOSTILE,
                { kind: 'strong', text: HOSTILE },
                { kind: 'mono', text: HOSTILE },
                { kind: 'link', text: HOSTILE, href: 'https://example.test' },
              ],
            },
            { kind: 'finePrint', content: [HOSTILE] },
            { kind: 'table', layout: 'facts', rows: [[HOSTILE, [HOSTILE]]] },
            { kind: 'table', layout: 'log', rows: [{ title: HOSTILE, meta: [HOSTILE] }] },
          ],
          action: { kind: 'mail', label: HOSTILE, address: 'team@example.test' },
        }),
        { sentAt: SENT_AT }
      );
      expect(html.split(ESCAPED).length - 1).toBe(11);
      expect(html).not.toContain('<b ');
    });

    it('escapes an href so it cannot leave its attribute', () => {
      const href = `https://example.test/?q="><script>alert(1)</script>`;
      const html = renderEmailHtml(
        emailWith({
          blocks: [{ kind: 'paragraph', content: [{ kind: 'link', text: 'x', href }] }],
          action: { kind: 'link', label: 'Go', href },
        }),
        { sentAt: SENT_AT }
      );
      expect(html).not.toContain('<script>');
      expect(html).toContain(
        'href="https://example.test/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'
      );
    });

    it('escapes a mail address in its href and its text', () => {
      const html = renderEmailHtml(
        emailWith({
          blocks: [],
          action: { kind: 'mail', label: 'Mail', address: `o'brien@example.test` },
        }),
        { sentAt: SENT_AT }
      );
      expect(html).toContain('href="mailto:o&#39;brien@example.test"');
      expect(html).toContain('>o&#39;brien@example.test</a>');
    });
  });

  describe('link targets', () => {
    const REFUSAL = 'An email link must be https:, http:, or mailto: with a bare address';

    function withInlineLink(href: string): ResolvedEmail {
      return emailWith({
        blocks: [{ kind: 'paragraph', content: [{ kind: 'link', text: 'x', href }] }],
      });
    }

    function withLinkAction(href: string): ResolvedEmail {
      return emailWith({ blocks: [], action: { kind: 'link', label: 'Go', href } });
    }

    function withMailAction(address: string): ResolvedEmail {
      return emailWith({ blocks: [], action: { kind: 'mail', label: 'Mail', address } });
    }

    const REFUSED_HREFS = [
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a javascript: URL in mixed case with leading space', ' JaVaScRiPt:alert(1)'],
      ['a data: URL', 'data:text/html,<p>x</p>'],
      ['a vbscript: URL', 'vbscript:msgbox(1)'],
      ['a mailto: carrying ?cc=', 'mailto:team@example.test?cc=other@example.test'],
      ['a mailto: carrying &body=', 'mailto:team@example.test&body=hello'],
      ['a mailto: with a malformed address', 'mailto:not-an-address'],
      ['a relative path', '/settings'],
    ] as const;

    it.each(REFUSED_HREFS)('refuses %s as an inline link', (_name, href) => {
      expect(() => renderEmailHtml(withInlineLink(href), { sentAt: SENT_AT })).toThrow(REFUSAL);
    });

    it.each(REFUSED_HREFS)('refuses %s as a link action', (_name, href) => {
      expect(() => renderEmailHtml(withLinkAction(href), { sentAt: SENT_AT })).toThrow(REFUSAL);
    });

    it.each([
      ['carrying ?cc=', 'team@example.test?cc=other@example.test'],
      ['carrying &body=', 'team@example.test&body=hello'],
      ['that is malformed', 'not-an-address'],
    ])('refuses a mail action address %s', (_name, address) => {
      expect(() => renderEmailHtml(withMailAction(address), { sentAt: SENT_AT })).toThrow(REFUSAL);
    });

    it.each([
      ['an https: URL', 'https://example.test/page?a=1'],
      ['an http: URL', 'http://localhost:10000/verify?token=t'],
      ['a mailto: with a bare address', 'mailto:security@hushbox.ai'],
    ])('writes %s as an inline link', (_name, href) => {
      const html = renderEmailHtml(withInlineLink(href), { sentAt: SENT_AT });
      expect(html).toContain(`<a class="email-link" href="${href.replaceAll('&', '&amp;')}"`);
    });

    it.each([
      ['an https: URL', 'https://example.test/page?a=1'],
      ['an http: URL', 'http://localhost:10000/verify?token=t'],
      ['a mailto: with a bare address', 'mailto:security@hushbox.ai'],
    ])('writes %s as a link action', (_name, href) => {
      const html = renderEmailHtml(withLinkAction(href), { sentAt: SENT_AT });
      expect(html).toContain(`<a class="email-button email-button-fill" href="${href}"`);
    });

    it('writes a mail action with a bare address', () => {
      const html = renderEmailHtml(withMailAction('security@hushbox.ai'), { sentAt: SENT_AT });
      expect(html).toContain('href="mailto:security@hushbox.ai"');
    });
  });
});
