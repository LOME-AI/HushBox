import { z } from 'zod';
import { EMAIL_LIGHT_SCHEME_CONDITION, EMAIL_PALETTE } from '@hushbox/shared/design-tokens';
import { EMAIL_LEGAL_OWNER, QUESTIONS_CONTACT_EMAIL } from './common.js';
import { escapeHtml } from './escape.js';
import {
  EMAIL_FONT_STACKS,
  EMAIL_INLINE_MONO_SIZE_PX,
  EMAIL_STYLES,
  EMAIL_SURFACES,
  elementClass,
  surfaceClass,
} from './styles.js';
import type {
  EmailAction,
  EmailBlock,
  Inline,
  ResolvedEmail,
  ResolvedIssueFoot,
  ResolvedNewsletterIssue,
} from './document.js';
import type { MarkdownBlock, MarkdownRun } from './markdown.js';
import type { EmailElement, EmailSurface, EmailSurfaces } from './styles.js';

// The dark scheme is written inline because it is the default every client shows; the
// light one reaches only clients that honour prefers-color-scheme, through the head
// style, whose !important is what outranks an inline declaration.
type Scheme = keyof typeof EMAIL_PALETTE;

interface ElementPaint {
  readonly colour: string;
  readonly background: string;
}

type SurfacePaint<Row> = { readonly [Part in keyof Row]: string };

function elementPaint(element: EmailElement, scheme: Scheme): ElementPaint {
  const palette = EMAIL_PALETTE[scheme];
  const style = EMAIL_STYLES[element];
  return { colour: palette[style.colour], background: palette[style.background] };
}

function surfacePaint<K extends EmailSurface>(
  surface: K,
  scheme: Scheme
): SurfacePaint<EmailSurfaces[K]> {
  const palette = EMAIL_PALETTE[scheme];
  const row: {
    readonly background?: keyof typeof palette;
    readonly border?: keyof typeof palette;
  } = EMAIL_SURFACES[surface];
  // The row's parts are exactly the keys this builds, so the per-surface shape holds.
  return {
    ...(row.background === undefined ? {} : { background: palette[row.background] }),
    ...(row.border === undefined ? {} : { border: palette[row.border] }),
  } as SurfacePaint<EmailSurfaces[K]>;
}

/** The class that carries the button's fill, on its cell as well as its link. */
const BUTTON_FILL_CLASS = `${elementClass('button')}-fill`;

/** The class that carries the code well, on code blocks and inline code. */
const CODE_FILL_CLASS = `${elementClass('code')}-fill`;

const CANVAS_PAD_CLASS = 'email-canvas-pad';
const CARD_PAD_CLASS = 'email-card-pad';

/** A piece of the card, written knowing whether it closes the card. */
type CardPiece = (last: boolean) => string;

function classes(...names: readonly string[]): string {
  return names.join(' ');
}

function typeOf(element: EmailElement): string {
  const style = EMAIL_STYLES[element];
  return `font-family:${EMAIL_FONT_STACKS[style.face]};font-size:${String(style.sizePx)}px;font-weight:${String(style.weight)};`;
}

function colourOf(element: EmailElement): string {
  return `color:${elementPaint(element, 'dark').colour};`;
}

function px(value: number): string {
  return value === 0 ? '0' : `${String(value)}px`;
}

/** Card content takes its bottom margin except where it closes the card. */
function margin(topPx: number, bottomPx: number, last: boolean): string {
  return `margin:${px(topPx)} 0 ${last ? '0' : px(bottomPx)};`;
}

function ruleBorder(side: 'top' | 'bottom'): string {
  return `border-${side}:1px solid ${surfacePaint('rule', 'dark').border};`;
}

const WEB_SCHEMES: ReadonlySet<string> = new Set(['https:', 'http:']);
const MAILTO = 'mailto:';
const BARE_ADDRESS = z.email();

class EmailLinkError extends Error {
  constructor() {
    super('An email link must be https:, http:, or mailto: with a bare address');
    this.name = 'EmailLinkError';
  }
}

function isWebUrl(href: string): boolean {
  return URL.canParse(href) && WEB_SCHEMES.has(new URL(href).protocol);
}

/**
 * The one rule on link targets. A `mailto:` takes a bare address only, because a query
 * would let a definition prefill the recipients or the message.
 */
