import {
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  boundedText,
  extractPrintableText,
  structuralRefusal,
  unaccountedRegion,
} from './region.js';
import type { MetadataRegion, RegionInstant } from './region.js';

const LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50;
const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const EOCD_BYTES = 22;
/** The comment field is 16-bit-limited, so the record is never further back than this. */
const EOCD_SEARCH_BYTES = 65_535 + EOCD_BYTES;
const CENTRAL_RECORD_BYTES = 46;
/** Where a central record says its own local record sits. */
const LOCAL_OFFSET_FIELD = 42;
/** Where a central record states the size of the body its local record holds. */
const COMPRESSED_SIZE_FIELD = 20;
const GENERAL_FLAGS_FIELD = 8;
const LOCAL_RECORD_BYTES = 30;
const LOCAL_NAME_LENGTH_FIELD = 26;
const LOCAL_EXTRA_LENGTH_FIELD = 28;
/** Bit 3: the sizes are written after the body instead of into the local record. */
const STREAMED_SIZES_FLAG = 1 << 3;
const DATA_DESCRIPTOR_SIGNATURE = 0x08_07_4b_50;
const DATA_DESCRIPTOR_BYTES = 12;
const SIGNED_DATA_DESCRIPTOR_BYTES = 16;
const DOS_EPOCH_YEAR = 1980;

/** Info-ZIP extended timestamp: a flags byte then 32-bit UTC seconds per present field. */
const EXTRA_EXTENDED_TIMESTAMP = 0x54_55;
/** NTFS extra field: 64-bit Windows FILETIMEs, 100-nanosecond ticks from 1601-01-01. */
const EXTRA_NTFS = 0x00_0a;
const NTFS_TAG_TIMES = 0x00_01;
const NTFS_TIMES_BYTES = 24;
const FILETIME_TICKS_PER_SECOND = 10_000_000n;
const FILETIME_EPOCH_OFFSET_SECONDS = 11_644_473_600n;
const EXTRA_HEADER_BYTES = 4;

export function matchesZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const signature = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32LE(0);
  return signature === LOCAL_HEADER_SIGNATURE || signature === EOCD_SIGNATURE;
}

