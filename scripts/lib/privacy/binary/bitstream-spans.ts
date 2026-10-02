/**
 * Toolchain text carried inside a coded payload: finding the span each
 * occurrence sits in, bounding how much of the payload one blob may have
 * overwritten, and the remedy that overwrites it.
 */
import { mergeSpans, totalSpanBytes } from '../binary-content.js';
import { TOOLCHAIN_LITERALS } from './leak-values.js';
import type { ByteSpan } from '../binary-content.js';
import type { ScanRange } from './format-registry.js';
import type { ByteEdit, RemedyInput, Target, WorkMeter } from './strip-plan.js';

/**
 * The byte an overwritten banner is replaced with.
 *
 * Space, deliberately: a coded bitstream reserves runs of zero bytes as its own
 * start-code prefix, so filling with zeroes could desynchronise a decoder — a
 * failure that discloses nothing and that no gate in this repository can see.
 */
const BITSTREAM_FILL = 0x20;
const PRINTABLE_LOW = 0x20;
const PRINTABLE_HIGH = 0x7e;
/** How far back a build banner's own SEI header may sit. Real ones are adjacent. */
const SEI_SEARCH_BYTES = 4096;
const SEI_UUID_BYTES = 16;

/**
 * The longest run of coded payload a single overwrite may cover.
 *
 * An extent read out of the blob's own length prefix and size chain is not
 * bounded by checking it against the blob's other declarations — a crafted file
 * simply declares them all to agree, and the measured result was a unit spanning
 * the whole payload, overwritten wholesale and then reported clean by the
 * detector. The bound has to come from outside the file. Real banners run to
 * tens or hundreds of bytes, so this is orders of magnitude of headroom.
 */
const MAX_BITSTREAM_SPAN_BYTES = 4096;

/**
 * …and never more than this share of the range it sits in, as a divisor. The
 * absolute ceiling alone is no bound on a small payload, where a few kilobytes
 * is the whole of it.
 */
const BITSTREAM_SPAN_RANGE_DIVISOR = 8;

/**
 * The total coded payload one blob may have overwritten, whatever its own
 * framing says.
 *
 * Both fractional bounds are ratios against ranges the file declares, so a blob
 * that declares a larger payload raises both denominators together. This one
 * comes from outside the file entirely. The largest real total in this tree is
 * 754 bytes, so the ceiling is nearly two orders of magnitude of headroom, and
 * it sits beside the per-span bounds rather than replacing them.
 */
const MAX_TOTAL_BITSTREAM_BYTES = 65_536;

const OVER_WORK_SHAPE =
  'the coded payload would cost more work to walk than one blob is allowed to spend';
const OVER_TOTAL_SHAPE =
  'the coded payload carries more toolchain text in total than one blob may have overwritten';
const OVER_EXTENT_SHAPE =
  'a single overwrite would cover more of the coded payload than a toolchain banner ever does';

/** One literal hit inside a coded range, with everything a span rule needs. */
interface Occurrence {
  readonly bytes: Uint8Array;
  readonly view: Buffer;
  readonly range: ScanRange;
  readonly at: number;
  readonly length: number;
  readonly meter: WorkMeter;
}

interface SeiPayload {
  /** Where the user data starts, past the payload's sixteen-byte uuid. */
  readonly dataStart: number;
  readonly end: number;
}

/**
 * The unregistered payload's extent, read from `at` — a size written as a chain
 * of `0xff` bytes closed by one that is not, then the payload's own uuid.
 *
 * `undefined` for anything that does not add up: a size running past the unit it
 * claims to sit in, or one too short to hold even the uuid. The caller then
 * declines to treat the bytes as an SEI unit at all, which is the difference
 * between overwriting a build banner and overwriting coded samples. Internal
 * consistency is all this establishes; the extent is bounded from outside.
 */
