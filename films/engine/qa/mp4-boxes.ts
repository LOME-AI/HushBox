/** An ISO-BMFF box header: the box's whole size, its four-character type, and the header's own size. */
export interface BoxHeader {
  size: number;
  type: string;
  headerSize: number;
}

/** What the final-file rules read of each track in an MP4's `moov`. */
export interface Mp4Track {
  trackId: number;
  /** The handler type: `vide` for picture, `soun` for audio. */
  handler: string;
  timescale: number;
  /** The media duration, in the track's timescale. */
  duration: number;
  /** Whether the track carries an `edts` box, whose edit list re-times it on readers that honour it. */
  hasEditList: boolean;
  /** The `stts` table: runs of samples of equal duration, in the track's timescale. */
  sampleDurations: { count: number; delta: number }[];
}

const SMALL_HEADER = 8;
const LARGE_HEADER = 16;
const FULL_BOX_HEADER = 4;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCodePoint(...bytes.subarray(offset, offset + 4));
}

function u64(data: DataView, offset: number): number {
  return data.getUint32(offset) * 2 ** 32 + data.getUint32(offset + 4);
}

/** The header of the box at `offset`; a size of 0 runs to the end of `bytes`. */
export function boxHeader(bytes: Uint8Array, offset: number): BoxHeader {
  if (offset + SMALL_HEADER > bytes.length) {
    throw new RangeError(
      `a box header at byte ${String(offset)} runs past the ${String(bytes.length)} bytes read`
    );
  }
  const data = view(bytes);
  const size = data.getUint32(offset);
  const type = ascii(bytes, offset + 4);
  if (size === 1) {
    return { size: u64(data, offset + SMALL_HEADER), type, headerSize: LARGE_HEADER };
  }
  return { size: size === 0 ? bytes.length - offset : size, type, headerSize: SMALL_HEADER };
}

/** The payloads of the child boxes in `bytes`, by type, in order. */
function children(bytes: Uint8Array): { type: string; payload: Uint8Array }[] {
  const found: { type: string; payload: Uint8Array }[] = [];
  let offset = 0;
  while (offset + SMALL_HEADER <= bytes.length) {
    const { size, type, headerSize } = boxHeader(bytes, offset);
    found.push({ type, payload: bytes.subarray(offset + headerSize, offset + size) });
    offset += Math.max(size, headerSize);
  }
  return found;
}

function child(bytes: Uint8Array, type: string): Uint8Array | null {
  return children(bytes).find((candidate) => candidate.type === type)?.payload ?? null;
}

function path(bytes: Uint8Array, types: readonly string[]): Uint8Array | null {
  let current: Uint8Array | null = bytes;
  for (const type of types) {
    current = current === null ? null : child(current, type);
  }
  return current;
}

function mediaHeader(mdhd: Uint8Array): { timescale: number; duration: number } {
  const data = view(mdhd);
  return data.getUint8(0) === 1
    ? { timescale: data.getUint32(FULL_BOX_HEADER + 16), duration: u64(data, FULL_BOX_HEADER + 20) }
    : {
        timescale: data.getUint32(FULL_BOX_HEADER + 8),
        duration: data.getUint32(FULL_BOX_HEADER + 12),
      };
}

function timeToSample(stts: Uint8Array | null): Mp4Track['sampleDurations'] {
  if (stts === null) {
    return [];
  }
  const data = view(stts);
  const entries = data.getUint32(FULL_BOX_HEADER);
  return Array.from({ length: entries }, (_, index) => {
    const offset = FULL_BOX_HEADER + 4 + index * 8;
    return { count: data.getUint32(offset), delta: data.getUint32(offset + 4) };
  });
}

/** The track id in a `tkhd` box, after its creation and modification times (64-bit in version 1); 0 when there is none. */
function trackIdOf(tkhd: Uint8Array | null): number {
  if (tkhd === null) {
    return 0;
  }
  const timesBytes = tkhd[0] === 1 ? 16 : 8;
  return view(tkhd).getUint32(FULL_BOX_HEADER + timesBytes);
}

function track(trak: Uint8Array): Mp4Track {
  const trackId = trackIdOf(child(trak, 'tkhd'));
  const mdhd = path(trak, ['mdia', 'mdhd']);
  const hdlr = path(trak, ['mdia', 'hdlr']);
  if (mdhd === null || hdlr === null) {
    throw new RangeError(
      `track ${String(trackId)} has no mdhd or hdlr box: it is not a media track`
    );
  }
  return {
    trackId,
    handler: ascii(hdlr, FULL_BOX_HEADER + 4),
    ...mediaHeader(mdhd),
    hasEditList: child(trak, 'edts') !== null,
    sampleDurations: timeToSample(path(trak, ['mdia', 'minf', 'stbl', 'stts'])),
  };
}

/** Every track of an MP4, read from its `moov` box, header included. */
export function mp4Tracks(moov: Uint8Array): Mp4Track[] {
  const { type, headerSize, size } = boxHeader(moov, 0);
  if (type !== 'moov') {
    throw new RangeError(`the bytes hold a ${JSON.stringify(type)} box, not the moov box`);
  }
  return children(moov.subarray(headerSize, size))
    .filter((candidate) => candidate.type === 'trak')
    .map(({ payload }) => track(payload));
}
