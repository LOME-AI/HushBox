import {
  OVER_CAP_SHAPE,
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  boundedText,
  extractPrintableText,
  inflateBounded,
  printableStructuralName,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion, RegionInstant } from './region.js';

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHUNK_HEADER_BYTES = 8;
const CHUNK_CRC_BYTES = 4;
const TIME_CHUNK_BYTES = 7;

/**
 * The ancillary chunks that carry authoring metadata. Everything else in a PNG
 * describes the image itself, so a file whose only chunks are image chunks has
 * no metadata region at all — which is what 108 of this repo's PNGs look like.
 */
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);
const OPAQUE_CHUNKS = new Set(['eXIf', 'caBX']);
/**
 * The chunks that are the image rather than anything written about it. Every
 * other chunk — private, unregistered, or simply one this gate has no rule for —
 * is read for values instead of skipped, so a carrier nobody enumerated cannot
 * pass unexamined.
 */
const IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

/**
 * Bit 5 of a chunk type's first byte — the format's own ancillary bit, which is
 * why the registered type names are cased the way they are. Clear means
 * critical.
 */
const ANCILLARY_BIT = 0x20;

export function matchesPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  );
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('latin1');
}

/**
 * `undefined` means the payload would not inflate, or would not inflate inside
 * the cap. The chunk is reported either way — a text chunk is a carrier — so
 * refusing the bytes costs no detection.
 */
function inflateOrUndefined(bytes: Uint8Array, start: number, end: number): string | undefined {
  return inflateBounded(bytes.subarray(start, end))?.toString('utf8');
}

/** iTXt payload: compression flag and method, then null-terminated language and translated keyword. */
function decodeInternationalText(
  bytes: Uint8Array,
  payloadStart: number,
  end: number
): string | undefined {
  const compressed = bytes[payloadStart] === 1;
  const afterFlags = payloadStart + 2;
  const languageEnd = bytes.subarray(afterFlags, end).indexOf(0);
  if (languageEnd === -1) return '';
  const translatedStart = afterFlags + languageEnd + 1;
  const translatedEnd = bytes.subarray(translatedStart, end).indexOf(0);
  if (translatedEnd === -1) return '';
  const textStart = translatedStart + translatedEnd + 1;
  return compressed
    ? inflateOrUndefined(bytes, textStart, end)
    : Buffer.from(bytes.subarray(textStart, end)).toString('utf8');
}

function decodePayload(
  type: string,
  bytes: Uint8Array,
  payloadStart: number,
  end: number
): string | undefined {
  if (type === 'tEXt') return latin1(bytes, payloadStart, end);
  if (type === 'zTXt') return inflateOrUndefined(bytes, payloadStart + 1, end);
  return decodeInternationalText(bytes, payloadStart, end);
}

interface DecodedText {
  readonly text: string;
  readonly refused: boolean;
}

function decodeTextChunk(type: string, bytes: Uint8Array, start: number, end: number): DecodedText {
  const separator = bytes.subarray(start, end).indexOf(0);
  if (separator === -1) return { text: boundedText(latin1(bytes, start, end)), refused: false };
  const keyword = latin1(bytes, start, start + separator);
  const payload = decodePayload(type, bytes, start + separator + 1, end);
  return {
    text: boundedText(`${keyword}\n${payload ?? ''}`.trimEnd()),
    refused: payload === undefined,
  };
}

function decodeTimeChunk(bytes: Uint8Array, start: number, end: number): RegionInstant[] {
  if (end - start < TIME_CHUNK_BYTES) return [];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seconds =
    Date.UTC(
      view.readUInt16BE(start),
      view.readUInt8(start + 2) - 1,
      view.readUInt8(start + 3),
      view.readUInt8(start + 4),
      view.readUInt8(start + 5),
      view.readUInt8(start + 6)
    ) / 1000;
  return [{ field: 'lastModified', secondsUtc: seconds }];
}

