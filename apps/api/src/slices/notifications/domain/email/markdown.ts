import { decodeHTMLStrict } from 'entities';
import { Marked } from 'marked';
import { z } from 'zod';
import { isAllowedEmailHref } from './html.js';
import type { MarkedToken, Token, Tokens } from 'marked';

/** A run of text inside a markdown block; every text is unescaped until the writer. */
export type MarkdownRun =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly href: string; readonly content: readonly MarkdownRun[] }
  /**
   * A link inside another link's label. Its target is checked like any link's, but it is
   * written as its text, since one anchor cannot hold another.
   */
  | { readonly kind: 'labelLink'; readonly href: string; readonly content: readonly MarkdownRun[] }
  | { readonly kind: 'strong' | 'em' | 'del'; readonly content: readonly MarkdownRun[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'break' };

type Cell = readonly MarkdownRun[];

/** What an issue's markdown maps onto: each kind is written in an email style. */
export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly content: readonly MarkdownRun[] }
  | { readonly kind: 'paragraph'; readonly content: readonly MarkdownRun[] }
  | { readonly kind: 'quote'; readonly blocks: readonly MarkdownBlock[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly MarkdownBlock[])[];
    }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'rule' }
  | {
      readonly kind: 'table';
      readonly header: readonly Cell[];
      readonly rows: readonly (readonly Cell[])[];
    };

type Piece =
  | { readonly blocks: readonly MarkdownBlock[] }
  | { readonly runs: readonly MarkdownRun[] };

/**
 * Where each character of a string the lexer read sits in the issue's source, so the one
 * walk that maps tokens also marks the source the text part must keep as typed. An origin
 * is a source index, `LEAD` for a quote's or list item's indentation and line breaks, which
 * no reference can sit in, or `UNPLACED` where the string was not found in the string it was
 * lexed from; `enclosing`
 * is the nearest placed ancestor's origins, which code in an unplaced string keeps whole.
 */
interface Frame {
  readonly text: string;
  readonly origin: readonly number[];
  readonly enclosing: readonly number[];
}

const LEAD = -2;
const UNPLACED = -1;

/**
 * Source characters the text part writes other than by decoding: `typed` ones as they are
 * (code and raw HTML, which the HTML part also shows as typed) and `dropped` ones not at
 * all (an escape's backslash, which the HTML part does not show).
 */
interface TextPartMarks {
  readonly typed: Set<number>;
  readonly dropped: Set<number>;
}

interface Context {
  /** An image inside a link keeps only its label, so no link is written inside another. */
  readonly inLink: boolean;
  /** The string the token being mapped was lexed from, or the token's own source. */
  readonly frame: Frame;
  /** How the text part writes the source characters the walk has claimed. */
  readonly textPart: TextPartMarks;
  /** The reference definitions' sources, where a reference link's address was written. */
  readonly definitions: readonly Frame[];
}

type TokenByKind = { [T in MarkedToken as T['type']]: T };

/** One mapping per token kind marked can produce, so a kind it adds cannot pass unmapped. */
export type TokenMapping = {
  readonly [K in keyof TokenByKind]: (token: TokenByKind[K], context: Context) => Piece;
};

// A dedicated instance: the module-level `marked` singleton carries option state another
// consumer could change. No extension is registered, so every token is a `MarkedToken`.
const MARKDOWN = new Marked({ gfm: true });

function text(value: string): MarkdownRun {
  return { kind: 'text', text: value };
}

/**
 * Character references decode as CommonMark decodes them: only a reference closed by its
 * `;` counts, which is the strict decoder's rule and not the browser's attribute rule.
 * Marked leaves every reference as typed, so the mapping decodes text and targets here.
 */
function decodeReferences(value: string): string {
  return decodeHTMLStrict(value);
}

function placedFrame(text: string, origin: readonly number[], enclosing: readonly number[]): Frame {
  return { text, origin, enclosing: origin.includes(UNPLACED) ? enclosing : origin };
}

/** Finds `raw` in the string it was lexed from, at or after `from`, in reading order. */
function placeIn(parent: Frame, raw: string, from: number): { frame: Frame; next: number } {
  const at = parent.text.indexOf(raw, from);
  if (at === -1) {
    const origin = Array.from({ length: raw.length }, () => UNPLACED);
    return { frame: { text: raw, origin, enclosing: parent.enclosing }, next: from };
  }
  const origin = parent.origin.slice(at, at + raw.length);
  return { frame: placedFrame(raw, origin, parent.enclosing), next: at + raw.length };
}

/**
 * The frame of a quote's or list item's content, which the lexer reads with each line's
 * marker and indentation removed: each content line is found at the end of its source line.
 */
