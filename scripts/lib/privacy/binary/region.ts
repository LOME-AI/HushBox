/**
 * The currency between the binary detector and the binary stripper: a metadata
 * region is one addressable unit of a container's metadata, described so that
 * one side can report it and the other can remove or overwrite it without a
 * second parse.
 *
 * Every byte a parser turns into text passes through this module's caps. The
 * gate reads attacker-shaped input by design, and a compressed metadata region
 * is an amplifier: CODE-RULES already binds the crypto path to abort
 * decompression at an absolute byte cap, and this is the second place in the
 * codebase that inflates bytes it did not write.
 */
import { brotliDecompressSync, inflateSync } from 'node:zlib';

import { detectLeakValues } from './leak-values.js';

export interface RegionInstant {
  /** Which field of the region the instant came from, e.g. `creationTime`. */
  readonly field: string;
  /** UTC seconds. Whole seconds because no container here stores finer. */
  readonly secondsUtc: number;
}

/**
 * A byte range a format declares as opaque coded payload, worth the bounded
 * literal scan. It lives here rather than beside any one parser because three
 * containers declare one and the currency between them is this module's.
 */
export interface ScanRange {
  /** Structural name of the payload, e.g. `mdat`. Never file-controlled bytes. */
  readonly location: string;
  readonly start: number;
  readonly end: number;
}

export interface MetadataRegion {
  /** Format-scoped structural id, e.g. `png:zTXt`, `isobmff:uuid`, `id3:GEOB`. */
  readonly kind: string;
  /** Where the region sits in the container, e.g. `moov/udta/meta/ilst/©too`. */
  readonly location: string;
  /** Byte offset of the whole unit within the blob. */
  readonly offset: number;
  /** Byte length of that unit, header included. */
  readonly length: number;
  /** Text decoded out of the region; empty when the region carries none. */
  readonly text: string;
  /** Instants read out of fixed-width fields rather than out of `text`. */
  readonly instants: readonly RegionInstant[];
  /**
   * True when the region's existence discloses the authoring toolchain, so it
   * is reportable even if no value inside it matches a pattern.
   */
  readonly carriesIdentity: boolean;
  /**
   * Set when the parser refused the region rather than read it — nesting past
   * the depth limit, or compressed content past the decompression cap. The
   * refusal is reported: a container the gate cannot read is never a container
   * the gate calls clean.
   */
  readonly malformed?: string | undefined;
}

/**
 * Upper bound on the text pulled out of one region. A C2PA manifest runs to
 * tens of kilobytes and a mislabelled container could claim far more; the gate
 * only needs enough to characterise the disclosure.
 */
export const MAX_EXTRACTED_TEXT_BYTES = 65_536;

/**
 * Bytes decoded before run extraction begins. Independent of the output cap: a
 * metadata region is a bounded structure, and a container claiming a larger one
 * is damaged rather than informative.
 */
const MAX_DECODED_BYTES = 1_048_576;

/**
 * Ceiling on what a compressed *text* region may expand to. Every real packet
 * in this class — XMP, IPTC, WOFF2 extended metadata — is kilobytes; the
 * headroom is for legitimate outliers, and the cap is what stops a two-kilobyte
 * file from claiming a gigabyte.
 */
export const MAX_DECOMPRESSED_TEXT_BYTES = MAX_DECODED_BYTES;

/**
 * Ceiling on a WOFF2 table stream, which is a whole font rather than a metadata
 * packet — the largest tracked here compresses to about a tenth of a megabyte,
 * so this leaves two orders of magnitude of headroom and still bounds the blast
 * radius of a crafted header.
 */
export const MAX_DECOMPRESSED_TABLE_BYTES = 16_777_216;

/** The shape reported when a region is refused rather than read. */
export const OVER_CAP_SHAPE = 'compressed metadata region past the decompression cap';

/** The shape reported when a container's framing stops making sense part-way through. */
const DAMAGED_FRAMING_SHAPE = 'container framing damaged before the end of the blob';