export function isAllowedEmailHref(href: string): boolean {
  return href.startsWith(MAILTO)
    ? BARE_ADDRESS.safeParse(href.slice(MAILTO.length)).success
    : isWebUrl(href);
}

/**
 * Every link target a definition supplies passes here; any target the rule refuses is a
 * defect in the definition, so the writer throws rather than send it.
 */
function checkedHref(href: string): string {
  if (!isAllowedEmailHref(href)) throw new EmailLinkError();
  return href;
}

/** Breaks a word wider than its column, such as a pasted URL, instead of widening the email. */
const BREAK_LONG_WORDS = 'overflow-wrap:anywhere;word-break:break-word;';

/** `inner` is written as given, so it must already be escaped. */
function anchor(element: EmailElement, href: string, inner: string, breaks = ''): string {
  return `<a class="${elementClass(element)}" href="${escapeHtml(href)}" style="${colourOf(element)}text-decoration:none;${breaks}">${inner}</a>`;
}

function link(element: EmailElement, href: string, text: string): string {
  return anchor(element, href, escapeHtml(text));
}

const CELL_TOKEN_LIMIT = 24;
const CELL_BREAK_EVERY = 12;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
/**
 * Whitespace a line can break at: JavaScript's `\s` less the no-break spaces (U+00A0,
 * U+2007, U+202F, U+FEFF), which join a token rather than end it.
 */
const BREAKABLE_SPACE = /([\t\n\v\f\r \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]+)/;

/**
 * Table-cell text, escaped, with a `<wbr>` after every 12 characters of any token longer
 * than 24. A cell takes no CSS break rule, since `overflow-wrap:anywhere` on a cell lets
 * automatic table layout squeeze its column below its longest ordinary word. Each piece is
 * escaped on its own, so a break never falls inside an entity.
 */
function escapeCellText(text: string): string {
  return text
    .split(BREAKABLE_SPACE)
    .map((part, index) => {
      const characters = Array.from(GRAPHEMES.segment(part), (piece) => piece.segment);
      if (index % 2 === 1 || characters.length <= CELL_TOKEN_LIMIT) return escapeHtml(part);
      const pieces: string[] = [];
      for (let start = 0; start < characters.length; start += CELL_BREAK_EVERY) {
        pieces.push(escapeHtml(characters.slice(start, start + CELL_BREAK_EVERY).join('')));
      }
      return pieces.join('<wbr>');
    })
    .join('');
}

/**
 * How a block's runs are written: flowing text breaks a long word by the shared rule,
 * while a table cell's runs carry no rule at all and take soft break points instead.
 */
interface RunWriting {
  readonly escapeText: (text: string) => string;
  readonly linkBreaks: string;
}

const IN_FLOW: RunWriting = { escapeText: escapeHtml, linkBreaks: BREAK_LONG_WORDS };
const IN_CELL: RunWriting = { escapeText: escapeCellText, linkBreaks: '' };

/** A link in body text, whose label may be a user's or an admin's; `inner` must be escaped. */
function bodyAnchor(href: string, inner: string, writing: RunWriting): string {
  return anchor('link', href, inner, writing.linkBreaks);
}

/** `inner` must already be escaped. */
function strongHtml(inner: string): string {
  return `<strong style="font-weight:700;">${inner}</strong>`;
}

function inlineHtml(content: readonly Inline[], writing: RunWriting = IN_FLOW): string {
  const { escapeText } = writing;
  return content
    .map((run) => {
      if (typeof run === 'string') return escapeText(run);
      switch (run.kind) {
        case 'link': {
          return bodyAnchor(checkedHref(run.href), escapeText(run.text), writing);
        }
        case 'strong': {
          return strongHtml(escapeText(run.text));
        }
        case 'mono': {
          return `<span style="font-family:${EMAIL_FONT_STACKS.mono};font-size:${String(EMAIL_INLINE_MONO_SIZE_PX)}px;">${escapeText(run.text)}</span>`;
        }
      }
    })
    .join('');
}

function textBlock(
  tag: 'h1' | 'h2' | 'p',
  element: EmailElement,
  box: { readonly top: number; readonly bottom: number; readonly lineHeight: string },
  inner: string
): CardPiece {
  return (last) =>
    `<${tag} class="${elementClass(element)}" style="${margin(box.top, box.bottom, last)}${typeOf(element)}line-height:${box.lineHeight};${colourOf(element)}${BREAK_LONG_WORDS}">${inner}</${tag}>`;
}