function innerFrame(outer: Frame, inner: string): Frame {
  const origin: number[] = [];
  let lineStart = 0;
  for (const [index, line] of inner.split('\n').entries()) {
    const newline = outer.text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? outer.text.length : newline;
    const body = line.trimStart();
    const bodyStart = lineEnd - body.length;
    let placed = outer.origin.slice(bodyStart, lineEnd);
    /* v8 ignore next 3 -- defensive: each content line the lexer returns ends its source line; one that did not would stay unplaced rather than be misplaced */
    if (bodyStart < lineStart || outer.text.slice(bodyStart, lineEnd) !== body) {
      placed = Array.from({ length: body.length }, () => UNPLACED);
    }
    if (index > 0) origin.push(LEAD);
    origin.push(...Array.from({ length: line.length - body.length }, () => LEAD), ...placed);
    lineStart = lineEnd + 1;
  }
  return placedFrame(inner, origin, outer.enclosing);
}

/** Code and raw HTML keep their character references as typed in both parts. */
function keepTyped(context: Context): void {
  const { frame, textPart } = context;
  const indices = frame.origin.includes(UNPLACED) ? frame.enclosing : frame.origin;
  for (const index of indices) if (index >= 0) textPart.typed.add(index);
}

/**
 * An escape's source is its backslash and the character it escapes: the text part drops
 * the one and writes the other as typed, so `\&amp;` reads `&amp;` in both parts.
 */
function writeEscape(context: Context): void {
  const { frame, textPart } = context;
  if (frame.origin.includes(UNPLACED)) {
    keepTyped(context);
    return;
  }
  markEscape(frame.origin, textPart);
}

/** CommonMark's ASCII punctuation: the characters a backslash escapes. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const ESCAPE = /\\[!-/:-@[-`{-~]/g;
const OPTIONAL_BACKSLASH = String.raw`\\?`;

function patternFor(character: string): string {
  const literal = character.replaceAll(/[$()*+.?[\\\]^{|}/-]/g, String.raw`\$&`);
  return ESCAPABLE.test(character) ? OPTIONAL_BACKSLASH + literal : literal;
}

/**
 * Where an address marked resolved was written in `frame`. Marked drops each escaping
 * backslash, so the source may carry one before any escapable character; the last match
 * is the address, never a label that repeats it.
 */
function addressSpan(frame: Frame, href: string): { start: number; end: number } | undefined {
  if (href === '') return undefined;
  const characters = Array.from({ length: href.length }, (_, index) => href.charAt(index));
  const pattern = new RegExp(characters.map((character) => patternFor(character)).join(''), 'g');
  let span: { start: number; end: number } | undefined;
  for (const match of frame.text.matchAll(pattern)) {
    span = { start: match.index, end: match.index + match[0].length };
  }
  return span;
}

/** The text part drops an escape's backslash and writes the character it escapes as typed. */
function markEscape(origins: readonly number[], textPart: TextPartMarks): void {
  for (const [position, origin] of origins.entries()) {
    if (origin >= 0) (position === 0 ? textPart.dropped : textPart.typed).add(origin);
  }
}

/**
 * An address as CommonMark reads it: an escaped character is literal and starts no
 * reference, and references elsewhere decode. An address found in none of `sources` is
 * decoded whole, which reads it as though nothing in it were escaped.
 */
function addressOf(context: Context, href: string, sources: readonly Frame[]): string {
  for (const frame of sources) {
    const span = addressSpan(frame, href);
    if (span !== undefined) return readAddress(frame, span, context.textPart);
  }
  return decodeReferences(href);
}

function readAddress(
  frame: Frame,
  span: { start: number; end: number },
  textPart: TextPartMarks
): string {
  const written = frame.text.slice(span.start, span.end);
  let address = '';
  let from = 0;
  for (const match of written.matchAll(ESCAPE)) {
    address += decodeReferences(written.slice(from, match.index)) + match[0].slice(1);
    const at = span.start + match.index;
    markEscape(frame.origin.slice(at, at + 2), textPart);
    from = match.index + match[0].length;
  }
  return address + decodeReferences(written.slice(from));
}

/** A run's words without their formatting, as image alt text carries them. */
function plainText(runs: readonly MarkdownRun[]): string {
  return runs
    .map((run) => {
      switch (run.kind) {
        case 'text':
        case 'code': {
          return run.text;
        }
        case 'break': {
          return ' ';
        }
        case 'link':
        case 'labelLink':
        case 'strong':
        case 'em':
        case 'del': {
          return plainText(run.content);
        }
      }
    })
    .join('');
}

