import {
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  extractPrintableText,
  printableStructuralName,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion, RegionInstant, ScanRange } from './region.js';

const HEADER_BYTES = 8;
const EXTENDED_HEADER_BYTES = 16;
/** ISO-BMFF counts from 1904-01-01; the rest of this gate counts from 1970. */
const EPOCH_OFFSET_SECONDS = 2_082_844_800;
/** `meta` is a FullBox: four bytes of version and flags precede its children. */
const FULL_BOX_PREFIX_BYTES = 4;
/**
 * Container nesting is bounded so a file of nested boxes cannot exhaust the
 * stack. Real files nest four or five deep; anything past this is a structure
 * built to be walked, not to be played, and is reported as such.
 */
const MAX_CONTAINER_DEPTH = 32;

/**
 * `minf` and `stbl` carry nothing themselves and are walked only to reach
 * `stsd`, whose entries hold the compressor name a muxer writes its own
 * identity into.
 */
const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'stsd',
  'udta',
  'meta',
  'ilst',
]);
/** `stsd` is a FullBox whose children are preceded by an entry count. */
const ENTRY_COUNT_BYTES = 4;
const HEADER_BOXES = new Set(['mvhd', 'tkhd', 'mdhd']);
/** Boxes the bitstream sweep already declares as a scanned payload range. */
const CODED_PAYLOAD = new Set(['mdat']);

interface Box {
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * `ftyp` is four printable characters at a fixed offset, which a text file could
 * carry by coincidence, so the box size in front of it is checked as well: a
 * claim of format suppresses the text gate, and a weak claim is a file nothing
 * examines.
 */
export function matchesIsoBmff(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('latin1', 4, HEADER_BYTES) !== 'ftyp') return false;
  const declared = view.readUInt32BE(0);
  return declared >= HEADER_BYTES && declared <= bytes.length;
}

interface BoxWalk {
  readonly boxes: Box[];
  /** True when the framing stopped parsing before `end`. */
  readonly damaged: boolean;
  /** Bytes between the last complete box and `end` that no box accounts for. */
  readonly unaccounted: number;
}

interface BoxExtent {
  readonly size: number;
  readonly header: number;
}

/**
 * The extent a box header declares, or `undefined` when it declares one this
 * parser will not walk.
 *
 * Size zero means "to the end of the file", so such a box swallows everything
 * behind it. That is legitimate only for a type this parser walks into; for any
 * other type it is a lid over unexamined content — which is how an entire second
 * container came to hide behind a run of NUL bytes.
 */
function readExtent(
  view: Buffer,
  offset: number,
  end: number,
  type: string
): BoxExtent | undefined {
  const declared = view.readUInt32BE(offset);
  if (declared === 1) {
    if (offset + EXTENDED_HEADER_BYTES > end) return undefined;
    return {
      size: Number(view.readBigUInt64BE(offset + HEADER_BYTES)),
      header: EXTENDED_HEADER_BYTES,
    };
  }
  if (declared === 0) {
    if (!CONTAINERS.has(type) && type !== 'uuid') return undefined;
    return { size: end - offset, header: HEADER_BYTES };
  }
  return { size: declared, header: HEADER_BYTES };
}

/**
 * Boxes directly inside `[start, end)`, with what the walk could not account for.
 *
 * `numericTypes` is set only for an item list's children. Every other box type
 * is four characters by specification, and requiring that is what stops a run of
 * NUL padding parsing as a legal size-zero box running to end of file — but
 * under the key-table metadata scheme an item-list entry's "type" is a 32-bit
 * index into that table, so there the same rule would reject real files.
 */
