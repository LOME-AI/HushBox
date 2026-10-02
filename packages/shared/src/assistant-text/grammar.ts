import { SEGMENT_KINDS, SEGMENT_SPECS } from './segments.ts';
import type { ContainerKind, Segment, SegmentByKind, SegmentKind } from './segments.ts';

/**
 * The one module holding every delimiter of an assistant message's raw text.
 *
 *   message := BARE_TEXT | MAGIC frame*
 *   MAGIC   := RS "hb1" US
 *   frame   := RS code length US body     length = decimal UTF-16 units of body
 *
 * A text body is raw model text and is never scanned; a container's body is its
 * child frames; a search row's body is its JSON. Parsing reads headers and
 * slices bodies by length, so model text cannot forge a frame whatever it
 * contains. Stored text is AEAD-authenticated, so only client-supplied history
 * can be malformed, and malformed input reads as one bare text segment.
 *
 * The natively emitted think tags live here too: the stream reducer recognises
 * them only through this module's functions.
 */

const RS = '\u001E';
const US = '\u001F';
const MAGIC = `${RS}hb1${US}`;
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Joins text across step boundaries and in the answer projections. */
export const SEGMENT_TEXT_SEPARATOR = '\n\n';

/** A length of this many digits covers any body under ten million UTF-16 units. */
const LENGTH_MAX_DIGITS = 7;

/** Characters the message marker adds to a framed message. */
export const MESSAGE_MARKER_CHARS = MAGIC.length;

/** The most characters one frame header adds: RS, code, the length digits, US. */
export const FRAME_HEADER_MAX_CHARS = 1 + 1 + LENGTH_MAX_DIGITS + 1;

/**
 * The storage allowance for HushBox-authored framing in one message: the
 * marker, every frame header and every step separator. The reducer's frame and
 * separator limits, `ASSISTANT_FRAME_LIMIT` and `ASSISTANT_SEPARATOR_LIMIT` in
 * `packages/shared/src/assistant-text/reducer.ts`, are derived from it so the
 * reducer can never exceed it.
 */
export const ASSISTANT_FRAMING_MAX_CHARS = 640;

const KIND_BY_CODE: ReadonlyMap<string, SegmentKind> = new Map(
  SEGMENT_KINDS.map((kind) => [SEGMENT_SPECS[kind].code, kind])
);

/**
 * Encoded frames by segment object. Segments are immutable and the reducer
 * replaces only what changed, so re-serializing a growing tree re-encodes only
 * the open path.
 */
const FRAME_CACHE = new WeakMap<Segment, string>();

function encodeBody<K extends SegmentKind>(kind: K, node: SegmentByKind[K]): string {
  return SEGMENT_SPECS[kind].encodeBody(node, encodeFrames);
}

function encodeFrame(node: Segment, parent: ContainerKind): string {
  if (!SEGMENT_SPECS[node.kind].parents.includes(parent)) {
    throw new RangeError(`a ${node.kind} segment cannot sit in ${parent}`);
  }
  const cached = FRAME_CACHE.get(node);
  if (cached !== undefined) return cached;
  const body = encodeBody(node.kind, node);
  const frame = `${RS}${SEGMENT_SPECS[node.kind].code}${String(body.length)}${US}${body}`;
  FRAME_CACHE.set(node, frame);
  return frame;
}

function encodeFrames(children: readonly Segment[], parent: ContainerKind): string {
  return children.map((child) => encodeFrame(child, parent)).join('');
}

/**
 * The canonical text of a segment tree. A tree that is one non-empty answer
 * text is that text, bare, byte-identical to what the model returned, unless
 * it begins with RS; every other tree is framed.
 */
