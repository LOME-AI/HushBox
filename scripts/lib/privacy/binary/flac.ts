import { id3TagLength, parseId3 } from './id3.js';
import {
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  boundedText,
  extractPrintableText,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion, ScanRange } from './region.js';

const SIGNATURE = 'fLaC';
const SIGNATURE_BYTES = 4;
const BLOCK_HEADER_BYTES = 4;
const LAST_BLOCK_FLAG = 0x80;
const BLOCK_TYPE_PADDING = 1;
const BLOCK_TYPE_APPLICATION = 2;
const BLOCK_TYPE_SEEKTABLE = 3;
const BLOCK_TYPE_VORBIS_COMMENT = 4;
const BLOCK_TYPE_CUESHEET = 5;
const BLOCK_TYPE_PICTURE = 6;
const APPLICATION_ID_BYTES = 4;

const STREAMINFO_TYPE = 0;
const STREAMINFO_BYTES = 34;

/**
 * The four signature bytes are four printable characters, which a text file
 * could open with; the specification also mandates that STREAMINFO be the first
 * metadata block and be exactly 34 bytes, so that is checked too. A claim of
 * format suppresses the text gate, so a weak claim is a file nothing examines.
 */
function signatureOffset(bytes: Uint8Array): number {
  const offset = id3TagLength(bytes);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('latin1', offset, offset + SIGNATURE_BYTES) !== SIGNATURE) return -1;
  const header = offset + SIGNATURE_BYTES;
  if (header + BLOCK_HEADER_BYTES > bytes.length) return -1;
  if ((view.readUInt8(header) & 0x7f) !== STREAMINFO_TYPE) return -1;
  return view.readUIntBE(header + 1, 3) === STREAMINFO_BYTES ? offset : -1;
}

/**
 * A FLAC stream, with or without an ID3v2 prefix. The prefix is why dispatch
 * cannot key on the leading magic alone: a tagged FLAC and a tagged MP3 open
 * with the same four bytes.
 */
export function matchesFlac(bytes: Uint8Array): boolean {
  return signatureOffset(bytes) !== -1;
}

/**
 * The Vorbis comment payload: a length-prefixed vendor string followed by
 * length-prefixed `key=value` entries, all little-endian.
 */
function decodeVorbisComment(bytes: Uint8Array, start: number, end: number): string {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  let offset = start;
  const readString = (): string | undefined => {
    if (offset + 4 > end) return undefined;
    const length = view.readUInt32LE(offset);
    if (offset + 4 + length > end) return undefined;
    const value = view.toString('utf8', offset + 4, offset + 4 + length);
    offset += 4 + length;
    return value;
  };
  const vendor = readString();
  if (vendor === undefined) return '';
  parts.push(vendor);
  if (offset + 4 > end) return parts.join('\n');
  const count = view.readUInt32LE(offset);
  offset += 4;
  for (let index = 0; index < count; index++) {
    const comment = readString();
    if (comment === undefined) break;
    parts.push(comment);
  }
  return boundedText(parts.join('\n'));
}

const BLOCK_TEXT: Record<number, { readonly name: string; readonly bodyOffset: number }> = {
  [BLOCK_TYPE_VORBIS_COMMENT]: { name: 'VORBIS_COMMENT', bodyOffset: 0 },
  [BLOCK_TYPE_APPLICATION]: { name: 'APPLICATION', bodyOffset: APPLICATION_ID_BYTES },
};

/**
 * The block types the specification defines and no decoder requires: a seek
 * table costs seek accuracy, a cuesheet costs track indexing, a picture costs
 * cover art, and padding is filler by definition.
 *
 * Naming them is not the carrier list the unnamed bucket exists to avoid. That
 * objection is that the next type nobody thought of blinds the list, and this
 * type space is closed by the specification — 0 stream info through 6 picture,
 * 7-126 reserved, 127 forbidden — so it cannot gain one without a new revision
 * of the format. Stream info is the one block the specification requires, and it
 * stays unnamed with the reserved range, which is what the remedy's refusal
 * narrows to.
 */
const BLOCK_INERT: Record<number, string> = {
  [BLOCK_TYPE_PADDING]: 'PADDING',
  [BLOCK_TYPE_SEEKTABLE]: 'SEEKTABLE',
  [BLOCK_TYPE_CUESHEET]: 'CUESHEET',
  [BLOCK_TYPE_PICTURE]: 'PICTURE',
};

