import {
  RegionCollector,
  boundedText,
  extractPrintableText,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion } from './region.js';

export const MATROSKA_SIGNATURE = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);

const ID_SEGMENT = 0x18_53_80_67;
const ID_INFO = 0x15_49_a9_66;
const ID_TAGS = 0x12_54_c3_67;
const ID_DATE_UTC = 0x44_61;
const ID_MUXING_APP = 0x4d_80;
const ID_WRITING_APP = 0x57_41;
const ID_TITLE = 0x7b_a9;
/** The coded frames, stepped over by size rather than read — that is the walk's whole economy. */
const ID_CLUSTER = 0x1f_43_b6_75;

/** Matroska counts its segment date in nanoseconds from 2001-01-01 UTC. */
const EPOCH_OFFSET_SECONDS = 978_307_200;
const NANOS_PER_SECOND = 1_000_000_000;
const DATE_BYTES = 8;
const MAX_VINT_BYTES = 8;
/** An Info text element is a tool name, not a payload; anything longer is not one. */
const TEXT_CAP_BYTES = 65_536;

const INFO_TEXT_ELEMENTS = new Map<number, { readonly name: string; readonly identity: boolean }>([
  [ID_MUXING_APP, { name: 'MuxingApp', identity: true }],
  [ID_WRITING_APP, { name: 'WritingApp', identity: true }],
  [ID_TITLE, { name: 'Title', identity: false }],
]);

export function matchesMatroska(bytes: Uint8Array): boolean {
  return (
    bytes.length >= MATROSKA_SIGNATURE.length &&
    MATROSKA_SIGNATURE.every((byte, index) => bytes[index] === byte)
  );
}

interface Vint {
  readonly value: number;
  readonly width: number;
  readonly unknown: boolean;
}

function vintWidth(first: number): number {
  for (let width = 1; width <= MAX_VINT_BYTES; width++) {
    if ((first & (0x1_00 >> width)) !== 0) return width;
  }
  return 0;
}

/** Element identifiers keep their marker bits; sizes have theirs stripped. */
function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint | undefined {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  const width = vintWidth(first);
  if (width === 0 || offset + width > bytes.length) return undefined;
  let value = keepMarker ? first : first & ((0x1_00 >> width) - 1);
  let allOnes = !keepMarker && value === (0x1_00 >> width) - 1;
  for (let index = 1; index < width; index++) {
    const byte = bytes[offset + index] ?? 0;
    value = value * 256 + byte;
    allOnes = allOnes && byte === 0xff;
  }
  return { value, width, unknown: allOnes };
}

interface Element {
  readonly id: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly offset: number;
  readonly length: number;
}

/**
 * EBML has no trailing-byte case of its own: every byte in the segment must open
 * an element, so a residue cannot be "unaccounted" the way a chunk-stream
 * residue is — it presents as framing damage and is reported as that.
 */
interface ElementWalk {
  readonly elements: Element[];
  /** True when the walk stopped before `end` because the framing stopped parsing. */
  readonly damaged: boolean;
}

function readElements(bytes: Uint8Array, start: number, end: number): ElementWalk {
  const elements: Element[] = [];
  let offset = start;
  while (offset < end) {
    const id = readVint(bytes, offset, true);
    const size = id === undefined ? undefined : readVint(bytes, offset + id.width, false);
    if (id === undefined || size === undefined) {
      return { elements, damaged: true };
    }
    const bodyStart = offset + id.width + size.width;
    const bodyEnd = size.unknown ? end : bodyStart + size.value;
    if (bodyEnd > end) return { elements, damaged: true };
    elements.push({ id: id.value, bodyStart, bodyEnd, offset, length: bodyEnd - offset });
    offset = bodyEnd;
  }
  return { elements, damaged: false };
}

function infoTextRegion(
  bytes: Uint8Array,
  child: Element,
  name: string,
  identity: boolean
): MetadataRegion {
  return {
    kind: `matroska:${name}`,
    location: `Segment/Info/${name}`,
    offset: child.offset,
    length: child.length,
    text: boundedText(
      Buffer.from(
        bytes.subarray(child.bodyStart, Math.min(child.bodyEnd, child.bodyStart + TEXT_CAP_BYTES))
      ).toString('utf8')
    ),
    instants: [],
    carriesIdentity: identity,
  };
}

