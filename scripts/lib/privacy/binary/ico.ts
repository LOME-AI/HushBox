import { matchesPng, parsePng } from './png.js';
import {
  RegionCollector,
  TRAILING_BYTES_SHAPE,
  structuralRefusal,
  unnamedRegion,
} from './region.js';
import type { MetadataRegion } from './region.js';

const DIRECTORY_HEADER_BYTES = 6;
const DIRECTORY_ENTRY_BYTES = 16;
const ICON_TYPE = 1;

/**
 * The reserved word, the type and a non-zero count, plus room for the first
 * directory entry the count promises — a claim of format suppresses the text
 * gate, so the header is required to be consistent with itself.
 */
export function matchesIco(bytes: Uint8Array): boolean {
  if (bytes.length < DIRECTORY_HEADER_BYTES + DIRECTORY_ENTRY_BYTES) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.readUInt16LE(0) === 0 && view.readUInt16LE(2) === ICON_TYPE && view.readUInt16LE(4) > 0
  );
}

/**
 * An icon directory holds either device-independent bitmaps — whose headers
 * carry no author-supplied field at all — or whole PNG images, which do. The
 * format is registered rather than left unrecognized so that the PNG case is
 * actually inspected instead of passing as an unknown container.
 */
interface Entry {
  readonly start: number;
  readonly size: number;
}

/** The directory record at `index`, or `undefined` when the blob cannot hold it. */
function readEntry(view: Buffer, bytes: Uint8Array, index: number): Entry | undefined {
  const at = DIRECTORY_HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
  if (at + DIRECTORY_ENTRY_BYTES > bytes.length) return undefined;
  return { start: view.readUInt32LE(at + 12), size: view.readUInt32LE(at + 8) };
}

export function parseIco(bytes: Uint8Array): MetadataRegion[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.readUInt16LE(4);
  const collector = new RegionCollector();
  /**
   * Do not remove this memo, and do not read the per-blob budget as covering it.
   *
   * Directory entries may all point at one image while each costs sixteen bytes,
   * so a one-megabyte file can ask for tens of thousands of parses. The failure
   * mode is not slowness: without this memo the gate reached a heap-limit
   * process abort — measured at twenty thousand entries, ten milliseconds with
   * the memo against forty-six seconds without, and worse at the format ceiling.
   *
   * The region budget cannot save it, because an aliased image that yields no
   * regions spends none of that budget. What bounds the remaining shape — entries
   * that vary the declared length and so miss this memo every time — is the work
   * charge below, which meters the parse itself rather than what the parse
   * produced.
   */
  const parsed = new Map<string, readonly MetadataRegion[]>();
  let declaredEnd = DIRECTORY_HEADER_BYTES + count * DIRECTORY_ENTRY_BYTES;

  for (let index = 0; index < count && !collector.exhausted; index++) {
    const entry = readEntry(view, bytes, index);
    if (entry === undefined) {
      const at = DIRECTORY_HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
      collector.push(structuralRefusal('ico:directory', at, bytes.length - at));
      break;
    }
    if (entry.start + entry.size > bytes.length) {
      collector.push(
        structuralRefusal(
          'ico:image',
          DIRECTORY_HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES,
          DIRECTORY_ENTRY_BYTES
        )
      );
      continue;
    }
    declaredEnd = Math.max(declaredEnd, entry.start + entry.size);
    const image = bytes.subarray(entry.start, entry.start + entry.size);
    const regions = imageRegions(image, entry, parsed, collector);
    collector.pushAll(
      regions.map((region) => ({
        ...region,
        location: `image[${String(index)}]/${region.location}`,
        offset: region.offset + entry.start,
      }))
    );
  }

  // The directory and the images it points at are the whole file; anything past
  // the last image extent is content the directory never declared.
  if (!collector.exhausted && declaredEnd < bytes.length) {
    collector.push(
      structuralRefusal(
        'ico:trailing',
        declaredEnd,
        bytes.length - declaredEnd,
        TRAILING_BYTES_SHAPE
      )
    );
  }
  return collector.collect(bytes.length);
}

function imageRegions(
  image: Uint8Array,
  entry: Entry,
  parsed: Map<string, readonly MetadataRegion[]>,
  collector: RegionCollector
): readonly MetadataRegion[] {
  const key = `${String(entry.start)}:${String(entry.size)}`;
  const memoised = parsed.get(key);
  if (memoised !== undefined) return memoised;
  // Charged before the parse, and only on a memo miss: entries that vary the
  // declared length miss the memo every time while producing nothing, so the
  // work is the only thing that meters them.
  collector.chargeWork(image.length);
  if (collector.exhausted) return [];
  // A directory entry may hold a device-independent bitmap, which this parser
  // does not decode. It is still an extent the directory declared, so it is read
  // for values rather than skipped — through the same memo and charge, so the
  // aliased-extent bound covers it too.
  const regions = matchesPng(image)
    ? parsePng(image)
    : [
        unnamedRegion(
          image,
          { kind: 'ico:image', location: 'image' },
          { offset: 0, length: image.length },
          { start: 0, end: image.length }
        ),
      ].filter((region) => region !== undefined);
  parsed.set(key, regions);
  return regions;
}