/** The shape reported for bytes the container's own framing never accounts for. */
export const TRAILING_BYTES_SHAPE = 'bytes past the end of the container the framing declares';

/** The shape reported for bytes inside the container that its own enumeration never names. */
const UNACCOUNTED_SHAPE = 'bytes inside the container that its own enumeration never names';

/** The shape reported when a blob asks for more regions or more text than one blob may have. */
const OVER_BUDGET_SHAPE = 'container claiming more metadata than one blob may hold';

/**
 * Ceilings on a whole blob rather than on one region.
 *
 * Capping each region was the wrong unit: nothing bounded how *many* regions a
 * blob could have, so a file whose directory entries all alias one small image
 * multiplied the parse by the entry count at sixteen bytes each and ended in a
 * heap-limit abort — strictly worse than a throw, because a caller can catch a
 * throw and can do nothing at all with a dead process.
 *
 * The largest structure tracked here is an archive of thirty-three entries, so
 * both ceilings leave two orders of magnitude of headroom while bounding
 * retention to a few megabytes.
 */
export const MAX_REGIONS_PER_BLOB = 4096;
export const MAX_TOTAL_EXTRACTED_TEXT_BYTES = 4_194_304;

/**
 * Instants a blob may report across every region it produces.
 *
 * The two ceilings above count the *containers* of a disclosure, and one
 * container holds thousands: an archive extra field packs a timestamp
 * attribute every seventeen bytes, and a directory can put such a field in
 * front of the parser once per record. So a blob stays far inside both
 * ceilings while its finding list does not — measured, a quarter-megabyte
 * archive reached a heap-limit abort with every region ceiling intact.
 *
 * The largest structure tracked here reports a few hundred, so this leaves two
 * orders of magnitude of headroom and still bounds the list to something a gate
 * process can hold.
 */
export const MAX_INSTANTS_PER_BLOB = 65_536;

/**
 * Bytes a blob may have *walked* on its behalf, counted separately from the
 * regions that walk produced.
 *
 * A bound on results cannot bound an input that produces none. Directory entries
 * that all point at one image but declare different lengths miss any per-extent
 * memo, yield no regions apiece, and so spend no region budget — measured
 * quadratic, and at the format ceiling a file under two megabytes occupied the
 * gate for minutes and then reported clean. Metering the work is what closes
 * that, because the work is the thing being spent.
 *
 * This bounds re-parsing, which is why it stays tight: the only charge against
 * it comes from a directory that points at the same extent many times over. The
 * literal sweep carries its own, far larger ceiling below, because a linear pass
 * over a byte range costs nothing like a parse of it.
 */
const MAX_WALKED_BYTES = 33_554_432;

/**
 * Bytes the coded-payload literal sweep may search on one blob's behalf.
 *
 * Every range producer in the registry today emits spans of the blob that are
 * disjoint and inside its bounds, so the sum they ask for cannot exceed the
 * blob's own length. The only thing this ceiling can therefore refuse on a real
 * file is a *large* one — and that refusal is structural, so an allowlist entry
 * cannot absorb it: a blob past the ceiling is an unblockable push whose only
 * remedy is editing this constant. It is sized so an honest file never reaches
 * it, at two orders of magnitude over the largest binary this tree tracks
 * (twenty-one megabytes) — the same headroom the region ceilings above carry.
 * What it is here for is the case that is not honest: a future producer that
 * over-declares a range or overlaps two, where the work asked for is unbounded
 * by the blob's length.
 */
export const MAX_SWEPT_BYTES = 2_147_483_648;

/**
 * A parser's refusal, expressed as a region so it travels the same path as any
 * other finding.
 *
 * Bailing to an empty region list would report a damaged container as *clean*,
 * and the safety net does not catch it: a damaged file still matches its format,
 * so the registry claims it, the text gate defers to the registry, and nothing
 * examines the file at all. Silence on damage is the quiet sibling of throwing
 * on damage, and both hand the gate's security property to somebody else.
 */