export function seiPayload(view: Buffer, at: number, nalEnd: number): SeiPayload | undefined {
  let size = 0;
  let cursor = at;
  while (cursor + 1 < nalEnd && view.readUInt8(cursor) === 0xff) {
    size += 0xff;
    cursor += 1;
  }
  if (cursor >= nalEnd) return undefined;
  size += view.readUInt8(cursor);
  cursor += 1;
  const end = cursor + size;
  return end > nalEnd || size <= SEI_UUID_BYTES
    ? undefined
    : { dataStart: cursor + SEI_UUID_BYTES, end };
}

/**
 * The payload of the SEI unit enclosing `at`, when the framing around it checks
 * out end to end — a length prefix, the SEI and unregistered-user-data markers,
 * a size that fits the unit, and a payload that actually contains the literal.
 *
 * Self-validating on purpose. The alternative is walking every access unit from
 * the start of the payload, which interleaved audio makes unreliable, and an
 * unreliable walk here writes into coded samples.
 */
function seiPayloadSpan(occurrence: Occurrence): ByteSpan | undefined {
  const { view, range, at, meter } = occurrence;
  const floor = Math.max(range.start + 4, at - SEI_SEARCH_BYTES);
  // Never negative: the window floor can sit past an occurrence near the start of
  // a range, and a negative charge would let a blob buy back budget it spent.
  meter.charge(Math.max(0, at - floor));
  for (let position = at - 1; position >= floor; position--) {
    if (view.readUInt8(position) !== 0x06 || view.readUInt8(position + 1) !== 0x05) continue;
    const nalEnd = position + view.readUInt32BE(position - 4);
    if (nalEnd > range.end || at >= nalEnd) continue;
    const payload = seiPayload(view, position + 2, nalEnd);
    if (payload === undefined || at < payload.dataStart || at >= payload.end) continue;
    return { start: payload.dataStart, end: payload.end };
  }
  return undefined;
}

function isPrintable(byte: number | undefined): boolean {
  return byte !== undefined && byte >= PRINTABLE_LOW && byte <= PRINTABLE_HIGH;
}

/**
 * The printable run the literal sits in. Used where the literal rides a framing
 * this stripper does not decode — a codec's own fill element, say. Overwriting
 * only the literal would clear the finding and leave the version string beside
 * it, which is a detector blinded rather than a file cleaned.
 *
 * The walk stops one byte past the largest admitted extent rather than clamping
 * to it, so an over-long run is reported to the caller and refused. Clamping
 * would destroy the literal, clear the finding and leave the rest of the run in
 * place — the same blinding, arrived at from the other direction.
 */
export function literalRunSpan(occurrence: Occurrence): ByteSpan {
  const { bytes, range, at, length, meter } = occurrence;
  const limit = MAX_BITSTREAM_SPAN_BYTES + 1;
  let start = at;
  while (start > range.start && at - start < limit && isPrintable(bytes[start - 1])) {
    start -= 1;
  }
  // Clamped to the range rather than to the literal's own length. A straddling
  // literal is unreachable in a well-formed container — the byte past a coded
  // payload opens the next box's size word, and a size word beginning with a
  // printable character declares half a gigabyte — but the clamp is what makes
  // "this never writes outside the coded payload" true by construction rather
  // than by that argument holding.
  let end = Math.min(at + length, range.end);
  while (end < range.end && end - at < limit && isPrintable(bytes[end])) {
    end += 1;
  }
  meter.charge(end - start);
  return { start, end };
}

/** The coded range holding `at`, by binary search — a scan per occurrence is quadratic. */
export function rangeContaining(sorted: readonly ScanRange[], at: number): ScanRange | undefined {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = sorted[middle];
    /* v8 ignore next -- the index is derived from the array's own bounds */
    if (range === undefined) return undefined;
    if (at < range.start) high = middle - 1;
    else if (at >= range.end) low = middle + 1;
    else return range;
  }
  return undefined;
}

