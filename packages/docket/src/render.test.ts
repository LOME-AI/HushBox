import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPathIndex } from './citations.ts';
import { parseFinding } from './parse.ts';
import { renderFinding } from './render.ts';
import type { Finding } from './types.ts';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'test-fixtures');

const INDEX = buildPathIndex(['apps/api/src/platform.ts', 'apps/api/src/slices/chat/routes.ts']);

function load(name: string): Finding {
  const filePath = path.join(FIXTURE_DIR, `${name}.md`);
  const result = parseFinding(readFileSync(filePath, 'utf8'), filePath);
  if (!result.ok) throw new Error(`fixture ${name} failed to parse`);
  return result.value;
}

function render(finding: Finding): ReturnType<typeof renderFinding> {
  return renderFinding(finding, {
    index: INDEX,
    path: `docs/audits/2026-07-30/findings/${finding.id}.md`,
    hash: 'abc123',
  });
}

describe('renderFinding', () => {
  it('carries every frontmatter field through under its json name', () => {
    const finding = load('ruled-history');
    const json = render(finding);
    expect(json.id).toBe(finding.id);
    expect(json.title).toBe(finding.title);
    expect(json.severity).toBe('high');
    expect(json.kind).toBe('decision');
    expect(json.status).toBe('latent');
    expect(json.statusNote).toBe(finding.status_note);
    expect(json.area).toBe('apps/api');
    expect(json.needsRuling).toBe(true);
    expect(json.needsOptions).toBe(false);
    expect(json.warning).toBe(false);
    expect(json.dedicated).toBe(false);
    expect(json.related).toEqual([]);
    expect(json.group).toBeNull();
    expect(json.state).toBe('ruled');
    expect(json.ruling).toEqual(finding.ruling);
    expect(json.denial).toBeNull();
    expect(json.history).toEqual(finding.history);
    expect(json.questions).toEqual(finding.questions);
    expect(json.progress).toEqual(finding.progress);
  });

  it('carries the file path and hash it was given', () => {
    const json = render(load('no-options'));
    expect(json.path).toBe('docs/audits/2026-07-30/findings/DT-OWN.md');
    expect(json.hash).toBe('abc123');
  });

  it('renders the explainer as html', () => {
    const json = render(load('no-options'));
    expect(json.bodyHtml).toContain('<strong>What this is.</strong>');
  });

  it('leaves the options section out of the body html', () => {
    const json = render(load('ruled-history'));
    expect(json.bodyHtml).not.toContain('Treat zero as authoritative');
    expect(json.bodyHtml).not.toContain('<h2>Options</h2>');
  });

  it('renders each option separately', () => {
    const json = render(load('ruled-history'));
    expect(json.options).toHaveLength(2);
    expect(json.options[0]?.id).toBe('A');
    expect(json.options[0]?.label).toBe('Treat zero as authoritative');
    expect(json.options[0]?.recommended).toBe(false);
    expect(json.options[0]?.meta).toBe('effort: low · risk: silently under-charges');
    expect(json.options[0]?.html).toContain('<p>Trust the inline value even at zero.</p>');
  });

  it('marks the recommended option', () => {
    const json = render(load('ruled-history'));
    expect(json.options[1]?.recommended).toBe(true);
  });

  it('hands the meta line over as prose, not as its markdown source', () => {
    const json = render(load('ruled-history'));
    expect(json.options[1]?.meta).toBe('effort: low · risk: over-flags a genuinely free call');
  });

  it('drops a meta line that carried nothing but the recommendation', () => {
    const finding = load('ruled-history');
    const stripped: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Bare',
          recommended: true,
          dedicated: false,
          meta: '**Recommended**',
          body: 'Prose.',
        },
      ],
    };
    expect(render(stripped).options[0]?.meta).toBeNull();
  });

  it('carries a dedicated finding through as dedicated', () => {
    expect(render(load('dedicated')).dedicated).toBe(true);
  });

  it('carries each option dedication through', () => {
    const options = render(load('dedicated-option')).options;
    expect(options[0]?.dedicated).toBe(true);
    expect(options[1]?.dedicated).toBe(false);
  });

  it('drops the dedication marker from the meta line it was read off', () => {
    expect(render(load('dedicated-option')).options[0]?.meta).toBe('Effort: large · Risk: medium');
  });

  it('leaves a meta line the recommendation never touched alone', () => {
    const json = render(load('ruled-history'));
    expect(json.options[0]?.meta).toBe('effort: low · risk: silently under-charges');
  });

  it('renders a code span in the meta line as markup', () => {
    const finding = load('ruled-history');
    const spanned: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Bare',
          recommended: false,
          dedicated: false,
          meta: 'effort: low · risk: `settle()` charges twice',
          body: 'Prose.',
        },
      ],
    };
    expect(render(spanned).options[0]?.meta).toBe(
      'effort: low · risk: <code>settle()</code> charges twice'
    );
  });

  it('drops an em dash the recommendation left behind as its separator', () => {
    const finding = load('ruled-history');
    const dashed: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Bare',
          recommended: true,
          dedicated: false,
          meta: '**Recommended** — effort: low',
          body: 'Prose.',
        },
      ],
    };
    expect(render(dashed).options[0]?.meta).toBe('effort: low');
  });

  it('drops an en dash the recommendation left behind as its separator', () => {
    const finding = load('ruled-history');
    const dashed: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Bare',
          recommended: true,
          dedicated: false,
          meta: '**Recommended** – effort: low',
          body: 'Prose.',
        },
      ],
    };
    expect(render(dashed).options[0]?.meta).toBe('effort: low');
  });

  it('renders an option whose body is empty as empty html', () => {
    const finding = load('ruled-history');
    const stripped: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Bare',
          recommended: false,
          dedicated: false,
          meta: 'effort: low',
          body: '',
        },
      ],
    };
    expect(render(stripped).options[0]?.html).toBe('');
  });

  it('annotates a citation in the explainer', () => {
    const finding = load('no-options');
    const cited: Finding = { ...finding, explainer: 'See `apps/api/src/platform.ts:16-18`.' };
    expect(render(cited).bodyHtml).toContain(
      'data-citation-path="apps/api/src/platform.ts" data-citation-start="16" data-citation-end="18"'
    );
  });

  it('resolves a bare line in an option against a path named in the explainer', () => {
    const finding = load('no-options');
    const cited: Finding = {
      ...finding,
      explainer: 'See `apps/api/src/slices/chat/routes.ts:1878`.',
      options: [
        {
          id: 'A',
          label: 'Do it',
          recommended: false,
          dedicated: false,
          meta: null,
          body: 'And also `:610`.',
        },
      ],
    };
    const json = render(cited);
    expect(json.options[0]?.html).toContain(
      'data-citation-path="apps/api/src/slices/chat/routes.ts" data-citation-start="610"'
    );
  });

  it('renders inline code in a title as code', () => {
    const finding = load('no-options');
    const titled: Finding = { ...finding, title: 'A bare `fetch` slips past the rule' };

    expect(render(titled).titleHtml).toBe('A bare <code>fetch</code> slips past the rule');
  });

  it('reads a title back as text wherever one is placed as text', () => {
    const finding = load('no-options');
    const titled: Finding = { ...finding, title: 'A bare `fetch` slips past the rule' };

    expect(render(titled).title).toBe('A bare fetch slips past the rule');
  });

  it('reads an area written with code spans back as text', () => {
    const finding = load('no-options');
    const scoped: Finding = { ...finding, area: '`apps/api` (rate limiting)' };
    expect(render(scoped).area).toBe('apps/api (rate limiting)');
  });

  it('leaves an area with nothing to render exactly as it was written', () => {
    const finding = load('no-options');
    const scoped: Finding = { ...finding, area: 'apps/api/src/slices/chat' };
    expect(render(scoped).area).toBe('apps/api/src/slices/chat');
  });

  it('reads two areas that differ only in their code spans back as one area', () => {
    const finding = load('no-options');
    const backticked = render({ ...finding, area: '`packages/db`' });
    const plain = render({ ...finding, area: 'packages/db' });
    expect(backticked.area).toBe(plain.area);
  });

  it('renders raw html in a title as visible text', () => {
    const finding = load('no-options');
    const titled: Finding = { ...finding, title: 'The <img src=x onerror=alert(1)> hero' };
    const json = render(titled);

    expect(json.titleHtml).not.toContain('<img');
    expect(json.titleHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(json.title).toBe('The <img src=x onerror=alert(1)> hero');
  });

  it('leaves a title with nothing to render exactly as it was written', () => {
    const json = render(load('no-options'));

    expect(json.title).toBe(load('no-options').title);
  });

  it('renders a raw html block as visible text', () => {
    const finding = load('no-options');
    const raw: Finding = { ...finding, explainer: '<script>alert(1)</script>' };
    const html = render(raw).bodyHtml;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders an inline html tag as visible text', () => {
    const finding = load('no-options');
    const raw: Finding = { ...finding, explainer: 'Before <img src=x onerror=alert(1)> after.' };
    const html = render(raw).bodyHtml;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  // The meta line is placed as markup, so the escaping the body already relies
  // on has to hold on this line too.
  it('renders raw html in a meta line as visible text', () => {
    const finding = load('no-options');
    const raw: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Do it',
          recommended: false,
          dedicated: false,
          meta: 'effort: <img src=x onerror=alert(1)>',
          body: '',
        },
      ],
    };
    const meta = render(raw).options[0]?.meta;
    expect(meta).not.toContain('<img');
    expect(meta).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders an option body with raw html as visible text', () => {
    const finding = load('no-options');
    const raw: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Do it',
          recommended: false,
          dedicated: false,
          meta: null,
          body: '<iframe></iframe>',
        },
      ],
    };
    expect(render(raw).options[0]?.html).toContain('&lt;iframe&gt;');
  });

  it('drops the href of a link a reader must not be able to follow', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '[click me](javascript:alert(1))' };
    const html = render(linked).bodyHtml;
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  it('drops the href of a link whose scheme is only cased to look unfamiliar', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '[click me](JaVaScRiPt:alert(1))' };
    expect(render(linked).bodyHtml.toLowerCase()).not.toContain('javascript:');
  });

  it('drops the href of a data-url link', () => {
    const finding = load('no-options');
    const linked: Finding = {
      ...finding,
      explainer: '[click me](data:text/html;base64,PHNjcmlwdD4=)',
    };
    expect(render(linked).bodyHtml).not.toContain('data:');
  });

  it('drops the href of an autolink a reader must not be able to follow', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '<javascript:alert(1)>' };
    const html = render(linked).bodyHtml;
    expect(html).not.toContain('<a ');
    expect(html).toContain('javascript:alert(1)');
  });

  it('drops the href of a link in a title', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, title: 'The [hero](javascript:alert(1)) path' };
    const json = render(linked);
    expect(json.titleHtml).not.toContain('javascript:');
    expect(json.titleHtml).toContain('hero');
  });

  it('drops the href of a link in an option body', () => {
    const finding = load('no-options');
    const linked: Finding = {
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Do it',
          recommended: false,
          dedicated: false,
          meta: null,
          body: '[click me](javascript:alert(1))',
        },
      ],
    };
    expect(render(linked).options[0]?.html).not.toContain('javascript:');
  });

  it('keeps the href of an https link', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '[docs](https://example.com/a)' };
    expect(render(linked).bodyHtml).toContain('href="https://example.com/a"');
  });

  it('keeps the href of a mailto link', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '[mail](mailto:a@example.com)' };
    expect(render(linked).bodyHtml).toContain('href="mailto:a@example.com"');
  });

  it('keeps the href of a link that names no scheme at all', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '[file](docs/DESIGN.md)' };
    expect(render(linked).bodyHtml).toContain('href="docs/DESIGN.md"');
  });

  it('keeps the title attribute of a link it lets through', () => {
    const finding = load('no-options');
    const linked: Finding = { ...finding, explainer: '[docs](https://example.com "The docs")' };
    expect(render(linked).bodyHtml).toContain('title="The docs"');
  });

  it('still renders a fenced code block', () => {
    const finding = load('no-options');
    const fenced: Finding = { ...finding, explainer: '```ts\nconst a = 1;\n```' };
    const html = render(fenced).bodyHtml;
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const a = 1;');
  });

  it('still renders a markdown table', () => {
    const finding = load('no-options');
    const table: Finding = { ...finding, explainer: '| a | b |\n| --- | --- |\n| 1 | 2 |' };
    const html = render(table).bodyHtml;
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('builds search text from the id, title, area and body', () => {
    const json = render(load('no-options'));
    expect(json.searchText).toContain('DT-OWN');
    expect(json.searchText).toContain('Device-token ownership');
    expect(json.searchText).toContain('apps/api');
    expect(json.searchText).toContain('single-writer rule forbids');
  });

  it('puts the ruling text, question text and progress notes in the search text', () => {
    const json = render(load('ruled-history'));
    expect(json.searchText).toContain('Estimated');
    expect(json.searchText).toContain('Keep fee application at the port seam.');
    expect(json.searchText).toContain('Does the images API ever return an inline cost?');
    expect(json.searchText).toContain('Reproduced with a zero-cost response.');
  });

  it('puts the denial reason in the search text', () => {
    const json = render(load('denied'));
    expect(json.searchText).toContain('already registered with a registered inverse');
  });
});