export function serializeSegments(segments: readonly Segment[]): string {
  const [only] = segments;
  if (
    segments.length === 1 &&
    only?.kind === 'text' &&
    only.text !== '' &&
    !only.text.startsWith(RS)
  ) {
    return only.text;
  }
  if (segments.length === 0) return '';
  return `${MAGIC}${encodeFrames(segments, 'root')}`;
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function decodeFrame<K extends SegmentKind>(kind: K, body: string): SegmentByKind[K] | undefined {
  return SEGMENT_SPECS[kind].decodeBody(body, readFrames);
}

interface FrameHeader {
  readonly code: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** The header of the frame at `position`, or `undefined` when it is malformed. */
function readHeader(text: string, position: number): FrameHeader | undefined {
  if (text[position] !== RS || position + 1 >= text.length) return undefined;
  const digitsStart = position + 2;
  let cursor = digitsStart;
  while (isDigit(text[cursor]) && cursor - digitsStart < LENGTH_MAX_DIGITS) cursor += 1;
  const digits = text.slice(digitsStart, cursor);
  if (digits === '' || text[cursor] !== US) return undefined;
  if (digits.length > 1 && digits.startsWith('0')) return undefined;
  const bodyStart = cursor + 1;
  const bodyEnd = bodyStart + Number(digits);
  if (bodyEnd > text.length) return undefined;
  return { code: text.charAt(position + 1), bodyStart, bodyEnd };
}

/** The frames of one container, or `undefined` when any of them is malformed. */
function readFrames(text: string, parent: ContainerKind): readonly Segment[] | undefined {
  const segments: Segment[] = [];
  let position = 0;
  while (position < text.length) {
    const header = readHeader(text, position);
    if (header === undefined) return undefined;
    position = header.bodyEnd;
    const kind = KIND_BY_CODE.get(header.code);
    // An unknown code with a valid length is a newer kind this reader predates.
    if (kind === undefined) continue;
    if (!SEGMENT_SPECS[kind].parents.includes(parent)) return undefined;
    const segment = decodeFrame(kind, text.slice(header.bodyStart, header.bodyEnd));
    if (segment === undefined) return undefined;
    segments.push(segment);
  }
  return segments;
}

/**
 * The text with any frame marker at its start removed, so it can never be read
 * as a framed message again. History text passes through this, which is what
 * makes cleaning a turn twice give exactly what cleaning it once gives.
 */
export function withoutLeadingMarker(text: string): string {
  let rest = text;
  while (rest.startsWith(MAGIC)) rest = rest.slice(MAGIC.length);
  return rest;
}

/** The segment tree a message's raw text encodes. Never throws. */
export function parseAssistantMessage(content: string): readonly Segment[] {
  if (!content.startsWith(MAGIC)) return content === '' ? [] : [{ kind: 'text', text: content }];
  return readFrames(content.slice(MAGIC.length), 'root') ?? [{ kind: 'text', text: content }];
}

/**
 * What the first answer text has held back so far: its leading whitespace, and
 * the non-whitespace start of it, which is always a proper prefix of the open
 * tag and so never longer than the tag.
 */
export interface HeldThinkOpen {
  readonly whitespace: string;
  readonly tag: string;
}

export type LeadingThinkOpen =
  | { readonly state: 'undecided'; readonly held: HeldThinkOpen }
  | { readonly state: 'absent'; readonly text: string }
  | { readonly state: 'open'; readonly rest: string };

/**
 * Reads the start of a message's first answer text for a natively emitted open
 * tag, one delta at a time. Leading whitespace is accepted and never changes
 * the decision, so it is carried rather than rescanned: each call costs the
 * delta's length plus the tag's, never the length of everything held. While
 * the text is whitespace plus a proper prefix of the tag, a later delta decides.
 */
export function leadingThinkOpen(held: HeldThinkOpen, content: string): LeadingThinkOpen {
  let whitespace = held.whitespace;
  let candidate = `${held.tag}${content}`;
  if (held.tag === '') {
    const rest = content.trimStart();
    whitespace = `${whitespace}${content.slice(0, content.length - rest.length)}`;
    candidate = rest;
  }
  if (candidate.startsWith(THINK_OPEN)) {
    return { state: 'open', rest: candidate.slice(THINK_OPEN.length) };
  }
  if (THINK_OPEN.startsWith(candidate)) {
    return { state: 'undecided', held: { whitespace, tag: candidate } };
  }
  return { state: 'absent', text: `${whitespace}${candidate}` };
}

export type ThinkCloseSplit =
  | { readonly state: 'closed'; readonly reasoning: string; readonly rest: string }
  | { readonly state: 'open'; readonly reasoning: string; readonly held: string };

/**
 * Splits native reasoning at the first close tag. With no close tag yet, a
 * trailing proper prefix of the tag is held back, so a tag split across deltas
 * reads exactly as if it had arrived whole.
 */
export function splitAtThinkClose(text: string): ThinkCloseSplit {
  const index = text.indexOf(THINK_CLOSE);
  if (index !== -1) {
    return {
      state: 'closed',
      reasoning: text.slice(0, index),
      rest: text.slice(index + THINK_CLOSE.length),
    };
  }
  for (let length = Math.min(THINK_CLOSE.length - 1, text.length); length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (THINK_CLOSE.startsWith(suffix)) {
      return { state: 'open', reasoning: text.slice(0, text.length - length), held: suffix };
    }
  }
  return { state: 'open', reasoning: text, held: '' };
}

export type AfterThinkClose =
  | { readonly state: 'undecided' }
  | { readonly state: 'decided'; readonly answer: string };

/** Drops the one separator directly after a close tag, holding a lone newline until decided. */
export function afterThinkClose(text: string): AfterThinkClose {
  if (text.startsWith(SEGMENT_TEXT_SEPARATOR)) {
    return { state: 'decided', answer: text.slice(SEGMENT_TEXT_SEPARATOR.length) };
  }
  if (SEGMENT_TEXT_SEPARATOR.startsWith(text)) return { state: 'undecided' };
  return { state: 'decided', answer: text };
}