/** The reason an overwrite extent is refused, or `undefined` when it is admitted. */
function overExtent(span: ByteSpan, range: ScanRange): string | undefined {
  const length = span.end - span.start;
  if (length > MAX_BITSTREAM_SPAN_BYTES) return OVER_EXTENT_SHAPE;
  return length * BITSTREAM_SPAN_RANGE_DIVISOR > range.end - range.start
    ? OVER_EXTENT_SHAPE
    : undefined;
}

/**
 * Adds the span for one occurrence, or names the reason the blob is refused.
 * An occurrence outside every coded range is not this remedy's business — the
 * detector does not report it either.
 */
function collectSpan(
  spans: ByteSpan[],
  candidate: Omit<Occurrence, 'range'> & { readonly range: ScanRange | undefined }
): string | undefined {
  const { range, meter } = candidate;
  if (range === undefined) return undefined;
  if (meter.spent) return OVER_WORK_SHAPE;
  const occurrence: Occurrence = { ...candidate, range };
  const span = seiPayloadSpan(occurrence) ?? literalRunSpan(occurrence);
  const over = overExtent(span, range);
  if (over !== undefined) return over;
  spans.push(span);
  return undefined;
}

interface BitstreamPlan {
  readonly spans: readonly ByteSpan[];
  readonly refusal?: string;
}

/**
 * Every occurrence of every toolchain literal inside the coded payload, not only
 * the ones the detector points at: it reports the first per literal per range,
 * so a strip driven by its output would leave the next one behind and the file
 * would come back dirty.
 */
export function bitstreamSpans(
  bytes: Uint8Array,
  view: Buffer,
  ranges: readonly ScanRange[],
  meter: WorkMeter
): BitstreamPlan {
  const sorted = ranges.toSorted((left, right) => left.start - right.start);
  const spans: ByteSpan[] = [];
  for (const { literal } of TOOLCHAIN_LITERALS) {
    for (let at = view.indexOf(literal, 0, 'latin1'); at !== -1; ) {
      const refusal = collectSpan(spans, {
        bytes,
        view,
        range: rangeContaining(sorted, at),
        at,
        length: literal.length,
        meter,
      });
      if (refusal !== undefined) return { spans, refusal };
      at = view.indexOf(literal, at + 1, 'latin1');
    }
  }
  const merged = mergeSpans(spans);
  return totalSpanBytes(merged) > MAX_TOTAL_BITSTREAM_BYTES
    ? { spans: merged, refusal: OVER_TOTAL_SHAPE }
    : { spans: merged };
}

/** A target the detector raised against a coded payload rather than a metadata region. */
export function isBitstreamTarget(target: Target): boolean {
  return target.kind.endsWith(':bitstream');
}

interface BitstreamRemedy {
  readonly edits: readonly ByteEdit[];
  readonly excluded: readonly ByteSpan[];
  readonly refusal?: string;
}

/**
 * The in-payload remedy, shared by every format that declares coded ranges.
 *
 * Keyed on the finding's shape rather than on the container's name: a toolchain
 * string in a coded payload is one class, and the detector raises it wherever a
 * format offers ranges to scan. Writing it per format is how the second and
 * third container to declare ranges would arrive unremedied.
 *
 * Computed once for the blob rather than once per reported target — the span set
 * does not depend on which target asked for it, and the detector reports one
 * target per literal, so recomputing multiplied the whole walk by the number of
 * literals present.
 */
export function stripBitstream(input: RemedyInput): BitstreamRemedy {
  const { bytes, view, ranges, targets, meter } = input;
  if (!targets.some((target) => isBitstreamTarget(target))) return { edits: [], excluded: [] };
  const plan = bitstreamSpans(bytes, view, ranges, meter);
  if (plan.refusal !== undefined) return { edits: [], excluded: [], refusal: plan.refusal };
  return {
    excluded: plan.spans,
    edits: plan.spans.map((span) => ({
      start: span.start,
      end: span.end,
      data: new Uint8Array(span.end - span.start).fill(BITSTREAM_FILL),
      reason: 'overwrote a toolchain banner carried inside the coded payload',
    })),
  };
}
