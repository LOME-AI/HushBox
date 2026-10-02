import { parseId3 } from './id3.js';
import {
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  extractPrintableText,
  printableStructuralName,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion } from './region.js';

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const LIST_TYPE_BYTES = 4;

/** Chunks that carry authoring metadata rather than format or sample data. */
const REPORTED_CHUNKS = new Set(['bext', '_PMX', 'iXML', 'axml']);
const TAG_CHUNKS = new Set(['id3 ', 'ID3 ']);
/**
 * The chunks that are the recording rather than anything written about it. Every
 * other chunk is read for values, so a carrier nobody enumerated cannot pass
 * unexamined — a longer list of ids would only cover the ones somebody thought of.
 */
const PAYLOAD_CHUNKS = new Set(['data', 'fmt ', 'VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM']);

/** The RIFF forms this gate knows. A form it cannot name is not a claim it should make. */
const RIFF_FORMS = new Set(['WAVE', 'WEBP', 'AVI ']);

/**
 * `RIFF` is four printable characters a sentence could open with, so the form
 * type behind it is checked too — a claim of format suppresses the text gate,
 * and a weak claim is a file nothing examines. The declared size is deliberately
 * not required to match the blob, so a truncated container is still claimed and
 * therefore still reported as a refusal.
 */
export function matchesRiff(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('latin1', 0, 4) !== 'RIFF') return false;
  return RIFF_FORMS.has(view.toString('latin1', 8, HEADER_BYTES));
}

/**
 * RIFF chunk walk. Chunks are word-aligned, so an odd length is followed by one
 * pad byte that is not counted in the declared size.
 */
interface ChunkSpan {
  readonly offset: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

function reportedRegion(
  bytes: Uint8Array,
  view: Buffer,
  id: string,
  span: ChunkSpan
): MetadataRegion | undefined {
  const shared = { offset: span.offset, length: span.bodyEnd - span.offset, instants: [] } as const;
  if (REPORTED_CHUNKS.has(id)) {
    return {
      ...shared,
      kind: `riff:${id}`,
      location: id,
      text: extractPrintableText(bytes, span.bodyStart, span.bodyEnd),
      carriesIdentity: true,
    };
  }
  const listType =
    id === 'LIST' ? view.toString('latin1', span.bodyStart, span.bodyStart + LIST_TYPE_BYTES) : '';
  if (listType !== 'INFO') {
    // `movi` is the AVI frame stream, which a LIST wraps rather than describes.
    if (PAYLOAD_CHUNKS.has(id) || listType === 'movi') return undefined;
    return unnamedRegion(
      bytes,
      { kind: 'riff:unnamed', location: id },
      { offset: shared.offset, length: shared.length },
      { start: span.bodyStart, end: span.bodyEnd }
    );
  }
  return {
    ...shared,
    kind: 'riff:LIST/INFO',
    location: 'LIST/INFO',
    text: extractPrintableText(bytes, span.bodyStart + LIST_TYPE_BYTES, span.bodyEnd),
    carriesIdentity: true,
  };
}

function chunkRegions(
  bytes: Uint8Array,
  view: Buffer,
  id: string,
  span: ChunkSpan
): readonly MetadataRegion[] {
  if (TAG_CHUNKS.has(id)) {
    return parseId3(bytes.subarray(span.bodyStart, span.bodyEnd)).map((region) => ({
      ...region,
      offset: region.offset + span.bodyStart,
    }));
  }
  const region = reportedRegion(bytes, view, id, span);
  return region === undefined ? [] : [region];
}

export function parseRiff(bytes: Uint8Array): MetadataRegion[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const collector = new RegionCollector();
  let offset = HEADER_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= bytes.length && !collector.exhausted) {
    const id = view.toString('latin1', offset, offset + 4);
    const length = view.readUInt32LE(offset + 4);
    const bodyStart = offset + CHUNK_HEADER_BYTES;
    const bodyEnd = bodyStart + length;
    // A chunk id is four characters by specification. Checking it is what stops
    // a run of NUL padding parsing as a chain of zero-length chunks, which would
    // absorb an appended residue instead of reporting it.
    if (printableStructuralName(id) === undefined || bodyEnd > bytes.length) {
      collector.push(structuralRefusal('riff:chunks', offset, bytes.length - offset));
      return collector.collect(bytes.length);
    }
    collector.pushAll(chunkRegions(bytes, view, id, { offset, bodyStart, bodyEnd }));
    offset = bodyEnd + (length % 2);
  }
  if (offset < bytes.length) {
    collector.push(
      structuralRefusal('riff:trailing', offset, bytes.length - offset, TRAILING_BYTES_SHAPE)
    );
  }
  return collector.collect(bytes.length);
}