function tableOpen(last: boolean): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;${margin(8, 20, last)}">`;
}

function cell(element: EmailElement, layout: string, inner: string): string {
  return `<td class="${classes(elementClass(element), surfaceClass('rule'))}" style="padding:8px 0;${ruleBorder('bottom')}${layout}${typeOf(element)}${colourOf(element)}">${inner}</td>`;
}

const LABEL_LAYOUT = {
  figures: '',
  facts: 'width:1%;white-space:nowrap;padding-right:16px;vertical-align:top;',
} as const;

const VALUE_LAYOUT = {
  figures: 'text-align:right;font-variant-numeric:tabular-nums;',
  facts: `text-align:left;${BREAK_LONG_WORDS}`,
} as const;

/** A facts value breaks by its cell's own rule, and a facts label never wraps. */
const CELL_WRITING: Readonly<Record<'figures' | 'facts', RunWriting>> = {
  figures: IN_CELL,
  facts: { escapeText: escapeHtml, linkBreaks: '' },
};

function tableBlock(block: Extract<EmailBlock, { kind: 'table' }>): CardPiece {
  if (block.layout === 'log') {
    const rows = block.rows
      .map(
        (row) =>
          `<tr><td class="${surfaceClass('rule')}" style="padding:8px 0;${ruleBorder('bottom')}vertical-align:top;">` +
          `<span class="${elementClass('logTitle')}" style="display:block;${typeOf('logTitle')}line-height:1.5;${colourOf('logTitle')}${BREAK_LONG_WORDS}">${escapeHtml(row.title)}</span>` +
          `<span class="${elementClass('logMeta')}" style="display:block;margin-top:2px;${typeOf('logMeta')}line-height:1.5;${colourOf('logMeta')}${BREAK_LONG_WORDS}">${inlineHtml(row.meta)}</span>` +
          `</td></tr>`
      )
      .join('');
    return (last) => `${tableOpen(last)}${rows}</table>`;
  }
  const { layout } = block;
  const rows = block.rows
    .map(
      ([label, value]) =>
        `<tr>${cell('tableLabel', LABEL_LAYOUT[layout], CELL_WRITING[layout].escapeText(label))}${cell('tableValue', VALUE_LAYOUT[layout], inlineHtml(value, CELL_WRITING[layout]))}</tr>`
    )
    .join('');
  return (last) => `${tableOpen(last)}${rows}</table>`;
}

const BODY_TEXT = { top: 0, bottom: 16, lineHeight: '1.6' } as const;

/** Every email's h1: its subject, or the heading it declares. */
function headingPiece(heading: string): CardPiece {
  return textBlock('h1', 'heading', { top: 0, bottom: 16, lineHeight: '1.3' }, escapeHtml(heading));
}

/** A section heading under the h1; `inner` must already be escaped. */
function sectionHeadingPiece(inner: string): CardPiece {
  return textBlock('h2', 'sectionHeading', { top: 24, bottom: 8, lineHeight: '1.35' }, inner);
}

/** Writes the pieces in order; only the last closes the card when `last` holds. */
function writePieces(pieces: readonly CardPiece[], last = true): string {
  return pieces.map((piece, index) => piece(last && index === pieces.length - 1)).join('');
}

function blockPiece(block: EmailBlock): CardPiece {
  switch (block.kind) {
    case 'heading': {
      return sectionHeadingPiece(escapeHtml(block.text));
    }
    case 'paragraph': {
      return block.face === 'mono'
        ? textBlock('p', 'opLine', { ...BODY_TEXT, lineHeight: '1.5' }, inlineHtml(block.content))
        : textBlock('p', 'paragraph', BODY_TEXT, inlineHtml(block.content));
    }
    case 'finePrint': {
      return textBlock('p', 'finePrint', BODY_TEXT, inlineHtml(block.content));
    }
    case 'table': {
      return tableBlock(block);
    }
  }
}