export function structuralRefusal(
  kind: string,
  offset: number,
  length: number,
  shape: string = DAMAGED_FRAMING_SHAPE
): MetadataRegion {
  return {
    kind,
    location: 'structure',
    offset,
    length,
    text: '',
    instants: [],
    carriesIdentity: false,
    malformed: shape,
  };
}

/**
 * A span the container's own enumeration never accounted for, reported as a
 * refusal *and* read for values.
 *
 * A refusal alone says the gate could not account for the bytes; it does not say
 * what is in them, and the operator holding the report is the one who has to act
 * on that. So the span travels with its printable text, which the value rules
 * then read like any other content.
 */
export function unaccountedRegion(
  bytes: Uint8Array,
  kind: string,
  start: number,
  end: number
): MetadataRegion {
  return {
    kind,
    location: 'structure',
    offset: start,
    length: end - start,
    text: extractPrintableText(bytes, start, end),
    instants: [],
    carriesIdentity: false,
    malformed: UNACCOUNTED_SHAPE,
  };
}

/**
 * A region the container's framing legally declares but this gate's enumeration
 * does not name — a padding box, a private chunk, an unknown element.
 *
 * Not a refusal: the framing accounted for these bytes, so the container is
 * intact and its existence discloses nothing. What was missing is that nothing
 * ever *read* them, which is how a padding box carrying a host path and a full
 * datetime came to read clean. Reconciling the byte space is deliberate here
 * rather than a longer carrier list: a list only ever covers the carriers
 * somebody thought of, and the next padding type blinds it again.
 *
 * The body is read here and kept only when a value rule finds something in it.
 * Every container has structure this gate does not name — brand codes, sample
 * tables, colour tables — and materialising a region for each would bury the
 * reportable ones and hand the stripper a list of spans with nothing to remove.
 * The work stays linear in the blob because these spans are leaves of one walk
 * and so cannot overlap.
 *
 * `unit` and `body` are separate on purpose. What is *read* is the body, because
 * a header is structure rather than content; what is *reported* is the whole
 * unit, header included, exactly as every other region in this module reports
 * one. A remedy replaces or neutralises whole units, so an extent that named a
 * body would have it write a padding header over the first bytes of real content
 * and call the file stripped. A contract that holds for nine region classes and
 * not the tenth is not a contract.
 */
export function unnamedRegion(
  bytes: Uint8Array,
  at: { readonly kind: string; readonly location: string },
  unit: { readonly offset: number; readonly length: number },
  body: { readonly start: number; readonly end: number }
): MetadataRegion | undefined {
  const text = extractPrintableText(bytes, body.start, body.end);
  if (text === '' || detectLeakValues(text).length === 0) return undefined;
  return {
    kind: at.kind,
    location: at.location,
    offset: unit.offset,
    length: unit.length,
    text,
    instants: [],
    carriesIdentity: false,
  };
}

/**
 * Accumulates one blob's regions under the per-blob budget.
 *
 * Every parser builds through a collector rather than a bare array, so the
 * budget is enforced while the regions are being *made* — the retention the
 * abort came from is the accumulation itself, which a check after the fact
 * would arrive too late to prevent. Once the budget is spent the collector stops
 * accepting and the parser is expected to stop working: `exhausted` is what a
 * loop over repeated structures tests to break out.
 */
export class RegionCollector {
  readonly #regions: MetadataRegion[] = [];
  #textBytes = 0;
  #instants = 0;
  #walkedBytes = 0;
  #exhausted = false;
  readonly #workCeiling: number;

  /** A collector metering work a parse does; the sweep passes its own ceiling. */
  constructor(workCeiling: number = MAX_WALKED_BYTES) {
    this.#workCeiling = workCeiling;
  }

  /** True once the blob has spent its budget; the caller should stop parsing. */
  get exhausted(): boolean {
    return this.#exhausted;
  }

