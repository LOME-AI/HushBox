import {
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  extractPrintableText,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion } from './region.js';

const SIGNATURE_BYTES = 6;
const SCREEN_DESCRIPTOR_BYTES = 7;
const GLOBAL_TABLE_FLAG = 0x80;
const EXTENSION_INTRODUCER = 0x21;
const IMAGE_SEPARATOR = 0x2c;
const TRAILER = 0x3b;
const IMAGE_DESCRIPTOR_BYTES = 9;
const LOCAL_TABLE_FLAG = 0x80;
const APPLICATION_LABEL = 0xff;
const COMMENT_LABEL = 0xfe;
const PLAIN_TEXT_LABEL = 0x01;
const PLAIN_TEXT_HEADER_BYTES = 13;

const REPORTED_EXTENSIONS = new Map<number, { readonly name: string; readonly identity: boolean }>([
  [COMMENT_LABEL, { name: 'comment', identity: true }],
  [PLAIN_TEXT_LABEL, { name: 'plain-text', identity: true }],
  [APPLICATION_LABEL, { name: 'application', identity: false }],
]);

export function matchesGif(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE_BYTES) return false;
  const signature = Buffer.from(bytes.subarray(0, SIGNATURE_BYTES)).toString('latin1');
  return signature === 'GIF87a' || signature === 'GIF89a';
}

/** End of the sub-block chain starting at `offset`, or -1 when it runs off the end. */
function skipSubBlocks(bytes: Uint8Array, offset: number): number {
  let position = offset;
  for (;;) {
    const size = bytes[position];
    if (size === undefined) return -1;
    if (size === 0) return position + 1;
    position += 1 + size;
    if (position > bytes.length) return -1;
  }
}

function colourTableBytes(packed: number, flag: number): number {
  return (packed & flag) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1));
}

/** End of an image block, or -1 when its sub-block chain runs off the end. */
function skipImageBlock(bytes: Uint8Array, offset: number): number {
  const descriptorPacked = bytes[offset + IMAGE_DESCRIPTOR_BYTES] ?? 0;
  const dataStart =
    offset + 1 + IMAGE_DESCRIPTOR_BYTES + colourTableBytes(descriptorPacked, LOCAL_TABLE_FLAG) + 1;
  return skipSubBlocks(bytes, dataStart);
}

function extensionRegion(
  bytes: Uint8Array,
  label: number,
  offset: number,
  end: number
): MetadataRegion | undefined {
  const reported = REPORTED_EXTENSIONS.get(label);
  if (reported === undefined) {
    // An extension label this gate has no rule for still holds bytes the framing
    // declared, so it is read for values rather than stepped over.
    return unnamedRegion(
      bytes,
      { kind: 'gif:unnamed', location: 'extension' },
      { offset, length: end - offset },
      { start: offset + 2, end }
    );
  }
  return {
    kind: `gif:${reported.name}`,
    location: `extension/${reported.name}`,
    offset,
    length: end - offset,
    text: extractPrintableText(bytes, offset + 2, end),
    instants: [],
    carriesIdentity: reported.identity,
  };
}

/**
 * Walks the whole block stream rather than stopping at the first image: a
 * comment extension is legal anywhere before the trailer.
 */
interface Step {
  readonly next: number;
  readonly region: MetadataRegion | undefined;
}

/** Advance past one extension block, reporting it where it carries metadata. */
function readExtension(bytes: Uint8Array, offset: number): Step | undefined {
  const label = bytes[offset + 1];
  if (label === undefined) return undefined;
  const bodyStart = label === PLAIN_TEXT_LABEL ? offset + 2 + PLAIN_TEXT_HEADER_BYTES : offset + 2;
  const end = skipSubBlocks(bytes, bodyStart);
  if (end === -1) return undefined;
  return { next: end, region: extensionRegion(bytes, label, offset, end) };
}

function readBlock(bytes: Uint8Array, offset: number): Step | undefined {
  if (bytes[offset] === IMAGE_SEPARATOR) {
    const next = skipImageBlock(bytes, offset);
    return next === -1 ? undefined : { next, region: undefined };
  }
  // The trailer is handled by the caller, so reaching here with anything other
  // than an extension means the block stream stopped parsing.
  return bytes[offset] === EXTENSION_INTRODUCER ? readExtension(bytes, offset) : undefined;
}

export function parseGif(bytes: Uint8Array): MetadataRegion[] {
  const collector = new RegionCollector();
  const packed = bytes[SIGNATURE_BYTES + 4];
  if (packed === undefined) {
    return [structuralRefusal('gif:screen-descriptor', 0, bytes.length)];
  }
  let offset =
    SIGNATURE_BYTES + SCREEN_DESCRIPTOR_BYTES + colourTableBytes(packed, GLOBAL_TABLE_FLAG);
  while (offset < bytes.length && !collector.exhausted) {
    if (bytes[offset] === TRAILER) {
      offset += 1;
      break;
    }
    const step = readBlock(bytes, offset);
    if (step === undefined) {
      collector.push(structuralRefusal('gif:blocks', offset, bytes.length - offset));
      return collector.collect(bytes.length);
    }
    if (step.region !== undefined) collector.push(step.region);
    offset = step.next;
  }
  if (offset !== bytes.length) {
    collector.push(
      structuralRefusal('gif:trailing', offset, bytes.length - offset, TRAILING_BYTES_SHAPE)
    );
  }
  return collector.collect(bytes.length);
}
