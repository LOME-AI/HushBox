import {
  MAX_DECOMPRESSED_TABLE_BYTES,
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  MAX_DECOMPRESSED_TEXT_BYTES,
  OVER_CAP_SHAPE,
  boundedText,
  brotliBounded,
  structuralRefusal,
} from './region.js';
import type { MetadataRegion, RegionInstant } from './region.js';

const SIGNATURE = 'wOF2';
const HEADER_BYTES = 48;
/** OpenType counts font dates from 1904-01-01, like ISO-BMFF. */
const EPOCH_OFFSET_SECONDS = 2_082_844_800;
const HEAD_CREATED_OFFSET = 20;
const HEAD_MODIFIED_OFFSET = 28;
const HEAD_MIN_BYTES = 36;
const CUSTOM_TAG_FLAG = 0x3f;
const TRANSFORM_SHIFT = 6;
const UNTRANSFORMED = 0;
const GLYF_LOCA_NULL_TRANSFORM = 3;

/** WOFF2's known-table index, in the order the specification fixes. */
const KNOWN_TAGS: readonly string[] = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

/**
 * Total by construction: `slice` on an index the table does not hold yields the
 * empty tag rather than a branch, and the table covers every non-escape flag
 * value, so there is no reachable miss to test.
 */
function knownTag(index: number): string {
  return KNOWN_TAGS.slice(index, index + 1).join('');
}

/** The sfnt versions a WOFF2 may wrap: TrueType outlines, CFF outlines, a collection. */
const SFNT_FLAVORS = new Set([0x00_01_00_00, 0x4f_54_54_4f, 0x74_74_63_66]);
const FLAVOR_OFFSET = 4;
const LENGTH_OFFSET = 8;

/**
 * `wOF2` is four printable characters, so the wrapped sfnt version is checked as
 * well — a claim of format suppresses the text gate, and the flavor is a fixed
 * field the specification enumerates.
 */
export function matchesWoff2(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('latin1', 0, 4) !== SIGNATURE) return false;
  return SFNT_FLAVORS.has(view.readUInt32BE(FLAVOR_OFFSET));
}

interface Cursor {
  offset: number;
}