const MAPPING: TokenMapping = {
  blockquote: (token, context) => ({
    blocks: [
      {
        kind: 'quote',
        blocks: blocksOf(token.tokens, {
          ...context,
          frame: innerFrame(context.frame, token.text),
        }),
      },
    ],
  }),
  br: (token, context) => {
    // A backslash hard break's backslash is its marker, which the HTML part does not show.
    if (token.raw.startsWith('\\')) writeEscape(context);
    return { runs: [{ kind: 'break' }] };
  },
  checkbox: (token) => ({ runs: [text(token.checked ? '[x] ' : '[ ] ')] }),
  code: (token, context) => {
    keepTyped(context);
    return { blocks: [{ kind: 'code', text: token.text }] };
  },
  codespan: (token, context) => {
    keepTyped(context);
    return { runs: [{ kind: 'code', text: token.text }] };
  },
  def: (token, context) => {
    addressOf(context, token.href, [context.frame]);
    return { blocks: [] };
  },
  del: (token, context) => ({ runs: [{ kind: 'del', content: runsOf(token.tokens, context) }] }),
  em: (token, context) => ({ runs: [{ kind: 'em', content: runsOf(token.tokens, context) }] }),
  escape: (token, context) => {
    writeEscape(context);
    return { runs: [text(token.text)] };
  },
  heading: (token, context) => ({
    blocks: [{ kind: 'heading', content: runsOf(token.tokens, context) }],
  }),
  hr: () => ({ blocks: [{ kind: 'rule' }] }),
  // Raw HTML is shown as the text it is, in both parts: nothing an issue carries becomes markup.
  html: (token, context) => {
    keepTyped(context);
    return token.block
      ? { blocks: [{ kind: 'paragraph', content: [text(token.text.trimEnd())] }] }
      : { runs: [text(token.text)] };
  },
  // An image is never fetched when the email opens: it becomes a link to itself.
  image: (token, context) => {
    const href = addressOf(context, token.href, [context.frame, ...context.definitions]);
    const alt = plainText(runsOf(token.tokens, { ...context, inLink: true }));
    const label = alt === '' ? href : alt;
    return context.inLink
      ? { runs: [text(label)] }
      : { runs: [{ kind: 'link', href, content: [text(label)] }] };
  },
  link: (token, context) => ({
    runs: [
      {
        kind: context.inLink ? 'labelLink' : 'link',
        href: addressOf(context, token.href, [context.frame, ...context.definitions]),
        content: runsOf(token.tokens, { ...context, inLink: true }),
      },
    ],
  }),
  list: (token, context) => {
    let cursor = 0;
    const items = token.items.map((item) => {
      const placed = placeIn(context.frame, item.raw, cursor);
      cursor = placed.next;
      return blocksOf(item.tokens, { ...context, frame: innerFrame(placed.frame, item.text) });
    });
    return {
      blocks: [
        {
          kind: 'list',
          ordered: token.ordered,
          start: token.start === '' ? 1 : token.start,
          items,
        },
      ],
    };
  },
  list_item: (token, context) => ({
    blocks: blocksOf(token.tokens, { ...context, frame: innerFrame(context.frame, token.text) }),
  }),
  paragraph: (token, context) => ({
    blocks: [{ kind: 'paragraph', content: runsOf(token.tokens, context) }],
  }),
  space: () => ({ blocks: [] }),
  strong: (token, context) => ({
    runs: [{ kind: 'strong', content: runsOf(token.tokens, context) }],
  }),
  table: (token, context) => {
    let cursor = 0;
    const cell = (tableCell: Tokens.TableCell): Cell => {
      const placed = placeIn(context.frame, tableCell.text, cursor);
      cursor = placed.next;
      return runsOf(tableCell.tokens, { ...context, frame: placed.frame });
    };
    const header = token.header.map((tableCell) => cell(tableCell));
    const rows = token.rows.map((row) => row.map((tableCell) => cell(tableCell)));
    return { blocks: [{ kind: 'table', header, rows }] };
  },
  text: (token, context) => ({
    runs:
      token.tokens === undefined
        ? [text(decodeReferences(token.text))]
        : runsOf(token.tokens, context),
  }),
};

function isMarkedToken(token: Token): token is MarkedToken {
  return Object.hasOwn(MAPPING, token.type);
}

function mapKind<K extends keyof TokenByKind>(
  kind: K,
  token: TokenByKind[K],
  context: Context
): Piece {
  return MAPPING[kind](token, context);
}

/** Maps each token in reading order, handing each its own source as its frame. */
function piecesOf(tokens: readonly Token[], context: Context): Piece[] {
  let cursor = 0;
  return tokens.map((token) => {
    /* v8 ignore next 3 -- unreachable: no marked extension is registered on this instance */
    if (!isMarkedToken(token)) {
      throw new Error(`newsletter markdown: no mapping for token kind ${token.type}`);
    }
    const placed = placeIn(context.frame, token.raw, cursor);
    cursor = placed.next;
    return mapKind(token.type, token, { ...context, frame: placed.frame });
  });
}