function readBoxes(bytes: Uint8Array, start: number, end: number, numericTypes = false): BoxWalk {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let offset = start;
  while (offset + HEADER_BYTES <= end) {
    const type = view.toString('latin1', offset + 4, offset + HEADER_BYTES);
    if (!numericTypes && printableStructuralName(type) === undefined) {
      return { boxes, damaged: true, unaccounted: 0 };
    }
    const extent = readExtent(view, offset, end, type);
    if (extent === undefined) return { boxes, damaged: true, unaccounted: 0 };
    const { size, header } = extent;
    if (size < header || offset + size > end) return { boxes, damaged: true, unaccounted: 0 };
    boxes.push({ type, offset, size, bodyStart: offset + header, bodyEnd: offset + size });
    offset += size;
  }
  return { boxes, damaged: false, unaccounted: end - offset };
}

const NARROW_HEADER_MIN_BYTES = FULL_BOX_PREFIX_BYTES + 8;

function headerInstants(bytes: Uint8Array, box: Box): RegionInstant[] {
  if (box.bodyEnd - box.bodyStart < NARROW_HEADER_MIN_BYTES) return [];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.readUInt8(box.bodyStart);
  const base = box.bodyStart + FULL_BOX_PREFIX_BYTES;
  const wide = version === 1;
  const width = wide ? 8 : 4;
  if (base + width * 2 > box.bodyEnd) return [];
  const read = (at: number): number =>
    wide ? Number(view.readBigUInt64BE(at)) : view.readUInt32BE(at);
  const fields: readonly [string, number][] = [
    ['creationTime', read(base)],
    ['modificationTime', read(base + width)],
  ];
  return fields
    .filter(([, raw]) => raw !== 0)
    .map(([field, raw]) => ({ field, secondsUtc: raw - EPOCH_OFFSET_SECONDS }));
}

interface TextRegionShape {
  readonly location: string;
  readonly kind: string;
  /**
   * False where the box's presence discloses nothing on its own and only the
   * values inside it can. A sample description is required structure; a user
   * data box is not.
   */
  readonly carriesIdentity: boolean;
}

function textRegion(
  bytes: Uint8Array,
  box: Box,
  shape: TextRegionShape
): MetadataRegion | undefined {
  const text = extractPrintableText(bytes, box.bodyStart, box.bodyEnd);
  if (text === '') return undefined;
  return {
    kind: shape.kind,
    location: shape.location,
    offset: box.offset,
    length: box.size,
    text,
    instants: [],
    carriesIdentity: shape.carriesIdentity,
  };
}

function headerRegion(bytes: Uint8Array, box: Box, location: string): MetadataRegion | undefined {
  const instants = headerInstants(bytes, box);
  if (instants.length === 0) return undefined;
  return {
    kind: `isobmff:${box.type}`,
    location,
    offset: box.offset,
    length: box.size,
    text: '',
    instants,
    carriesIdentity: false,
  };
}

/** The leaf a box resolves to, or `undefined` where it holds nothing reportable. */
function leafRegion(
  bytes: Uint8Array,
  box: Box,
  location: string,
  path: string
): MetadataRegion | undefined {
  if (box.type === 'uuid') {
    return {
      kind: 'isobmff:uuid',
      location,
      offset: box.offset,
      length: box.size,
      text: extractPrintableText(bytes, box.bodyStart, box.bodyEnd),
      instants: [],
      carriesIdentity: true,
    };
  }
  if (HEADER_BOXES.has(box.type)) return headerRegion(bytes, box, location);
  // A sample entry describes the codec, so its existence discloses nothing —
  // but the compressor-name field inside it is free text, and the values found
  // there are the muxer's own version banner.
  if (path.endsWith('stsd')) {
    return textRegion(bytes, box, {
      location,
      kind: 'isobmff:sample-entry',
      carriesIdentity: false,
    });
  }
  if (path.endsWith('ilst')) {
    return textRegion(bytes, box, {
      location,
      kind: 'isobmff:ilst-entry',
      carriesIdentity: true,
    });
  }
  if (path.endsWith('udta')) {
    return textRegion(bytes, box, { location, kind: 'isobmff:udta-leaf', carriesIdentity: true });
  }
  // Coded payload: the bitstream sweep declares it as a scan range, so reading
  // it here would report the same banner twice.
  if (CODED_PAYLOAD.has(box.type)) return undefined;
  return unnamedRegion(
    bytes,
    { kind: 'isobmff:unnamed', location },
    { offset: box.offset, length: box.size },
    { start: box.bodyStart, end: box.bodyEnd }
  );
}