function readBase128(bytes: Uint8Array, cursor: Cursor): number | undefined {
  let value = 0;
  for (let read = 0; read < 5; read++) {
    const byte = bytes[cursor.offset];
    if (byte === undefined) return undefined;
    cursor.offset += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  return undefined;
}

interface TableEntry {
  readonly tag: string;
  readonly length: number;
}

function readTag(bytes: Uint8Array, cursor: Cursor, flags: number): string {
  if ((flags & CUSTOM_TAG_FLAG) !== CUSTOM_TAG_FLAG) return knownTag(flags & CUSTOM_TAG_FLAG);
  const tag = Buffer.from(bytes.subarray(cursor.offset, cursor.offset + 4)).toString('latin1');
  cursor.offset += 4;
  return tag;
}

/** `glyf` and `loca` invert the transform flag: 3 means untransformed for them alone. */
function isTransformed(tag: string, flags: number): boolean {
  const transform = (flags >> TRANSFORM_SHIFT) & 3;
  return tag === 'glyf' || tag === 'loca'
    ? transform !== GLYF_LOCA_NULL_TRANSFORM
    : transform !== UNTRANSFORMED;
}

function readEntry(bytes: Uint8Array, cursor: Cursor): TableEntry | undefined {
  const flags = bytes[cursor.offset];
  if (flags === undefined) return undefined;
  cursor.offset += 1;
  const tag = readTag(bytes, cursor, flags);
  const originalLength = readBase128(bytes, cursor);
  if (originalLength === undefined) return undefined;
  if (!isTransformed(tag, flags)) return { tag, length: originalLength };
  const transformLength = readBase128(bytes, cursor);
  return transformLength === undefined ? undefined : { tag, length: transformLength };
}

function readDirectory(bytes: Uint8Array, count: number, cursor: Cursor): TableEntry[] | undefined {
  const tables: TableEntry[] = [];
  for (let index = 0; index < count; index++) {
    const entry = readEntry(bytes, cursor);
    if (entry === undefined) return undefined;
    tables.push(entry);
  }
  return tables;
}

function headInstants(stream: Buffer, offset: number): RegionInstant[] {
  if (offset + HEAD_MIN_BYTES > stream.length) return [];
  const fields: readonly [string, bigint][] = [
    ['created', stream.readBigInt64BE(offset + HEAD_CREATED_OFFSET)],
    ['modified', stream.readBigInt64BE(offset + HEAD_MODIFIED_OFFSET)],
  ];
  return fields
    .filter(([, raw]) => raw !== 0n)
    .map(([field, raw]) => ({ field, secondsUtc: Number(raw) - EPOCH_OFFSET_SECONDS }));
}

/** Offset of a table inside the decompressed stream, honouring four-byte alignment. */
function headOffset(tables: readonly TableEntry[]): number | undefined {
  let position = 0;
  for (const table of tables) {
    if (table.tag === 'head') return position;
    position += table.length;
    position = (position + 3) & ~3;
  }
  return undefined;
}

function headRegion(
  bytes: Uint8Array,
  tables: readonly TableEntry[],
  streamStart: number,
  streamLength: number
): MetadataRegion | undefined {
  const offset = headOffset(tables);
  if (offset === undefined) return undefined;
  const stream = brotliBounded(
    bytes.subarray(streamStart, streamStart + streamLength),
    MAX_DECOMPRESSED_TABLE_BYTES
  );
  // A table stream the gate cannot expand is reported, never assumed clean: the
  // font dates live inside it and nothing else in the file discloses them.
  if (stream === undefined) {
    return structuralRefusal('woff2:table-stream', streamStart, streamLength, OVER_CAP_SHAPE);
  }
  const instants = headInstants(stream, offset);
  if (instants.length === 0) return undefined;
  return {
    kind: 'woff2:head',
    location: 'tables/head',
    offset: streamStart,
    length: streamLength,
    text: '',
    instants,
    carriesIdentity: false,
  };
}

function metadataRegion(bytes: Uint8Array, view: Buffer): MetadataRegion | undefined {
  const metaOffset = view.readUInt32BE(28);
  const metaLength = view.readUInt32BE(32);
  if (metaOffset === 0 || metaLength === 0 || metaOffset + metaLength > bytes.length) {
    return undefined;
  }
  const metadata = brotliBounded(
    bytes.subarray(metaOffset, metaOffset + metaLength),
    MAX_DECOMPRESSED_TEXT_BYTES
  );
  return {
    kind: 'woff2:metadata',
    location: 'metadata',
    offset: metaOffset,
    length: metaLength,
    text: metadata === undefined ? '' : boundedText(metadata.toString('utf8')),
    instants: [],
    carriesIdentity: true,
    ...(metadata === undefined ? { malformed: OVER_CAP_SHAPE } : {}),
  };
}

/**
 * The font dates in `head` and the optional extended-metadata block. Both sit
 * behind brotli, which is why a WOFF2 reads as clean to any scanner that does
 * not decompress it — and why stripping one is not byte-stable.
 */
export function parseWoff2(bytes: Uint8Array): MetadataRegion[] {
  if (bytes.length < HEADER_BYTES) return [structuralRefusal('woff2:header', 0, bytes.length)];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor: Cursor = { offset: HEADER_BYTES };
  const tables = readDirectory(bytes, view.readUInt16BE(12), cursor);
  if (tables === undefined) return [structuralRefusal('woff2:directory', 0, bytes.length)];
  const collector = new RegionCollector();
  // The header declares the whole file's length, so a blob that is longer
  // carries content the font's own framing never accounted for.
  const declaredLength = view.readUInt32BE(LENGTH_OFFSET);
  if (declaredLength !== bytes.length) {
    collector.push(structuralRefusal('woff2:trailing', 0, bytes.length, TRAILING_BYTES_SHAPE));
  }
  collector.pushAll(
    [
      headRegion(bytes, tables, cursor.offset, view.readUInt32BE(20)),
      metadataRegion(bytes, view),
    ].filter((region) => region !== undefined)
  );
  return collector.collect(bytes.length);
}