describe('renderFinding, question search text', () => {
  it('puts an unanswered question in the search text', () => {
    const json = render(load('question-open'));
    expect(json.searchText).toContain('Is a one-pass delay');
  });
});

/**
 * A destination reaches the DOM through an attribute value, so the html parser
 * resolves character references in it before the url parser reads a scheme.
 * Every spelling here was measured in Chromium: each one lands on a live
 * `javascript:` anchor whose click runs, and each is written the way a hostile
 * finding file would write it rather than the way a browser reports it.
 */
const ENCODED_SCHEMES = [
  ['a decimal reference', '&#106;avascript:alert(1)'],
  ['a hex reference', '&#x6a;avascript:alert(1)'],
  ['a hex reference in capitals', '&#X6A;avascript:alert(1)'],
  ['a reference padded with zeroes', '&#0000106;avascript:alert(1)'],
  ['a capital the scheme is not cased with', '&#74;avascript:alert(1)'],
  ['a decimal reference left without its semicolon', '&#106avascript:alert(1)'],
  ['an encoded colon', 'javascript&#58;alert(1)'],
  ['an encoded colon left without its semicolon', 'javascript&#58alert(1)'],
  ['a hex colon padded with zeroes', 'javascript&#x0000003a;alert(1)'],
  ['a named colon', 'javascript&colon;alert(1)'],
  ['an encoded newline inside the scheme', 'jav&#x0A;ascript:alert(1)'],
  ['an encoded tab inside the scheme', 'jav&#9;ascript:alert(1)'],
  ['an encoded carriage return inside the scheme', 'jav&#13;ascript:alert(1)'],
  ['a named tab inside the scheme', 'jav&Tab;ascript:alert(1)'],
  ['a named newline inside the scheme', 'jav&NewLine;ascript:alert(1)'],
  ['an encoded space in front of the scheme', '&#32;javascript:alert(1)'],
  ['a named tab in front of the scheme', '&Tab;javascript:alert(1)'],
  ['an encoded control character in front of the scheme', '&#1;javascript:alert(1)'],
  ['encodings of two kinds at once', 'jav&#x09;ascript&#58;alert(1)'],
  [
    'every character of the scheme encoded',
    '&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)',
  ],
] as const;