  /**
   * Charge work the blob caused, whether or not it produced anything. Callers
   * that re-enter a parser charge the bytes handed to it.
   */
  chargeWork(bytes: number): void {
    this.#walkedBytes += bytes;
    if (this.#walkedBytes > this.#workCeiling) this.#exhausted = true;
  }

  push(region: MetadataRegion): void {
    if (this.#exhausted) return;
    if (
      this.#regions.length >= MAX_REGIONS_PER_BLOB ||
      this.#textBytes + region.text.length > MAX_TOTAL_EXTRACTED_TEXT_BYTES ||
      this.#instants + region.instants.length > MAX_INSTANTS_PER_BLOB
    ) {
      this.#exhausted = true;
      return;
    }
    this.#textBytes += region.text.length;
    this.#instants += region.instants.length;
    this.#regions.push(region);
  }

  pushAll(regions: readonly MetadataRegion[]): void {
    for (const region of regions) this.push(region);
  }

  /**
   * The collected regions, with a refusal appended when the budget stopped the
   * parse — a blob the gate gave up on is never a blob the gate cleared.
   */
  collect(blobLength: number): MetadataRegion[] {
    if (!this.#exhausted) return this.#regions;
    return [...this.#regions, structuralRefusal('blob:budget', 0, blobLength, OVER_BUDGET_SHAPE)];
  }
}

const PRINTABLE_RUN = /[ -~]{4,}/gu;

const PRINTABLE_LOW = 0x20;
const PRINTABLE_HIGH = 0x7e;
/** The copyright sign that opens the iTunes-style atom names (`©too`, `©cmt`). */
const ATOM_PREFIX = 0xa9;

/**
 * A structural name safe to interpolate into a finding's `location`, or
 * `undefined` when the bytes are file-controlled enough that the caller should
 * fall back to an ordinal.
 *
 * `location` is printed. A four-byte type is too short to carry a timestamp, but
 * it is long enough to carry escape sequences into a terminal or a CI log, so
 * the gate names what it recognises and counts what it does not.
 */
export function printableStructuralName(name: string): string | undefined {
  for (const character of name) {
    /* v8 ignore next -- iterating a string always yields a character with a code point */
    const code = character.codePointAt(0) ?? 0;
    const printable = (code >= PRINTABLE_LOW && code <= PRINTABLE_HIGH) || code === ATOM_PREFIX;
    if (!printable) return undefined;
  }
  return name;
}

/** Every string a parser puts in a region's `text` passes through here. */
export function boundedText(value: string): string {
  return value.length <= MAX_EXTRACTED_TEXT_BYTES
    ? value
    : value.slice(0, MAX_EXTRACTED_TEXT_BYTES);
}

/**
 * Printable-ASCII runs inside a byte range, newline-joined. Structured binary
 * metadata (JUMBF, CBOR, ID3 payloads) interleaves text with framing bytes, so
 * the run extraction is what makes the value rules applicable to it at all.
 */
export function extractPrintableText(bytes: Uint8Array, start: number, end: number): string {
  const limit = Math.min(end, bytes.length, start + MAX_DECODED_BYTES);
  if (start >= limit) return '';
  const decoded = Buffer.from(bytes.subarray(start, limit)).toString('latin1');
  const runs = decoded.match(PRINTABLE_RUN) ?? [];
  return boundedText(runs.join('\n'));
}

/**
 * `undefined` distinguishes "would not fit, or would not decode" from "decoded
 * to nothing". Node's sync decompressors throw on both, and the caller reports
 * the refusal rather than treating an unreadable region as an absent one.
 */
function decompress(
  decoder: (input: Buffer, options: { maxOutputLength: number }) => Buffer,
  bytes: Uint8Array,
  maxOutputLength: number
): Buffer | undefined {
  try {
    return decoder(Buffer.from(bytes), { maxOutputLength });
  } catch {
    return undefined;
  }
}

/** zlib inflate bounded to the text cap. */
export function inflateBounded(bytes: Uint8Array): Buffer | undefined {
  return decompress(inflateSync, bytes, MAX_DECOMPRESSED_TEXT_BYTES);
}

/** brotli decompress bounded to a caller-chosen ceiling. */
export function brotliBounded(bytes: Uint8Array, maxOutputLength: number): Buffer | undefined {
  return decompress(brotliDecompressSync, bytes, maxOutputLength);
}