function actionPieces(action: EmailAction): CardPiece[] {
  const href = checkedHref(action.kind === 'link' ? action.href : `mailto:${action.address}`);
  const fillColour = elementPaint('button', 'dark').background;
  const fill = `background-color:${fillColour};border-radius:6px;`;
  const button: CardPiece = (last) =>
    `<table role="presentation" class="email-button-wrap" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;${margin(8, 12, last)}">` +
    `<tr><td align="center" class="${BUTTON_FILL_CLASS}" bgcolor="${fillColour}" style="padding:0;${fill}">` +
    `<a class="${classes(elementClass('button'), BUTTON_FILL_CLASS)}" href="${escapeHtml(href)}" style="display:block;padding:14px 20px;${fill}${typeOf('button')}line-height:20px;text-align:center;text-decoration:none;${colourOf('button')}">${escapeHtml(action.label)}</a>` +
    `</td></tr></table>`;
  const fallbackLine =
    action.kind === 'link'
      ? `Or paste this link into your browser:<br>${link('fallbackLink', href, action.href)}`
      : `Or write to ${link('fallbackLink', href, action.address)}`;
  const fallback: CardPiece = (last) =>
    `<p class="${elementClass('fallback')}" style="${margin(0, 16, last)}${typeOf('fallback')}line-height:1.45;${colourOf('fallback')}word-break:break-all;">${fallbackLine}</p>`;
  return [button, fallback];
}

function cardHtml(email: ResolvedEmail): string {
  const { body } = email;
  const pieces: CardPiece[] = [
    headingPiece(email.heading),
    ...body.blocks.map((block) => blockPiece(block)),
    ...(body.action === undefined
      ? []
      : [
          ...actionPieces(body.action),
          ...(body.afterAction ?? []).map((block) => blockPiece(block)),
        ]),
  ];
  return writePieces(pieces);
}

type Tone = 'body' | 'muted';

/** Paragraph text, or the muted text a block quote's paragraphs take. */
function toneElement(tone: Tone): EmailElement {
  return tone === 'muted' ? 'finePrint' : 'paragraph';
}

function codeFill(): string {
  return `background-color:${elementPaint('code', 'dark').background};`;
}

function markdownRunsHtml(runs: readonly MarkdownRun[], writing: RunWriting = IN_FLOW): string {
  const { escapeText } = writing;
  return runs
    .map((run) => {
      switch (run.kind) {
        case 'text': {
          return escapeText(run.text);
        }
        case 'link': {
          return bodyAnchor(checkedHref(run.href), markdownRunsHtml(run.content, writing), writing);
        }
        case 'labelLink': {
          return markdownRunsHtml(run.content, writing);
        }
        case 'strong': {
          return strongHtml(markdownRunsHtml(run.content, writing));
        }
        case 'em': {
          return `<em style="font-style:italic;">${markdownRunsHtml(run.content, writing)}</em>`;
        }
        case 'del': {
          return `<del style="text-decoration:line-through;">${markdownRunsHtml(run.content, writing)}</del>`;
        }
        case 'code': {
          return `<code class="${classes(elementClass('code'), CODE_FILL_CLASS)}" style="padding:1px 4px;border-radius:4px;${codeFill()}font-family:${EMAIL_FONT_STACKS.mono};font-size:${String(EMAIL_INLINE_MONO_SIZE_PX)}px;font-weight:${String(EMAIL_STYLES.code.weight)};${colourOf('code')}">${escapeText(run.text)}</code>`;
        }
        case 'break': {
          return '<br>';
        }
      }
    })
    .join('');
}

/**
 * A list item's own content: its paragraphs take the item's type, its lists nest. A
 * paragraph a nested list follows keeps no margin, so the nested items sit as close to
 * it as sibling items sit to each other.
 */
function listItemBlockHtml(
  block: MarkdownBlock,
  tone: Tone,
  place: { readonly last: boolean; readonly next: MarkdownBlock | undefined }
): string {
  const { last } = place;
  switch (block.kind) {
    case 'paragraph': {
      const flush = last || place.next?.kind === 'list';
      return `<p style="${margin(0, 8, flush)}">${markdownRunsHtml(block.content)}</p>`;
    }
    case 'list': {
      return listHtml(block, tone, { top: 4, last });
    }
    default: {
      return writePieces(markdownPieces(block, tone), last);
    }
  }
}

function listHtml(
  block: Extract<MarkdownBlock, { kind: 'list' }>,
  tone: Tone,
  place: { readonly top: number; readonly last: boolean }
): string {
  const element = toneElement(tone);
  const tag = block.ordered ? 'ol' : 'ul';
  const start = block.ordered && block.start !== 1 ? ` start="${String(block.start)}"` : '';
  const items = block.items
    .map((item, index) => {
      const inner = item
        .map((child, childIndex) =>
          listItemBlockHtml(child, tone, {
            last: childIndex === item.length - 1,
            next: item[childIndex + 1],
          })
        )
        .join('');
      return `<li class="${elementClass(element)}" style="${margin(0, 4, index === block.items.length - 1)}${typeOf(element)}line-height:1.6;${colourOf(element)}${BREAK_LONG_WORDS}">${inner}</li>`;
    })
    .join('');
  return `<${tag}${start} style="${margin(place.top, 16, place.last)}padding-left:24px;">${items}</${tag}>`;
}