describe('renderFinding, on a scheme spelled in character references', () => {
  it.each(ENCODED_SCHEMES)('drops the href of a link written with %s', (_name, href) => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: `[click me](${href})` }).bodyHtml;
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  it.each(ENCODED_SCHEMES)('drops the src of an image written with %s', (_name, href) => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: `![the diagram](${href})` }).bodyHtml;
    expect(html).not.toContain('<img');
    expect(html).toContain('the diagram');
  });

  it('drops the href of an encoded scheme in a title', () => {
    const finding = load('no-options');
    const json = render({ ...finding, title: 'The [hero](&#106;avascript:alert(1)) path' });
    expect(json.titleHtml).not.toContain('<a ');
    expect(json.titleHtml).toContain('hero');
  });

  it('drops the href of an encoded scheme in an option body', () => {
    const finding = load('no-options');
    const rendered = render({
      ...finding,
      options: [
        {
          id: 'A',
          label: 'Do it',
          recommended: false,
          dedicated: false,
          meta: null,
          body: '[click me](&#x6a;avascript:alert(1))',
        },
      ],
    });
    expect(rendered.options[0]?.html).not.toContain('<a ');
  });

  it.each([
    ['a data url', '&#100;ata:text/html,PHNjcmlwdD4='],
    ['a vbscript url', '&#118;bscript:msgbox(1)'],
    ['a file url', '&#102;ile:///etc/passwd'],
    ['a blob url', '&#98;lob:https://example.com/x'],
  ])('drops the href of %s written in character references', (_name, href) => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: `[click me](${href})` }).bodyHtml;
    expect(html).not.toContain('<a ');
  });

  it('drops the href of a reference this side cannot resolve rather than guessing', () => {
    const finding = load('no-options');
    const html = render({
      ...finding,
      explainer: '[click me](jav&SomeRef;ascript:alert(1))',
    }).bodyHtml;
    expect(html).not.toContain('<a ');
  });
});

