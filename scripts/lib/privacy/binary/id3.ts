import { extractPrintableText, structuralRefusal, unnamedRegion } from './region.js';
import type { MetadataRegion } from './region.js';

const HEADER_BYTES = 10;
const FOOTER_BYTES = 10;
const FOOTER_FLAG = 0x10;
const EXTENDED_HEADER_FLAG = 0x40;
const SIZE_BYTES = 4;

/** Frames whose presence discloses the producing tool or an opaque manifest. */
const IDENTITY_FRAMES = new Set(['GEOB', 'TXXX', 'TSSE', 'TENC', 'PRIV', 'WXXX']);
/** Frames worth reading for values but unremarkable in themselves. */
const SCANNED_FRAMES = new Set(['COMM', 'TDRC', 'TDEN', 'TDTG', 'TDAT', 'TIME', 'TYER']);

function viewOf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Syncsafe integers spend seven bits per byte so no value can imitate a frame sync. */
function readSyncsafe(view: Buffer, offset: number): number {
  const raw = view.readUInt32BE(offset);
  return (
    ((raw & 0x7f_00_00_00) >>> 3) |
    ((raw & 0x7f_00_00) >>> 2) |
    ((raw & 0x7f_00) >>> 1) |
    (raw & 0x7f)
  );
}

function hasTag(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_BYTES && viewOf(bytes).toString('latin1', 0, 3) === 'ID3';
}

/**
 * Total bytes an ID3v2 tag occupies at the head of the blob, or 0 when there is
 * none. Callers use it to reach the real container behind the tag — an ID3
 * prefix says nothing about what the file actually is.
 */
export function id3TagLength(bytes: Uint8Array): number {
  if (!hasTag(bytes)) return 0;
  const view = viewOf(bytes);
  const footer = (view.readUInt8(5) & FOOTER_FLAG) === 0 ? 0 : FOOTER_BYTES;
  return HEADER_BYTES + readSyncsafe(view, 6) + footer;
}

interface Frame {
  readonly id: string;
  readonly start: number;
  readonly bodyStart: number;
  readonly end: number;
  /** A frame whose declared size runs past the tag: the tag stopped parsing here. */
  readonly damaged: boolean;
}

function frameRegion(bytes: Uint8Array, frame: Frame): MetadataRegion | undefined {
  if (frame.damaged) {
    return structuralRefusal('id3:frames', frame.start, frame.end - frame.start);
  }
  const identity = IDENTITY_FRAMES.has(frame.id);
  if (!identity && !SCANNED_FRAMES.has(frame.id)) {
    // A frame id neither list names is still a frame the tag declared, so it is
    // read for values instead of skipped.
    return unnamedRegion(
      bytes,
      { kind: 'id3:unnamed', location: 'ID3' },
      { offset: frame.start, length: frame.end - frame.start },
      { start: frame.bodyStart, end: frame.end }
    );
  }
  return {
    kind: `id3:${frame.id}`,
    location: `ID3/${frame.id}`,
    offset: frame.start,
    length: frame.end - frame.start,
    text: extractPrintableText(bytes, frame.bodyStart, frame.end),
    instants: [],
    carriesIdentity: identity,
  };
}

function readFrames(bytes: Uint8Array, start: number, bodyEnd: number, major: number): Frame[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Frame[] = [];
  let offset = start;
  while (offset + HEADER_BYTES <= bodyEnd) {
    const id = view.toString('latin1', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/u.test(id)) break;
    const size = major >= 4 ? readSyncsafe(view, offset + 4) : view.readUInt32BE(offset + 4);
    const bodyStart = offset + HEADER_BYTES;
    const end = bodyStart + size;
    if (size <= 0) break;
    if (end > bodyEnd) {
      frames.push({ id: '', start: offset, bodyStart, end: bodyEnd, damaged: true });
      break;
    }
    frames.push({ id, start: offset, bodyStart, end, damaged: false });
    offset = end;
  }
  return frames;
}

/**
 * Frames of an ID3v2.3/v2.4 tag. A v2.2 tag uses three-byte frame ids and sizes
 * and appears nowhere in this repo, so it is reported whole rather than given a
 * second frame walker that nothing exercises.
 */
export function parseId3(bytes: Uint8Array): MetadataRegion[] {
  const total = id3TagLength(bytes);
  if (total === 0) return [];
  const view = viewOf(bytes);
  const major = view.readUInt8(3);
  const flags = view.readUInt8(5);
  const bodyEnd = Math.min(HEADER_BYTES + readSyncsafe(view, 6), bytes.length);
  if (major < 3) {
    return [
      {
        kind: 'id3:tag',
        location: 'ID3',
        offset: 0,
        length: total,
        text: extractPrintableText(bytes, HEADER_BYTES, bodyEnd),
        instants: [],
        carriesIdentity: true,
      },
    ];
  }

  let offset = HEADER_BYTES;
  if ((flags & EXTENDED_HEADER_FLAG) !== 0) {
    // Reachable from a merely truncated file: a RIFF `id3 ` chunk carrying a
    // bare ten-byte header with this flag set has nothing behind it to read.
    // Reported rather than returned empty — a tag the gate cannot read is not a
    // tag the gate has cleared.
    if (offset + SIZE_BYTES > bodyEnd) {
      return [structuralRefusal('id3:extended-header', 0, bodyEnd)];
    }
    // v2.3 states the extended header's size excluding its own four size bytes.
    offset += major >= 4 ? readSyncsafe(view, offset) : readSyncsafe(view, offset) + 4;
  }
  const regions: MetadataRegion[] = [];
  for (const frame of readFrames(view, offset, bodyEnd, major)) {
    const region = frameRegion(bytes, frame);
    if (region !== undefined) regions.push(region);
  }
  return regions;
}