/** A markdown table takes the figures layout: its first column labels, the rest values. */
function layoutOf(column: number): string {
  return column === 0 ? LABEL_LAYOUT.figures : VALUE_LAYOUT.figures;
}

function markdownTableHtml(block: Extract<MarkdownBlock, { kind: 'table' }>): CardPiece {
  const header = `<tr>${block.header.map((cellRuns, column) => cell('tableLabel', layoutOf(column), markdownRunsHtml(cellRuns, IN_CELL))).join('')}</tr>`;
  const rows = block.rows
    .map(
      (row) =>
        `<tr>${row.map((cellRuns, column) => cell(column === 0 ? 'tableLabel' : 'tableValue', layoutOf(column), markdownRunsHtml(cellRuns, IN_CELL))).join('')}</tr>`
    )
    .join('');
  return (last) => `${tableOpen(last)}${header}${rows}</table>`;
}

/** An issue's markdown block, written in the email styles; a quote writes its blocks muted. */
function markdownPieces(block: MarkdownBlock, tone: Tone): CardPiece[] {
  switch (block.kind) {
    case 'heading': {
      return [sectionHeadingPiece(markdownRunsHtml(block.content))];
    }
    case 'paragraph': {
      return [textBlock('p', toneElement(tone), BODY_TEXT, markdownRunsHtml(block.content))];
    }
    case 'quote': {
      return block.blocks.flatMap((child) => markdownPieces(child, 'muted'));
    }
    case 'list': {
      return [(last) => listHtml(block, tone, { top: 0, last })];
    }
    case 'code': {
      return [
        (last) =>
          `<pre class="${classes(elementClass('code'), CODE_FILL_CLASS, surfaceClass('rule'))}" style="${margin(0, 16, last)}padding:12px 16px;border:1px solid ${surfacePaint('rule', 'dark').border};border-radius:6px;${codeFill()}${typeOf('code')}line-height:1.5;${colourOf('code')}white-space:pre-wrap;${BREAK_LONG_WORDS}">${escapeHtml(block.text)}</pre>`,
      ];
    }
    case 'rule': {
      return [
        (last) =>
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;${margin(24, 24, last)}"><tr><td class="${surfaceClass('rule')}" style="${ruleBorder('top')}font-size:0;line-height:0;">&nbsp;</td></tr></table>`,
      ];
    }
    case 'table': {
      return [markdownTableHtml(block)];
    }
  }
}

function issueFoot(foot: ResolvedIssueFoot): CardPiece {
  return () =>
    `<div class="${classes(elementClass('footText'), surfaceClass('rule'))}" style="margin:32px 0 0;padding-top:16px;${ruleBorder('top')}${typeOf('footText')}line-height:1.5;${colourOf('footText')}">` +
    `<p style="margin:0 0 4px;">${escapeHtml(foot.reason)} ${link('footLink', checkedHref(foot.unsubscribeUrl), 'Unsubscribe')}</p>` +
    `<p style="margin:0;">${escapeHtml(foot.postalLine)}</p>` +
    `</div>`;
}

function issueCardHtml(issue: ResolvedNewsletterIssue): string {
  const pieces: CardPiece[] = [
    headingPiece(issue.heading),
    ...issue.blocks.flatMap((block) => markdownPieces(block, 'body')),
    issueFoot(issue.foot),
  ];
  return writePieces(pieces);
}

function lightDeclarations(background?: string, border?: string, colour?: string): string {
  return [
    colour === undefined ? '' : `color: ${colour} !important;`,
    background === undefined ? '' : `background-color: ${background} !important;`,
    border === undefined ? '' : `border-color: ${border} !important;`,
  ]
    .filter((declaration) => declaration !== '')
    .join(' ');
}