function runsOf(tokens: readonly Token[], context: Context): MarkdownRun[] {
  return piecesOf(tokens, context).flatMap((piece) => {
    /* v8 ignore next 3 -- unreachable: marked nests no block inside inline content */
    if (!('runs' in piece)) {
      throw new Error('newsletter markdown: a block token inside inline content');
    }
    return piece.runs;
  });
}

/** Maps block tokens; runs that stand among blocks (a tight list item's text) join a paragraph. */
function blocksOf(tokens: readonly Token[], context: Context): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let pending: MarkdownRun[] = [];
  const flush = (): void => {
    if (pending.length > 0) blocks.push({ kind: 'paragraph', content: pending });
    pending = [];
  };
  for (const piece of piecesOf(tokens, context)) {
    if ('runs' in piece) {
      pending = [...pending, ...piece.runs];
    } else {
      flush();
      blocks.push(...piece.blocks);
    }
  }
  flush();
  return blocks;
}

/** An issue's markdown mapped once: the HTML part's blocks and the text part's source. */
export interface MappedMarkdown {
  readonly blocks: readonly MarkdownBlock[];
  /**
   * The source as the HTML part shows it: references decoded except inside code and raw
   * HTML, and each escape without its backslash.
   */
  readonly text: string;
}

function writeTextPart(source: string, marks: TextPartMarks): string {
  const treatment = (index: number): 'drop' | 'keep' | 'decode' => {
    if (marks.dropped.has(index)) return 'drop';
    return marks.typed.has(index) ? 'keep' : 'decode';
  };
  let written = '';
  let start = 0;
  for (let index = 1; index <= source.length; index += 1) {
    if (index === source.length || treatment(index) !== treatment(start)) {
      const segment = source.slice(start, index);
      const how = treatment(start);
      if (how === 'keep') written += segment;
      if (how === 'decode') written += decodeReferences(segment);
      start = index;
    }
  }
  return written;
}

export function mapMarkdown(source: string): MappedMarkdown {
  const tokens = MARKDOWN.lexer(source);
  // The lexer's top-level sources join to the source it read, line endings normalised.
  const lexed = tokens.map((token) => token.raw).join('');
  const origin = Array.from({ length: lexed.length }, (_, index) => index);
  const textPart: TextPartMarks = { typed: new Set(), dropped: new Set() };
  let offset = 0;
  const definitions: Frame[] = [];
  for (const token of tokens) {
    const tokenOrigin = origin.slice(offset, offset + token.raw.length);
    if (token.type === 'def') definitions.push(placedFrame(token.raw, tokenOrigin, tokenOrigin));
    offset += token.raw.length;
  }
  const blocks = blocksOf(tokens, {
    inLink: false,
    frame: placedFrame(lexed, origin, origin),
    textPart,
    definitions,
  });
  return { blocks, text: writeTextPart(lexed, textPart) };
}

export function markdownBlocks(source: string): readonly MarkdownBlock[] {
  return mapMarkdown(source).blocks;
}

function runTargets(runs: readonly MarkdownRun[]): string[] {
  return runs.flatMap((run) => {
    switch (run.kind) {
      case 'link':
      case 'labelLink': {
        return [run.href, ...runTargets(run.content)];
      }
      case 'strong':
      case 'em':
      case 'del': {
        return runTargets(run.content);
      }
      case 'text':
      case 'code':
      case 'break': {
        return [];
      }
    }
  });
}

function linkTargets(blocks: readonly MarkdownBlock[]): string[] {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph': {
        return runTargets(block.content);
      }
      case 'quote': {
        return linkTargets(block.blocks);
      }
      case 'list': {
        return block.items.flatMap((item) => linkTargets(item));
      }
      case 'table': {
        return [...block.header, ...block.rows.flat()].flatMap((cell) => runTargets(cell));
      }
      case 'code':
      case 'rule': {
        return [];
      }
    }
  });
}

/** A user name before the host is a phishing shape: the reader sees a host it is not. */
function carriesUserinfo(href: string): boolean {
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  return url.username !== '' || url.password !== '';
}

/**
 * An issue's markdown as admin input: refused when any link or image it would write is a
 * target the email writer refuses, or carries a user name, so a bad issue is refused where
 * it is written and never reaches the writer's throw.
 */
export const newsletterMarkdownSchema = z.string().superRefine((source, context) => {
  const refused = linkTargets(markdownBlocks(source)).some(
    (href) => !isAllowedEmailHref(href) || carriesUserinfo(href)
  );
  if (refused) {
    context.addIssue({
      code: 'custom',
      message: 'Every link must be https:, http: or mailto: with a bare address, with no user name',
    });
  }
});