function dateRegion(bytes: Uint8Array, child: Element): MetadataRegion {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nanos = view.readBigInt64BE(child.bodyStart);
  return {
    kind: 'matroska:DateUTC',
    location: 'Segment/Info/DateUTC',
    offset: child.offset,
    length: child.length,
    text: '',
    instants: [
      {
        field: 'segmentDate',
        secondsUtc: EPOCH_OFFSET_SECONDS + Number(nanos / BigInt(NANOS_PER_SECOND)),
      },
    ],
    carriesIdentity: false,
  };
}

/** One child of the Info element: a named text field, the segment date, or bytes no rule names. */
function infoChildRegion(bytes: Uint8Array, child: Element): MetadataRegion | undefined {
  const text = INFO_TEXT_ELEMENTS.get(child.id);
  if (text !== undefined) return infoTextRegion(bytes, child, text.name, text.identity);
  if (child.id === ID_DATE_UTC && child.bodyEnd - child.bodyStart === DATE_BYTES) {
    return dateRegion(bytes, child);
  }
  return unnamedRegion(
    bytes,
    { kind: 'matroska:unnamed', location: 'Segment/Info' },
    { offset: child.offset, length: child.length },
    { start: child.bodyStart, end: child.bodyEnd }
  );
}

function infoRegions(bytes: Uint8Array, info: Element): MetadataRegion[] {
  const regions: MetadataRegion[] = [];
  const walk = readElements(bytes, info.bodyStart, info.bodyEnd);
  // A nested walk's damage is the same disclosure as the top-level walk's: a
  // container with intact outer framing and damaged inner framing is one the
  // gate could not read, not one it cleared.
  if (walk.damaged) {
    regions.push(structuralRefusal('matroska:elements', info.offset, info.length));
  }
  for (const child of walk.elements) {
    const region = infoChildRegion(bytes, child);
    if (region !== undefined) regions.push(region);
  }
  return regions;
}

/**
 * Segment-level metadata only. Clusters hold the coded frames and are stepped
 * over by size rather than descended into, which is what keeps a walk of a
 * hundred-megabyte capture to a handful of reads.
 */
function tagsRegion(bytes: Uint8Array, tags: Element): MetadataRegion | undefined {
  const text = extractPrintableText(bytes, tags.bodyStart, tags.bodyEnd);
  if (text === '') return undefined;
  return {
    kind: 'matroska:Tags',
    location: 'Segment/Tags',
    offset: tags.offset,
    length: tags.length,
    text,
    instants: [],
    carriesIdentity: true,
  };
}

/** One child of a Segment. Clusters are the coded frames and are stepped over by size. */
function segmentChildRegions(bytes: Uint8Array, child: Element): readonly MetadataRegion[] {
  if (child.id === ID_INFO) return infoRegions(bytes, child);
  if (child.id === ID_TAGS) {
    const region = tagsRegion(bytes, child);
    return region === undefined ? [] : [region];
  }
  if (child.id === ID_CLUSTER) return [];
  // A segment child this gate has no rule for is read for values rather than
  // stepped over: attachments and chapters are ordinary places for a path.
  const unnamed = unnamedRegion(
    bytes,
    { kind: 'matroska:unnamed', location: 'Segment' },
    { offset: child.offset, length: child.length },
    { start: child.bodyStart, end: child.bodyEnd }
  );
  return unnamed === undefined ? [] : [unnamed];
}

function segmentRegions(bytes: Uint8Array, segment: Element): MetadataRegion[] {
  const regions: MetadataRegion[] = [];
  const walk = readElements(bytes, segment.bodyStart, segment.bodyEnd);
  if (walk.damaged) {
    regions.push(structuralRefusal('matroska:elements', segment.offset, segment.length));
  }
  for (const child of walk.elements) regions.push(...segmentChildRegions(bytes, child));
  return regions;
}

export function parseMatroska(bytes: Uint8Array): MetadataRegion[] {
  const walk = readElements(bytes, 0, bytes.length);
  const collector = new RegionCollector();
  if (walk.damaged) collector.push(structuralRefusal('matroska:elements', 0, bytes.length));
  for (const segment of walk.elements.filter((element) => element.id === ID_SEGMENT)) {
    collector.pushAll(segmentRegions(bytes, segment));
  }
  return collector.collect(bytes.length);
}