function childStartOf(box: Box): number {
  if (box.type === 'meta') return box.bodyStart + FULL_BOX_PREFIX_BYTES;
  if (box.type === 'stsd') return box.bodyStart + FULL_BOX_PREFIX_BYTES + ENTRY_COUNT_BYTES;
  return box.bodyStart;
}

/**
 * A box type is four bytes the file chose, and `location` is printed. The walk
 * refuses a non-printable type everywhere it can; inside an item list it cannot,
 * because an entry's type there is a numeric index, so those are reported by
 * ordinal rather than interpolated.
 */
function locationOf(box: Box, path: string, ordinal: number): string {
  const name = printableStructuralName(box.type) ?? `[${String(ordinal)}]`;
  return path === '' ? name : `${path}/${name}`;
}

interface Position {
  readonly path: string;
  readonly depth: number;
  readonly ordinal: number;
}

function boxRegions(bytes: Uint8Array, box: Box, at: Position): MetadataRegion[] {
  const { path, depth } = at;
  const location = locationOf(box, path, at.ordinal);
  if (!CONTAINERS.has(box.type)) {
    const region = leafRegion(bytes, box, location, path);
    return region === undefined ? [] : [region];
  }
  if (depth >= MAX_CONTAINER_DEPTH) {
    return [
      structuralRefusal(
        'isobmff:over-deep-container',
        box.offset,
        box.size,
        'container nesting past the depth limit'
      ),
    ];
  }
  const walk = readBoxes(bytes, childStartOf(box), box.bodyEnd, box.type === 'ilst');
  const children = collect(bytes, walk.boxes, location, depth + 1);
  if (!walk.damaged && walk.unaccounted === 0) return children;
  return [...children, structuralRefusal('isobmff:boxes', box.offset, box.size)];
}

function collect(
  bytes: Uint8Array,
  boxes: readonly Box[],
  path: string,
  depth: number
): MetadataRegion[] {
  return boxes.flatMap((box, ordinal) => boxRegions(bytes, box, { path, depth, ordinal }));
}

/** Metadata boxes of an ISO base-media file: C2PA `uuid`, user data, header times. */
export function parseIsoBmff(bytes: Uint8Array): MetadataRegion[] {
  const walk = readBoxes(bytes, 0, bytes.length);
  const collector = new RegionCollector();
  // Damage is appended to what the walk already found, never substituted for it,
  // which is what the nested walker above does and what nine sibling parsers do.
  // The verdict is dirty either way; substituting throws away the inventory the
  // operator and the stripper work from.
  collector.pushAll(collect(bytes, walk.boxes, '', 0));
  if (walk.damaged) {
    collector.push(structuralRefusal('isobmff:boxes', 0, bytes.length));
    return collector.collect(bytes.length);
  }
  // A tail too short to be a box header is content no box declares — the box
  // walker used to drop it without a word.
  if (walk.unaccounted > 0) {
    collector.push(
      structuralRefusal(
        'isobmff:trailing',
        bytes.length - walk.unaccounted,
        walk.unaccounted,
        TRAILING_BYTES_SHAPE
      )
    );
  }
  return collector.collect(bytes.length);
}

/**
 * The coded-payload ranges worth a bounded literal scan. Encoder build banners
 * ride inside the bitstream (x264 writes one as an SEI message), which no box
 * walk can reach.
 */
export function isoBmffScanRanges(bytes: Uint8Array): ScanRange[] {
  // The boxes walked before the damage are still boxes. Dropping them on damage
  // loses the literal sweep over a payload the walk did reach, which is the
  // second half of one branch's loss.
  const walk = readBoxes(bytes, 0, bytes.length);
  return walk.boxes
    .filter((box) => box.type === 'mdat')
    .map((box) => ({ location: 'mdat', start: box.bodyStart, end: box.bodyEnd }));
}