function headStyle(): string {
  const elementRules = (Object.keys(EMAIL_STYLES) as EmailElement[]).map(
    (element) =>
      `.${elementClass(element)} { ${lightDeclarations(undefined, undefined, elementPaint(element, 'light').colour)} }`
  );
  const buttonFillRule = `.${BUTTON_FILL_CLASS} { ${lightDeclarations(elementPaint('button', 'light').background)} }`;
  const codeFillRule = `.${CODE_FILL_CLASS} { ${lightDeclarations(elementPaint('code', 'light').background)} }`;
  const surfaceRules = (Object.keys(EMAIL_SURFACES) as EmailSurface[]).map((surface) => {
    const painted: { readonly background?: string; readonly border?: string } = surfacePaint(
      surface,
      'light'
    );
    return `.${surfaceClass(surface)} { ${lightDeclarations(painted.background, painted.border)} }`;
  });
  return [
    ':root { color-scheme: dark light; supported-color-schemes: dark light; }',
    '@media (max-width: 30em) {',
    `  .${CANVAS_PAD_CLASS} { padding: 24px 12px !important; }`,
    `  .${CARD_PAD_CLASS} { padding: 24px 20px !important; }`,
    '}',
    `${EMAIL_LIGHT_SCHEME_CONDITION} {`,
    ...[...elementRules, buttonFillRule, codeFillRule, ...surfaceRules].map((rule) => `  ${rule}`),
    '}',
  ].join('\n');
}

function preheaderHtml(preheader: string | null): string {
  if (preheader === null) return '';
  return `<div class="email-preheader" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>\n`;
}

function frameHtml(
  page: { readonly subject: string; readonly preheader: string | null; readonly card: string },
  options: { readonly sentAt: Date }
): string {
  const year = String(options.sentAt.getUTCFullYear());
  const canvas = surfaceClass('canvas');
  const canvasFill = surfacePaint('canvas', 'dark').background;
  const card = surfacePaint('card', 'dark');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escapeHtml(page.subject)}</title>
<style>
${headStyle()}
</style>
</head>
<body class="${canvas}" style="margin:0;padding:0;background-color:${canvasFill};">
${preheaderHtml(page.preheader)}<table role="presentation" class="${canvas}" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background-color:${canvasFill};">
<tr><td align="center" class="${CANVAS_PAD_CLASS}" style="padding:40px 20px;">
<table role="presentation" class="email-column" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse;">
<tr><td align="center" class="${classes('email-top', surfaceClass('rule'))}" style="padding:20px 0;${ruleBorder('bottom')}"><span class="${elementClass('wordmark')}" style="display:inline-block;${typeOf('wordmark')}line-height:1.2;letter-spacing:2px;${colourOf('wordmark')}">Hush<span class="${elementClass('wordmarkAccent')}" style="${colourOf('wordmarkAccent')}">Box</span></span></td></tr>
<tr><td style="padding:40px 0;">
<table role="presentation" class="${surfaceClass('card')}" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;background-color:${card.background};border:1px solid ${card.border};border-radius:12px;">
<tr><td class="${CARD_PAD_CLASS}" style="padding:40px;">${page.card}</td></tr>
</table>
</td></tr>
<tr><td align="center" class="${classes(elementClass('bottom'), surfaceClass('rule'))}" style="padding:20px 0;${ruleBorder('top')}text-align:center;${typeOf('bottom')}line-height:1.5;${colourOf('bottom')}"><p style="margin:0 0 8px;">&copy; ${year} ${escapeHtml(EMAIL_LEGAL_OWNER)}</p><p style="margin:0;">Questions? ${link('bottomLink', `mailto:${QUESTIONS_CONTACT_EMAIL}`, QUESTIONS_CONTACT_EMAIL)}</p></td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/**
 * The HTML part: the dark palette inline, the light variant for clients that ask for
 * it, the wordmark over a rule, one card, and the bottom block whose year is the send
 * date's UTC year. Every string that reaches it is escaped here, and every attribute
 * value is quoted, which is the only form `escapeHtml` makes safe.
 */
export function renderEmailHtml(email: ResolvedEmail, options: { readonly sentAt: Date }): string {
  return frameHtml(
    { subject: email.subject, preheader: email.preheader, card: cardHtml(email) },
    options
  );
}

/**
 * A newsletter issue in the same frame: its subject as the h1, its markdown in the email
 * styles, and its foot closing the card. It has no preview line.
 */
export function renderIssueHtml(
  issue: ResolvedNewsletterIssue,
  options: { readonly sentAt: Date }
): string {
  return frameHtml(
    { subject: issue.subject, preheader: null, card: issueCardHtml(issue) },
    options
  );
}