function findEndOfDirectory(view: Buffer): number {
  const floor = Math.max(0, view.length - EOCD_SEARCH_BYTES);
  for (let offset = view.length - EOCD_BYTES; offset >= floor; offset--) {
    if (view.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * DOS timestamps carry no zone, so they are read as wall-clock fields and
 * judged on the clock alone: an archive normalized to the reproducible-build
 * epoch stores midnight and discloses nothing.
 */
function dosInstantSeconds(dosTime: number, dosDate: number): number {
  return (
    Date.UTC(
      DOS_EPOCH_YEAR + (dosDate >> 9),
      ((dosDate >> 5) & 0x0f) - 1,
      dosDate & 0x1f,
      dosTime >> 11,
      (dosTime >> 5) & 0x3f,
      (dosTime & 0x1f) * 2
    ) / 1000
  );
}

function extendedTimestampInstants(view: Buffer, start: number, end: number): RegionInstant[] {
  const flags = view.readUInt8(start);
  const fields = ['extraModified', 'extraAccessed', 'extraCreated'];
  const instants: RegionInstant[] = [];
  let offset = start + 1;
  for (const [index, field] of fields.entries()) {
    if ((flags & (1 << index)) === 0 || offset + 4 > end) continue;
    instants.push({ field, secondsUtc: view.readInt32LE(offset) });
    offset += 4;
  }
  return instants;
}

function ntfsInstants(view: Buffer, start: number, end: number): RegionInstant[] {
  // Four reserved bytes, then tag/size-prefixed attributes.
  let offset = start + 4;
  const instants: RegionInstant[] = [];
  while (offset + EXTRA_HEADER_BYTES <= end) {
    const tag = view.readUInt16LE(offset);
    const size = view.readUInt16LE(offset + 2);
    const body = offset + EXTRA_HEADER_BYTES;
    if (body + size > end) break;
    if (tag === NTFS_TAG_TIMES && size >= NTFS_TIMES_BYTES) {
      const fields = ['ntfsModified', 'ntfsAccessed', 'ntfsCreated'];
      for (const [index, field] of fields.entries()) {
        const ticks = view.readBigUInt64LE(body + index * 8);
        instants.push({
          field,
          secondsUtc: Number(ticks / FILETIME_TICKS_PER_SECOND - FILETIME_EPOCH_OFFSET_SECONDS),
        });
      }
    }
    offset = body + size;
  }
  return instants;
}

/**
 * The extra fields carry the full-resolution UTC time the coarse DOS words
 * cannot express. Reading only the DOS words would let an archive whose coarse
 * fields are normalized while its extra fields are not read as clean.
 */
function extraFieldInstants(view: Buffer, start: number, end: number): RegionInstant[] {
  const instants: RegionInstant[] = [];
  let offset = start;
  while (offset + EXTRA_HEADER_BYTES <= end) {
    const id = view.readUInt16LE(offset);
    const size = view.readUInt16LE(offset + 2);
    const body = offset + EXTRA_HEADER_BYTES;
    if (body + size > end) break;
    if (id === EXTRA_EXTENDED_TIMESTAMP && size >= 1) {
      instants.push(...extendedTimestampInstants(view, body, body + size));
    } else if (id === EXTRA_NTFS && size >= 4) {
      instants.push(...ntfsInstants(view, body, body + size));
    }
    offset = body + size;
  }
  return instants;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/** A local record's own extent, and where inside it the extra field sits. */
interface LocalRecord {
  readonly start: number;
  readonly end: number;
  readonly extraStart: number;
  readonly extraEnd: number;
}

/** How many bytes of descriptor follow a body whose sizes were streamed. */
function descriptorBytes(view: Buffer, at: number, limit: number, flags: number): number {
  if ((flags & STREAMED_SIZES_FLAG) === 0) return 0;
  const signed =
    at + SIGNED_DATA_DESCRIPTOR_BYTES <= limit &&
    view.readUInt32LE(at) === DATA_DESCRIPTOR_SIGNATURE;
  return signed ? SIGNED_DATA_DESCRIPTOR_BYTES : DATA_DESCRIPTOR_BYTES;
}

/**
 * The extent of the local record a central record points at, measured from that
 * record's own header rather than inferred from its central counterpart.
 *
 * The two name and extra lengths are independent fields, and an extra field the
 * local record carries while the central copy does not is read by nobody if the
 * walk takes the central lengths for both. `undefined` means the offset resolves
 * to nothing this parser can call a local record, so the bytes stay unaccounted
 * and the reconciliation reads them rather than trusting the pointer.
 */
function localRecord(view: Buffer, central: number, limit: number): LocalRecord | undefined {
  const at = view.readUInt32LE(central + LOCAL_OFFSET_FIELD);
  if (at + LOCAL_RECORD_BYTES > limit) return undefined;
  if (view.readUInt32LE(at) !== LOCAL_HEADER_SIGNATURE) return undefined;
  const compressedSize = view.readUInt32LE(central + COMPRESSED_SIZE_FIELD);
  const flags = view.readUInt16LE(central + GENERAL_FLAGS_FIELD);
  const extraStart = at + LOCAL_RECORD_BYTES + view.readUInt16LE(at + LOCAL_NAME_LENGTH_FIELD);
  const extraEnd = extraStart + view.readUInt16LE(at + LOCAL_EXTRA_LENGTH_FIELD);
  const bodyEnd = extraEnd + compressedSize;
  const end = bodyEnd + descriptorBytes(view, bodyEnd, limit, flags);
  return end > limit ? undefined : { start: at, end, extraStart, extraEnd };
}

/**
 * The spans in front of the end record that no declared extent covers.
 *
 * Every verdict an archive gets hangs off the end record, and every field in it
 * is a field the archive wrote. An entry count of zero walks nothing, so the
 * honest local records and central directory still sitting in front of that
 * record are read by nobody while the blob comes back clean — and the text gate
 * defers to this registry, so no second gate looks either. Reconciling the byte
 * space is what the count cannot lie its way past; it is the same treatment the
 * icon directory already gives an entry count that under-declares its images.
 *
 * It is the *union* of what the records declare, never the envelope around it. A
 * lowest offset and a highest one describe only what lies in front of the first
 * record and behind the last, so a span between two members reads as accounted
 * because some record happened to point past it — which is an archive a standard
 * reader opens and extracts, carrying bytes nothing ever examines.
 */
function unaccountedSpans(extents: readonly Span[], eocd: number): readonly Span[] {
  const spans: Span[] = [];
  let covered = 0;
  for (const extent of extents.toSorted((a, b) => a.start - b.start)) {
    if (extent.start > covered) spans.push({ start: covered, end: extent.start });
    covered = Math.max(covered, extent.end);
  }
  if (covered < eocd) spans.push({ start: covered, end: eocd });
  return spans;
}

/** Pushes a refusal for every span in front of the end record that no extent covers. */
function reconcile(
  bytes: Uint8Array,
  collector: RegionCollector,
  extents: readonly Span[],
  eocd: number
): void {
  if (collector.exhausted) return;
  for (const span of unaccountedSpans(extents, eocd)) {
    collector.push(unaccountedRegion(bytes, 'zip:unaccounted', span.start, span.end));
  }
}

interface Entry {
  readonly offset: number;
  readonly index: number;
  readonly total: number;
  /** The local extra field to expand, empty when another entry already did. */
  readonly localExtra: readonly [number, number];
}

/** The extent read when there is no local extra field to expand. */
const NO_EXTRA: readonly [number, number] = [0, 0];

/**
 * The extra field of a local record, expanded the first time an entry points at
 * that record and never again.
 *
 * Do not remove this memo, and do not read the per-blob budget as covering
 * it. Many central records may name one local record. Info-ZIP and
 * CPython's `zipfile` both refuse that shape past the first member as
 * overlapped components, and none of that saves this gate: it dispatches
 * on signature over staged bytes and never opens an archive through a
 * reader, so the shape arrives whether or not anything would extract it.
 * Expanding a field costs text and instants, of which the budget counts
 * only the first. Measured, one packed field re-expanded per pointing
 * record took a 73-kilobyte archive to over two million findings, and
 * a quarter-megabyte one to a heap-limit process abort: a dead gate,
 * which is strictly worse than a throw a caller could have caught.
 *
 * Where the field sits depends on the local record's own offset and nothing
 * else, so memoising by that offset removes the multiplication rather than
 * capping it. What the memo cannot see is a *distinct* record whose declared
 * field is the same window: records at different offsets miss it every time
 * while a window of unread fields yields neither region nor text, so only the
 * charge — on the bytes the expansion reads, before it reads them — meters that
 * shape at all.
 */
function extraToExpand(
  local: LocalRecord | undefined,
  expanded: Set<number>,
  collector: RegionCollector
): readonly [number, number] {
  if (local === undefined || expanded.has(local.start)) return NO_EXTRA;
  expanded.add(local.start);
  collector.chargeWork(local.extraEnd - local.extraStart);
  return collector.exhausted ? NO_EXTRA : [local.extraStart, local.extraEnd];
}

/** One central-directory entry and the local record it points at, as one region. */
function entryRegion(bytes: Uint8Array, view: Buffer, entry: Entry): MetadataRegion {
  const { offset, localExtra } = entry;
  const nameStart = offset + CENTRAL_RECORD_BYTES;
  const extraStart = nameStart + view.readUInt16LE(offset + 28);
  const extraEnd = extraStart + view.readUInt16LE(offset + 30);
  return {
    kind: 'zip:central-directory-entry',
    location: `centralDirectory[${String(entry.index)}]`,
    offset,
    length: entry.total,
    text: boundedText(
      [
        view.toString('latin1', nameStart, extraStart),
        extractPrintableText(bytes, extraStart, extraEnd),
        extractPrintableText(bytes, ...localExtra),
      ]
        .filter((value) => value !== '')
        .join('\n')
    ),
    instants: [
      {
        field: 'entryModified',
        secondsUtc: dosInstantSeconds(
          view.readUInt16LE(offset + 12),
          view.readUInt16LE(offset + 14)
        ),
      },
      ...extraFieldInstants(view, extraStart, extraEnd),
      ...extraFieldInstants(view, ...localExtra),
    ],
    carriesIdentity: false,
  };
}

/**
 * Entry modification times from the central directory. The matching local file
 * headers carry the same values; a remedy has to rewrite both, which is why the
 * region reports the entry rather than a single byte range — and why the local
 * record's own extra field, which the central copy need not carry, rides that
 * same region rather than becoming a second one.
 *
 * The entry is located by ordinal, never by name: a name is up to 64 KB of
 * file-controlled bytes, and `location` is a field the gate prints. The name
 * travels in `text` instead, where the value rules read it like any other
 * content — so a timestamped archive path is a finding rather than something
 * echoed for free.
 */
export function parseZip(bytes: Uint8Array): MetadataRegion[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfDirectory(view);
  if (eocd === -1) return [structuralRefusal('zip:end-of-directory', 0, bytes.length)];
  const entryCount = view.readUInt16LE(eocd + 10);
  const directoryStart = view.readUInt32LE(eocd + 16);
  let offset = directoryStart;
  const extents: Span[] = [];
  const expanded = new Set<number>();
  const collector = new RegionCollector();
  for (let index = 0; index < entryCount && !collector.exhausted; index++) {
    if (offset + CENTRAL_RECORD_BYTES > eocd || view.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      collector.push(structuralRefusal('zip:central-directory', offset, eocd - offset));
      return collector.collect(bytes.length);
    }
    const nameLength = view.readUInt16LE(offset + 28);
    const extraLength = view.readUInt16LE(offset + 30);
    const commentLength = view.readUInt16LE(offset + 32);
    const total = CENTRAL_RECORD_BYTES + nameLength + extraLength + commentLength;
    // A record whose declared extent runs past the end record is damage inside
    // intact outer framing: the walk would step over the rest of the directory
    // in one jump and land past every span the reconciliation below can see.
    if (offset + total > eocd) {
      collector.push(structuralRefusal('zip:central-directory', offset, eocd - offset));
      return collector.collect(bytes.length);
    }
    const local = localRecord(view, offset, eocd);
    const localExtra = extraToExpand(local, expanded, collector);
    collector.push(entryRegion(bytes, view, { offset, index, total, localExtra }));
    extents.push({ start: offset, end: offset + total });
    if (local !== undefined) extents.push({ start: local.start, end: local.end });
    offset += total;
  }
  reconcile(bytes, collector, extents, eocd);
  // The end record, its comment included, is the last thing in an archive.
  const commentLength = view.readUInt16LE(eocd + 20);
  const declaredEnd = eocd + EOCD_BYTES + commentLength;
  if (declaredEnd !== bytes.length) {
    collector.push(
      structuralRefusal(
        'zip:trailing',
        declaredEnd,
        bytes.length - declaredEnd,
        TRAILING_BYTES_SHAPE
      )
    );
  }
  return collector.collect(bytes.length);
}