interface PngChunkExtent {
  /** The four-character chunk type, as written. */
  readonly type: string;
  /**
   * Whether the format itself says a decoder may not skip this chunk.
   *
   * The image-chunk list is an enumerated list of names; this is the
   * structural answer to the same question, and it is read here because this
   * walk is what owns where the type's first byte sits. A decoder meeting a
   * critical chunk it does not recognise is required to reject the datastream
   * rather than proceed, so such a chunk is a structure a reader needs — and a
   * remedy that cannot say what it is for cannot price removing it.
   */
  readonly critical: boolean;
  /** Byte offset of the whole chunk, length field included. */
  readonly offset: number;
  /** Length of the whole chunk: header, payload and CRC. */
  readonly length: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

/**
 * One walk of a PNG's chunk stream, shared by the detector's region collection
 * and by any remedy that has to address the same chunks. Two walks of one
 * format would be a sync contract between two views of the same bytes.
 */
interface PngChunkWalk {
  readonly chunks: readonly PngChunkExtent[];
  /** True when the framing stopped parsing before the blob's end. */
  readonly damaged: boolean;
  /**
   * Bytes past the last accounted chunk — a residue when `damaged` is false,
   * the unreadable remainder when it is true. The walk stopped at
   * `bytes.length - unaccounted` either way.
   */
  readonly unaccounted: number;
}

/**
 * The chunk stream of a PNG, with what the walk could not account for.
 *
 * A PNG's chunk stream spans the whole file, so anything left over is content
 * the framing never declared — a residue, or a second image appended to a clean
 * one, which is examined by nobody if the walk simply stops.
 */
export function pngChunkExtents(bytes: Uint8Array): PngChunkWalk {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunkExtent[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + CHUNK_HEADER_BYTES <= bytes.length) {
    const dataLength = view.readUInt32BE(offset);
    const type = latin1(bytes, offset + 4, offset + CHUNK_HEADER_BYTES);
    const dataStart = offset + CHUNK_HEADER_BYTES;
    const dataEnd = dataStart + dataLength;
    if (dataEnd + CHUNK_CRC_BYTES > bytes.length) {
      return { chunks, damaged: true, unaccounted: bytes.length - offset };
    }
    const length = CHUNK_HEADER_BYTES + dataLength + CHUNK_CRC_BYTES;
    const critical = (view.readUInt8(offset + 4) & ANCILLARY_BIT) === 0;
    chunks.push({ type, critical, offset, length, dataStart, dataEnd });
    offset += length;
    if (type === 'IEND') break;
  }
  return { chunks, damaged: false, unaccounted: bytes.length - offset };
}

function chunkRegion(bytes: Uint8Array, chunk: PngChunkExtent): MetadataRegion | undefined {
  const shared = {
    kind: `png:${chunk.type}`,
    location: chunk.type,
    offset: chunk.offset,
    length: chunk.length,
  } as const;
  if (TEXT_CHUNKS.has(chunk.type)) {
    const decoded = decodeTextChunk(chunk.type, bytes, chunk.dataStart, chunk.dataEnd);
    return {
      ...shared,
      text: decoded.text,
      instants: [],
      carriesIdentity: true,
      ...(decoded.refused ? { malformed: OVER_CAP_SHAPE } : {}),
    };
  }
  if (OPAQUE_CHUNKS.has(chunk.type)) {
    return {
      ...shared,
      text: extractPrintableText(bytes, chunk.dataStart, chunk.dataEnd),
      instants: [],
      carriesIdentity: true,
    };
  }
  if (chunk.type === 'tIME') {
    const instants = decodeTimeChunk(bytes, chunk.dataStart, chunk.dataEnd);
    return instants.length === 0
      ? undefined
      : { ...shared, text: '', instants, carriesIdentity: false };
  }
  if (IMAGE_CHUNKS.has(chunk.type)) return undefined;
  // A chunk type is four bytes the file chose and `location` is printed, so an
  // unregistered type is named only when it is printable.
  const location = printableStructuralName(chunk.type) ?? 'chunk';
  return unnamedRegion(
    bytes,
    { kind: chunk.critical ? 'png:unnamed-critical' : 'png:unnamed', location },
    { offset: chunk.offset, length: chunk.length },
    { start: chunk.dataStart, end: chunk.dataEnd }
  );
}

/** Metadata chunks of a PNG: the text chunks, the opaque carriers, the time stamp. */
export function parsePng(bytes: Uint8Array): MetadataRegion[] {
  const walk = pngChunkExtents(bytes);
  const collector = new RegionCollector();
  for (const chunk of walk.chunks) {
    if (collector.exhausted) break;
    const region = chunkRegion(bytes, chunk);
    if (region !== undefined) collector.push(region);
  }
  const stoppedAt = bytes.length - walk.unaccounted;
  if (walk.damaged) {
    collector.push(structuralRefusal('png:chunks', stoppedAt, walk.unaccounted));
  } else if (walk.unaccounted !== 0) {
    collector.push(
      structuralRefusal('png:trailing', stoppedAt, walk.unaccounted, TRAILING_BYTES_SHAPE)
    );
  }
  return collector.collect(bytes.length);
}