interface Block {
  readonly type: number;
  readonly offset: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

function blockRegion(bytes: Uint8Array, block: Block): MetadataRegion | undefined {
  const described = BLOCK_TEXT[block.type];
  if (described === undefined) {
    // Read either way, and reported only where a value rule finds something: an
    // inert block is named so a remedy may neutralise it, not because its
    // presence discloses anything the way a comment block's does.
    const inert = BLOCK_INERT[block.type];
    return unnamedRegion(
      bytes,
      inert === undefined
        ? { kind: 'flac:unnamed', location: 'block' }
        : { kind: `flac:${inert}`, location: inert },
      { offset: block.offset, length: block.bodyEnd - block.offset },
      { start: block.bodyStart, end: block.bodyEnd }
    );
  }
  return {
    kind: `flac:${described.name}`,
    location: described.name,
    offset: block.offset,
    length: block.bodyEnd - block.offset,
    text:
      block.type === BLOCK_TYPE_VORBIS_COMMENT
        ? decodeVorbisComment(bytes, block.bodyStart, block.bodyEnd)
        : extractPrintableText(bytes, block.bodyStart + described.bodyOffset, block.bodyEnd),
    instants: [],
    carriesIdentity: true,
  };
}

/**
 * A FLAC frame sync is fourteen set bits. Checked rather than assumed so a
 * residue appended after the metadata cannot pass as the start of the audio.
 */
function opensAudioFrame(view: Buffer, offset: number): boolean {
  if (offset + 2 > view.length) return offset === view.length;
  return view.readUInt8(offset) === 0xff && (view.readUInt8(offset + 1) & 0xfc) === 0xf8;
}

interface BlockWalk {
  readonly blocks: readonly Block[];
  /** True when the block framing stopped parsing before the stream's end. */
  readonly damaged: boolean;
  /** Where the walk stopped: the first byte the metadata does not cover. */
  readonly offset: number;
}

/**
 * The metadata blocks of a FLAC stream, ending where the coded audio begins.
 *
 * A pure walk rather than one that fills a collector: the offset it ends at is
 * what any remedy needs to know before it touches a block, and a walk that
 * takes the detector's budget cannot be asked that question.
 */
function walkBlockExtents(bytes: Uint8Array, view: Buffer, start: number): BlockWalk {
  const blocks: Block[] = [];
  let offset = start;
  for (;;) {
    const stops =
      offset + BLOCK_HEADER_BYTES > bytes.length ||
      offset + BLOCK_HEADER_BYTES + view.readUIntBE(offset + 1, 3) > bytes.length;
    if (stops) return { blocks, damaged: true, offset };
    const header = view.readUInt8(offset);
    const bodyStart = offset + BLOCK_HEADER_BYTES;
    const bodyEnd = bodyStart + view.readUIntBE(offset + 1, 3);
    blocks.push({ type: header & 0x7f, offset, bodyStart, bodyEnd });
    offset = bodyEnd;
    if ((header & LAST_BLOCK_FLAG) !== 0) return { blocks, damaged: false, offset };
  }
}

/**
 * Where a FLAC stream's coded audio begins, or `undefined` when the blob is not
 * a FLAC stream or its metadata framing is damaged. An ID3 prefix and the
 * metadata blocks both sit in front of that offset.
 */
export function flacAudioStart(bytes: Uint8Array): number | undefined {
  const start = signatureOffset(bytes);
  if (start === -1) return undefined;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = walkBlockExtents(bytes, view, start + SIGNATURE_BYTES);
  return walk.damaged ? undefined : walk.offset;
}

/**
 * The coded audio, which no block walk reaches. An encoder writes its version
 * string into the unused ancillary bits of the frames it emits, so the payload
 * of a lossless stream carries toolchain identity as surely as its tags do.
 */
export function flacScanRanges(bytes: Uint8Array): ScanRange[] {
  const start = flacAudioStart(bytes);
  if (start === undefined || start >= bytes.length) return [];
  return [{ location: 'audio', start, end: bytes.length }];
}

/** Metadata blocks of a FLAC stream, plus any ID3 tag sitting in front of it. */
export function parseFlac(bytes: Uint8Array): MetadataRegion[] {
  const start = signatureOffset(bytes);
  if (start === -1) return [];
  const collector = new RegionCollector();
  collector.pushAll(parseId3(bytes));
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = walkBlockExtents(bytes, view, start + SIGNATURE_BYTES);
  for (const block of walk.blocks) {
    if (collector.exhausted) break;
    const region = blockRegion(bytes, block);
    if (region !== undefined) collector.push(region);
  }
  if (walk.damaged) {
    collector.push(structuralRefusal('flac:blocks', walk.offset, bytes.length - walk.offset));
    return collector.collect(bytes.length);
  }
  // Coded audio follows the last metadata block immediately, so the first byte
  // after it must open a frame. Anything else is content the metadata framing
  // never accounted for.
  if (!collector.exhausted && !opensAudioFrame(view, walk.offset)) {
    collector.push(
      structuralRefusal(
        'flac:trailing',
        walk.offset,
        bytes.length - walk.offset,
        TRAILING_BYTES_SHAPE
      )
    );
  }
  return collector.collect(bytes.length);
}