describe('renderFinding, on a destination an encoding scare does not make dangerous', () => {
  /**
   * A code point the parser cannot represent becomes the replacement character
   * rather than the character the reference asked for, so the scheme behind it
   * never starts and the destination is the relative one a browser resolves it
   * to (measured in Chromium for each of these three).
   */
  it.each([
    ['a zero code point', '&#0;javascript:alert(1)'],
    ['a surrogate code point', '&#xD800;javascript:alert(1)'],
    ['a code point past the last one', '&#x110000;javascript:alert(1)'],
  ])('reads %s as the relative destination a browser reads it as', (_name, href) => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: `[click me](${href})` }).bodyHtml;
    expect(html).toContain('<a ');
    expect(html).not.toContain('href="javascript:');
  });

  it('keeps the href of a relative link holding an ampersand of its own', () => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: '[notes](R&D.md)' }).bodyHtml;
    expect(html).toContain('href="R&D.md"');
  });

  it('keeps the href of an https link whose query joins with an encoded ampersand', () => {
    const finding = load('no-options');
    const html = render({
      ...finding,
      explainer: '[docs](https://example.com/a?x=1&amp;y=2)',
    }).bodyHtml;
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
  });

  it('keeps the href of an https link whose query carries an encoded scheme', () => {
    const finding = load('no-options');
    const html = render({
      ...finding,
      explainer: '[docs](https://example.com/a?q=&#106;avascript:x)',
    }).bodyHtml;
    expect(html).toContain('<a ');
  });

  it('keeps the src of an https image', () => {
    const finding = load('no-options');
    const html = render({
      ...finding,
      explainer: '![the diagram](https://example.com/a.png)',
    }).bodyHtml;
    expect(html).toContain('<img src="https://example.com/a.png"');
  });
});

describe('renderFinding, on an image a reader must not be able to load', () => {
  it('drops the src of an image pointing at a script url', () => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: '![the diagram](javascript:alert(1))' }).bodyHtml;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
  });

  it('keeps the alt text of an image whose src it dropped', () => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: '![the diagram](javascript:alert(1))' }).bodyHtml;
    expect(html).toContain('the diagram');
  });

  it('shows the alt text of a dropped image as text rather than as markup', () => {
    const finding = load('no-options');
    const html = render({ ...finding, explainer: '![<b>bold</b>](vbscript:msgbox(1))' }).bodyHtml;
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('drops the src of an image pointing at a data url', () => {
    const finding = load('no-options');
    const html = render({
      ...finding,
      explainer: '![the diagram](data:text/html;base64,PHNjcmlwdD4=)',
    }).bodyHtml;
    expect(html).not.toContain('<img');
  });

  it('drops the src of an image in a title', () => {
    const finding = load('no-options');
    const json = render({ ...finding, title: 'The ![hero](javascript:alert(1)) path' });
    expect(json.titleHtml).not.toContain('<img');
  });
});
