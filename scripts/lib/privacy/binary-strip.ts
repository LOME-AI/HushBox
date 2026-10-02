/**
 * The remedy side of the binary privacy gate: it removes what the detector
 * reports, and it removes it losslessly.
 *
 * The detector chooses *which* regions are remedied. It does not settle every
 * byte that moves, and the parts where it does not are the parts to watch:
 *
 * - The in-payload remedy re-derives *where* on its own, deliberately. The
 *   detector reports only the first occurrence of each literal per scan range,
 *   so edits driven from reported offsets alone would clean the first and leave
 *   the rest, and the file would come back dirty.
 * - The framing of one payload form is parsed here and has no counterpart in
 *   the detector at all.
 * - Three structural derivations are repeated against the detector's own — the
 *   box header widths, the audio tag's footer flag, footer length and flags
 *   offset, and the codec's block-header length and last-block flag. Each is
 *   noted at its site. If one drifts, a remedy zeroes the wrong bytes: the
 *   description proof catches that inside a container's own structural boxes,
 *   and nothing catches it in the audio tag or the codec's block chain.
 *
 * A region the detector could not read is a stop rather than a pass: the
 * refusal is appended to whatever else was found, and treating it as "nothing
 * to strip" would ship a file whose metadata was never examined.
 */
import { contentHash, contentSpans, overlappingBytes, totalSpanBytes } from './binary-content.js';
import { detectBinaryFormat } from './binary/format-registry.js';
import { id3TagLength } from './binary/id3.js';
import { scanBinaryBlob } from './binary/scan.js';
import { isBitstreamTarget, stripBitstream } from './binary/bitstream-spans.js';
import { REPORT_ONLY_RULES, WorkMeter, applyByteEdits, targetsOf } from './binary/strip-plan.js';
import type { ByteSpan } from './binary-content.js';
import type { BinaryFormat, BinaryFormatId, ScanRange } from './binary/format-registry.js';
import type { BinaryFinding, BinaryRule } from './binary/scan.js';
import type { ByteEdit, Remedy, RemedyPlan, Target } from './binary/strip-plan.js';

export type StripStatus = 'clean' | 'stripped' | 'refused' | 'unsupported' | 'incomplete';

export interface StripResult {
  readonly file: string;
  readonly format: BinaryFormatId | 'unknown';
  readonly status: StripStatus;
  /** The stripped blob, or the input unchanged on any status but `stripped`. */
  readonly bytes: Uint8Array;
  readonly edits: readonly ByteEdit[];
  /**
   * Spans inside the content stream this strip rewrote, and therefore the spans
   * a content comparison has to set aside. Empty for every remedy that stays
   * out of the content stream, which is all but one.
   */
  readonly contentExclusions: readonly ByteSpan[];
  /**
   * The content digest the strip proved unchanged, or the empty string where no
   * strip happened. Evidence a caller can print without recomputing anything.
   */
  readonly contentDigest: string;
  /**
   * Regions this strip had to leave standing: the ones the container reads to
   * describe its own content, and the ones nothing here can name. Read off the
   * detector's findings rather than off any remedy's declaration, which is what
   * keeps a remedy from narrowing its own proof.
   */
  readonly describedRegions: readonly ByteSpan[];
  /**
   * Bytes of stepping this strip charged against the work budget. Reported so a
   * bound sized from measured headroom can be checked against what real files
   * actually cost, rather than against an estimate of it.
   */
  readonly walkedBytes: number;
  /** Why the stripper stopped, or what a human still has to do. Shapes only. */
  readonly reasons: readonly string[];
}

/**
 * Findings that stop the stripper before it writes anything: the gate did not
 * read the content it is being asked to clean, so any edit derived from it would
 * come from a partial view of the file.
 *
 * `unrecognized-format` is deliberately absent. The detector raises it only when
 * no registered format matched, which is the case this function answers before
 * it consults this set — listing it here would be configuration that never
 * decides anything, and configuration that does nothing reads as protection
 * that is not there.
 */
const REFUSING_RULES: ReadonlySet<BinaryRule> = new Set(['unparseable-structure']);

const stripPng: Remedy = ({ targets }) => {
  if (targets.some((target) => UNNAMED_REGION_KINDS.has(target.kind))) {
    return { edits: [], refusal: UNNAMED_REGION_SHAPE };
  }
  return {
    edits: targets.map((target) => ({
      start: target.offset,
      end: target.offset + target.length,
      data: new Uint8Array(0),
      reason: `dropped the ${target.kind} chunk`,
    })),
  };
};

// These widths — the box header, its wide form, and the version-and-flags
// prefix of a full box — are derived a second time by the detector's own
// box walk, and the two derivations must agree: if either side moves, a
// remedy zeroes bytes the other never pointed at, inside a region no
// content proof covers. Collapsing them onto one export is recorded
// follow-up work; until then the agreement is held by this note and
// nothing else.
const ISO_HEADER_BYTES = 8;
const ISO_EXTENDED_HEADER_BYTES = 16;
/** Version and flags precede a header box's time fields. */
const ISO_FULL_BOX_PREFIX_BYTES = 4;
const ISO_FREE_TYPE = Uint8Array.from([0x66, 0x72, 0x65, 0x65]);
const ISO_TIME_KINDS: ReadonlySet<string> = new Set([
  'isobmff:mvhd',
  'isobmff:tkhd',
  'isobmff:mdhd',
]);

function isoHeaderBytes(view: Buffer, offset: number): number {
  return view.readUInt32BE(offset) === 1 ? ISO_EXTENDED_HEADER_BYTES : ISO_HEADER_BYTES;
}

const ISO_SIZE_TO_END = 0;
const ISO_SIZE_EXTENDED = 1;

const NOT_A_UNIT_SHAPE =
  'a reported metadata region does not open a container unit of the length it was reported with';

/**
 * Whether `target` opens a box of exactly the length it arrived with.
 *
 * Every metadata remedy for this container reads a box header at the reported
 * offset, which is a claim about the finding rather than anything this module
 * observed. The contract is that an extent covers the whole unit, header
 * included; a target naming a body instead would have padding framing stamped
 * over bytes that are not a header, and the content proof cannot catch it
 * because the located content for this format lies elsewhere. So the claim is
 * checked where it is relied on, and a violation refuses rather than writes.
 */
function isoOpensUnit(view: Buffer, target: Target): boolean {
  if (target.offset < 0 || target.offset + ISO_HEADER_BYTES > view.length) return false;
  const declared = view.readUInt32BE(target.offset);
  if (declared === ISO_SIZE_EXTENDED) {
    if (target.offset + ISO_EXTENDED_HEADER_BYTES > view.length) return false;
    return view.readBigUInt64BE(target.offset + ISO_HEADER_BYTES) === BigInt(target.length);
  }
  // A declared size of zero runs the box to the end of the file.
  if (declared === ISO_SIZE_TO_END) return target.offset + target.length === view.length;
  return declared === target.length;
}

/**
 * A metadata box becomes a `free` box of exactly its own size.
 *
 * Removing it is not an option: sample tables address the coded payload by
 * absolute file offset, so a shorter file plays back garbage. `free` is the
 * format's own "skip this", so a player walks past what used to disclose.
 */
function isoFreeBox(view: Buffer, target: Target): ByteEdit {
  const headerBytes = isoHeaderBytes(view, target.offset);
  const data = new Uint8Array(target.length);
  data.set(view.subarray(target.offset, target.offset + headerBytes));
  data.set(ISO_FREE_TYPE, 4);
  // A declared size of zero means "to the end of the file", which is legal for
  // a `uuid` box and illegal for a `free` one — so the real extent is written.
  if (view.readUInt32BE(target.offset) === 0) {
    new DataView(data.buffer).setUint32(0, target.length);
  }
  return {
    start: target.offset,
    end: target.offset + target.length,
    data,
    reason: `retyped the ${target.kind} box to free and zeroed its body`,
  };
}

const ISO_SAMPLE_ENTRY_KIND = 'isobmff:sample-entry';

/**
 * The regions a walk found and read, and whose role its parser recognised as
 * nothing, for the containers where blanking one may cost a decoder something.
 *
 * The discriminator is whichever grain answers the question — whether an unnamed
 * region *can* be essential — rather than one grain everywhere. The parsers that
 * answer it about their whole reported set do so because nothing in the bytes
 * tells one such region from another; the image format answers it per region,
 * because the case of a chunk type's first letter *is* the format's statement of
 * whether a decoder may skip a chunk it does not recognise. Every kind here
 * names a structure a decoder requires: a box the specification makes mandatory,
 * the element carrying the codec configuration, the block carrying the stream
 * description, a chunk the image format marks critical.
 *
 * An unrecognised *ancillary* chunk is deliberately absent, being the one the
 * same format says a decoder can ignore. The tag format is absent whole:
 * everything a tag holds is a frame, which the format defines as metadata, so
 * refusing there would cost remedy reach and buy no safety.
 */
const UNNAMED_REGION_KINDS: ReadonlySet<string> = new Set([
  'isobmff:unnamed',
  'matroska:unnamed',
  'flac:unnamed',
  'png:unnamed-critical',
]);

const UNNAMED_REGION_SHAPE =
  'the disclosure sits in a region no parser here recognises, and a remedy that cannot say what a ' +
  'region is for cannot say what removing it costs';

// The fixed block of a visual sample entry, measured from its body start. The
// widths are the format's, and the compressor name sits behind all of them.
const ISO_VISUAL_ENTRY_BYTES = 78;
const ISO_COMPRESSOR_NAME_OFFSET = 42;
const ISO_COMPRESSOR_NAME_BYTES = 32;
/** The field is a length byte and the characters behind it. */
const ISO_COMPRESSOR_NAME_MAX = ISO_COMPRESSOR_NAME_BYTES - 1;
/** The value the format writes into the word that closes the fixed block. */
const ISO_VISUAL_PRE_DEFINED = 0xff_ff;

const SAMPLE_ENTRY_SHAPE =
  'a sample entry discloses through the fixed compressor-name field, and this one does not ' +
  'carry that field where the format puts it, so clearing it would write over the codec ' +
  'configuration instead';

/**
 * Whether the boxes behind the fixed block chain to exactly the entry's end.
 *
 * The reading above is field checks against a layout, and field checks can
 * agree by coincidence on bytes that are not a visual sample entry at all — an
 * audio entry's descriptors, say. The chain is the structural check: it
 * establishes that the bytes the remedy is about to zero sit in front of the
 * entry's children rather than inside one of them.
 */
function isoEntryChildrenChain(
  view: Buffer,
  start: number,
  end: number,
  meter: WorkMeter
): boolean {
  let cursor = start;
  while (cursor < end) {
    if (cursor + ISO_HEADER_BYTES > end) return false;
    const size = view.readUInt32BE(cursor);
    if (size < ISO_HEADER_BYTES || cursor + size > end) return false;
    cursor += size;
    meter.charge(1);
  }
  return true;
}

/**
 * The compressor name goes to zero, and nothing else in the entry moves.
 *
 * A sample entry is required structure — it is what tells a decoder how to read
 * the coded payload — so retyping or blanking one leaves a file that keeps
 * every sample and plays none of them. The muxer's banner rides in a fixed
 * free-text field inside it, and that field is the whole of what may go.
 *
 * `undefined` where the fixed block is not where the format puts it, which is
 * a refusal rather than a best effort: the alternative is zeroing thirty-two
 * bytes of somebody's codec configuration on a guess.
 */
function isoClearedCompressorName(
  view: Buffer,
  target: Target,
  meter: WorkMeter
): ByteEdit | undefined {
  const bodyStart = target.offset + isoHeaderBytes(view, target.offset);
  const bodyEnd = target.offset + target.length;
  if (bodyEnd - bodyStart < ISO_VISUAL_ENTRY_BYTES) return undefined;
  const start = bodyStart + ISO_COMPRESSOR_NAME_OFFSET;
  if (view.readUInt8(start) > ISO_COMPRESSOR_NAME_MAX) return undefined;
  if (view.readUInt16BE(bodyStart + ISO_VISUAL_ENTRY_BYTES - 2) !== ISO_VISUAL_PRE_DEFINED) {
    return undefined;
  }
  if (!isoEntryChildrenChain(view, bodyStart + ISO_VISUAL_ENTRY_BYTES, bodyEnd, meter)) {
    return undefined;
  }
  return {
    start,
    end: start + ISO_COMPRESSOR_NAME_BYTES,
    data: new Uint8Array(ISO_COMPRESSOR_NAME_BYTES),
    reason: `cleared the ${target.kind} compressor name`,
  };
}

/** The creation and modification words go to zero, which the format reads as unset. */
function isoZeroedTimes(view: Buffer, target: Target): ByteEdit {
  const bodyStart = target.offset + isoHeaderBytes(view, target.offset);
  const width = view.readUInt8(bodyStart) === 1 ? 8 : 4;
  const start = bodyStart + ISO_FULL_BOX_PREFIX_BYTES;
  return {
    start,
    end: start + width * 2,
    data: new Uint8Array(width * 2),
    reason: `zeroed the ${target.kind} creation and modification times`,
  };
}

/** The edit a reported box gets, or the reason nothing may be written over it. */
type IsoBoxPlan = { readonly edit: ByteEdit } | { readonly refusal: string };

/**
 * Which remedy a reported box gets.
 *
 * The split that matters is between a box whose *presence* is the disclosure
 * and one the container needs: the first goes wholesale, the second keeps
 * everything but the field that discloses. A box this parser recognised as
 * nothing is neither — it may be structure the container cannot do without, so
 * it is refused rather than guessed at.
 */
function isoBoxEdit(view: Buffer, target: Target, meter: WorkMeter): IsoBoxPlan {
  if (ISO_TIME_KINDS.has(target.kind)) return { edit: isoZeroedTimes(view, target) };
  if (target.kind === ISO_SAMPLE_ENTRY_KIND) {
    const edit = isoClearedCompressorName(view, target, meter);
    return edit === undefined ? { refusal: SAMPLE_ENTRY_SHAPE } : { edit };
  }
  if (UNNAMED_REGION_KINDS.has(target.kind)) return { refusal: UNNAMED_REGION_SHAPE };
  return { edit: isoFreeBox(view, target) };
}

const stripIsoBmff: Remedy = (input) => {
  const { view, targets, meter } = input;
  const coded = stripBitstream(input);
  if (coded.refusal !== undefined) return { edits: [], refusal: coded.refusal };
  const boxes = targets.filter((target) => !isBitstreamTarget(target));
  if (boxes.some((target) => !isoOpensUnit(view, target))) {
    return { edits: [], refusal: NOT_A_UNIT_SHAPE };
  }
  const edits: ByteEdit[] = [];
  for (const target of boxes) {
    const planned = isoBoxEdit(view, target, meter);
    if ('refusal' in planned) return { edits: [], refusal: planned.refusal };
    edits.push(planned.edit);
  }
  return { edits: [...edits, ...coded.edits], excluded: coded.excluded, meter };
};

/** EBML's own "ignore these bytes" element. */
export const MATROSKA_VOID_ID = 0xec;
const MATROSKA_MAX_VINT_BYTES = 8;

/** A big-endian size whose leading marker bit encodes its own width. */
function ebmlSizeVint(width: number, value: number): Uint8Array {
  const out = new Uint8Array(width);
  let left = value;
  for (let index = width - 1; index >= 1; index--) {
    out[index] = left & 0xff;
    left = Math.floor(left / 0x1_00);
  }
  out[0] = (left & 0xff) | (0x80 >> (width - 1));
  return out;
}

/**
 * A void element occupying exactly `length` bytes.
 *
 * Same length, because a cue or a seek head elsewhere in the segment may address
 * a later element by absolute position; shrinking one silently invalidates them.
 * The size field is widened rather than the body shortened, which is what makes
 * an exact fit always available.
 */
function matroskaVoid(length: number): Uint8Array {
  for (let width = 1; width <= MATROSKA_MAX_VINT_BYTES; width++) {
    const body = length - 1 - width;
    if (body >= 0 && body <= 2 ** (7 * width) - 2) {
      const out = new Uint8Array(length);
      out[0] = MATROSKA_VOID_ID;
      out.set(ebmlSizeVint(width, body), 1);
      return out;
    }
  }
  /* v8 ignore next -- an element is at least an id byte and a size byte, so the one-byte width always fits */
  throw new Error(`No void element fits ${String(length)} bytes.`);
}

const stripMatroska: Remedy = ({ targets }) => {
  if (targets.some((target) => UNNAMED_REGION_KINDS.has(target.kind))) {
    return { edits: [], refusal: UNNAMED_REGION_SHAPE };
  }
  const edits = targets.map((target) => ({
    start: target.offset,
    end: target.offset + target.length,
    data: matroskaVoid(target.length),
    reason: `replaced the ${target.kind} element with a void element of the same size`,
  }));
  // Matroska's content proof is "nothing outside these moved", so the rewritten
  // elements are the spans the whole-blob comparison excludes.
  return { edits, excluded: edits.map((edit) => ({ start: edit.start, end: edit.end })) };
};

// The block-header width and the last-block flag are derived a second time
// by the detector's own metadata-block walk, and the two derivations must
// agree: if either side moves, the padding this remedy writes lands over
// the wrong bytes, or the block chain runs on into the audio. Collapsing
// them onto one export is recorded follow-up work; until then the
// agreement is held by this note and nothing else.
const FLAC_BLOCK_HEADER_BYTES = 4;
const FLAC_LAST_BLOCK_FLAG = 0x80;
const FLAC_TYPE_PADDING = 1;

/**
 * A metadata block becomes padding of exactly its own length.
 *
 * Blanking the comment's payload would not do: the detector reports a comment
 * block for existing at all, because a vendor string is a toolchain name whether
 * or not anything is written under it. Padding is the format's own filler, so
 * the bytes stay where they are and no decoder notices.
 */
function flacPaddingBlock(view: Buffer, target: Target): ByteEdit {
  const data = new Uint8Array(target.length);
  // The last-block flag rides in the same byte as the type; losing it would run
  // the block chain straight into the audio.
  data[0] = (view.readUInt8(target.offset) & FLAC_LAST_BLOCK_FLAG) | FLAC_TYPE_PADDING;
  data.set(view.subarray(target.offset + 1, target.offset + FLAC_BLOCK_HEADER_BYTES), 1);
  return {
    start: target.offset,
    end: target.offset + target.length,
    data,
    reason: `turned the ${target.kind} block into padding`,
  };
}

const stripFlac: Remedy = (input) => {
  const { bytes, view, targets, meter } = input;
  const coded = stripBitstream(input);
  if (coded.refusal !== undefined) return { edits: [], refusal: coded.refusal };
  if (targets.some((target) => UNNAMED_REGION_KINDS.has(target.kind))) {
    return { edits: [], refusal: UNNAMED_REGION_SHAPE };
  }
  const edits: ByteEdit[] = [];
  let taggedPrefix = false;
  for (const target of targets) {
    if (isBitstreamTarget(target)) continue;
    if (target.kind.startsWith('id3:')) {
      taggedPrefix = true;
      continue;
    }
    edits.push(flacPaddingBlock(view, target));
  }
  // An ID3 tag in front of a FLAC stream belongs to neither format; the whole
  // prefix goes rather than its reportable frames, and the stream underneath is
  // exactly what it was.
  if (taggedPrefix) {
    edits.push({
      start: 0,
      end: id3TagLength(bytes),
      data: new Uint8Array(0),
      reason: 'dropped the ID3 prefix in front of the stream',
    });
  }
  return { edits: [...edits, ...coded.edits], excluded: coded.excluded, meter };
};

// The footer flag, the footer's length and the offset the flags sit at are
// derived again in the detector's own tag reader (`id3TagLength`, whose result
// this remedy also consumes). They must agree: if one side moves, the padding
// that restores the tag to its declared size lands at the wrong place, and the
// coded frames behind it shift. Collapsing the pair onto one export is recorded
// follow-up work; until then this note is the coupling.
const ID3_FOOTER_FLAG = 0x10;
const ID3_FOOTER_BYTES = 10;
const ID3_FLAGS_OFFSET = 5;

/**
 * Reportable frames are cut out and the tag is padded back to its declared size.
 *
 * Overwriting a frame in place would be simpler and would be a hole: the frame
 * walk stops at the first id that is not four upper-case characters, so a zeroed
 * frame hides every frame behind it — the detector goes quiet while the bytes
 * stay. Compaction actually removes them, and the padding keeps the coded frames
 * at the offset they were already at.
 */
const stripId3: Remedy = (input) => {
  const { bytes, view, targets, meter } = input;
  const coded = stripBitstream(input);
  if (coded.refusal !== undefined) return { edits: [], refusal: coded.refusal };
  const frames = targets.filter((target) => !isBitstreamTarget(target));
  if (frames.length === 0) {
    return { edits: coded.edits, excluded: coded.excluded, meter };
  }
  const dropped = frames.map((target) => ({
    start: target.offset,
    end: target.offset + target.length,
    data: new Uint8Array(0),
    reason: `dropped the ${target.kind} frame`,
  }));
  const hasFooter = (view.readUInt8(ID3_FLAGS_OFFSET) & ID3_FOOTER_FLAG) !== 0;
  const bodyEnd = id3TagLength(bytes) - (hasFooter ? ID3_FOOTER_BYTES : 0);
  const removed = dropped.reduce((sum, edit) => sum + (edit.end - edit.start), 0);
  return {
    edits: [
      ...dropped,
      {
        start: bodyEnd,
        end: bodyEnd,
        data: new Uint8Array(removed),
        reason: 'padded the tag back to its declared size',
      },
      ...coded.edits,
    ],
    excluded: coded.excluded,
    meter,
  };
};

/** Either a format has a remedy or it has a reason it has none — never both. */
export type Policy = { readonly remedy: Remedy } | { readonly unsupported: string };

/**
 * One row per registered container, which the type makes compulsory: a format
 * added to the detector's registry cannot reach this stripper without someone
 * writing down either its remedy or the reason it has none. A silent omission
 * would surface as a file reported clean by a tool that never looked at it.
 */
export const STRIP_POLICY: Record<BinaryFormatId, Policy> = {
  png: { remedy: stripPng },
  isobmff: { remedy: stripIsoBmff },
  matroska: { remedy: stripMatroska },
  flac: { remedy: stripFlac },
  mp3: { remedy: stripId3 },
  woff2: {
    unsupported:
      'the dates sit inside the brotli-compressed table stream, so removing them means ' +
      're-compressing that stream — the one thing a lossless strip may not do',
  },
  zip: {
    unsupported:
      'an entry time is recorded in both the central directory and the entry’s own local ' +
      'header, and rewriting only the copy the detector reads would clear the finding while ' +
      'the other copy stayed',
  },
  gif: {
    unsupported:
      'no content-stream locator is defined for the format here, so a strip could not be ' +
      'shown to have left the image data where it was',
  },
  riff: {
    unsupported:
      'no content-stream locator is defined for the format here, so a strip could not be ' +
      'shown to have left the sample data where it was',
  },
  ico: {
    unsupported:
      'the directory addresses each embedded image by offset and size, so a chunk dropped ' +
      'inside one invalidates every entry behind it',
  },
};

/** The container's coded-payload ranges; empty for a format that declares none. */
function codedRanges(format: BinaryFormat, bytes: Uint8Array): readonly ScanRange[] {
  return format.scanRanges?.(bytes) ?? [];
}

interface NothingApplied {
  readonly file: string;
  readonly format: BinaryFormatId | 'unknown';
  readonly bytes: Uint8Array;
  readonly status: StripStatus;
  readonly reasons: readonly string[];
  readonly walkedBytes?: number;
  readonly described?: readonly ByteSpan[];
}

/** A result carrying no edits, for every path that decided not to make any. */
function nothingApplied(input: NothingApplied): StripResult {
  return {
    ...input,
    walkedBytes: input.walkedBytes ?? 0,
    describedRegions: input.described ?? [],
    edits: [],
    contentExclusions: [],
    contentDigest: '',
  };
}

/**
 * The result for a blob whose framing the gate could not read, or `undefined`
 * when the strip may go on.
 *
 * A refusal is a stop rather than a pass: any edit derived from a reading that
 * could not complete would come from a partial view of the file.
 */
function refusalFor(
  file: string,
  bytes: Uint8Array,
  format: BinaryFormat,
  findings: readonly BinaryFinding[]
): StripResult | undefined {
  const refusals = findings.filter((finding) => REFUSING_RULES.has(finding.rule));
  if (refusals.length === 0) return undefined;
  return nothingApplied({
    file,
    format: format.id,
    bytes,
    status: 'refused',
    reasons: refusals.map((finding) => `${finding.kind}: ${finding.shape}`),
  });
}

/**
 * The lossless strip of one blob.
 *
 * Nothing is written by this function — it returns the bytes a caller may write,
 * and only when the strip both removed every finding and left the container's
 * content byte-identical.
 */
export function stripBinaryBlob(file: string, bytes: Uint8Array): StripResult {
  const format = detectBinaryFormat(bytes);
  if (format === undefined) {
    return nothingApplied({
      file,
      format: 'unknown',
      bytes,
      status: 'refused',
      reasons: ['the bytes match no registered container format, so nothing examined them'],
    });
  }
  const findings = scanBinaryBlob(file, bytes);
  const refused = refusalFor(file, bytes, format, findings);
  if (refused !== undefined) return refused;
  const notes = findings
    .filter((finding) => REPORT_ONLY_RULES.has(finding.rule))
    .map((finding) => finding.shape);
  const policy = STRIP_POLICY[format.id];
  if (!('remedy' in policy)) {
    const nothingToDo = findings.length === 0;
    return nothingApplied({
      file,
      format: format.id,
      bytes,
      status: nothingToDo ? 'clean' : 'unsupported',
      reasons: nothingToDo ? notes : [...notes, `${format.label}: ${policy.unsupported}`],
    });
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const targets = targetsOf(findings);
  const plan = policy.remedy({
    bytes,
    view,
    format,
    ranges: codedRanges(format, bytes),
    targets,
    meter: new WorkMeter(),
  });
  return applyPlan({
    file,
    format: format.id,
    bytes,
    plan,
    notes,
    described: describedSpans(targets),
  });
}

interface PlanOutcome {
  readonly file: string;
  readonly format: BinaryFormatId;
  readonly bytes: Uint8Array;
  readonly plan: RemedyPlan;
  readonly notes: readonly string[];
  /** Read off the detector's findings, so no remedy can narrow its own proof. */
  readonly described: readonly ByteSpan[];
}

/** Turns a remedy's plan into a result: a refusal, nothing to do, or a verified strip. */
function applyPlan(outcome: PlanOutcome): StripResult {
  const { file, format, bytes, plan, notes, described } = outcome;
  if (plan.refusal !== undefined) {
    return nothingApplied({
      file,
      format,
      bytes,
      status: 'refused',
      reasons: [...notes, plan.refusal],
      described,
    });
  }
  if (plan.edits.length === 0) {
    // Nothing to edit, but a note left standing is still a job for a person —
    // the one note there can be is a rename, which no byte edit performs.
    const status = notes.length > 0 ? 'incomplete' : 'clean';
    return nothingApplied({ file, format, bytes, status, reasons: notes, described });
  }
  return verifiedStrip({
    file,
    format,
    bytes,
    edits: plan.edits,
    excluded: plan.excluded,
    meter: plan.meter,
    notes,
    described,
  });
}

/**
 * Throws unless the container's content bytes came through the strip identical.
 *
 * Loud on purpose, and loud before anything is written. A remedy that quietly
 * re-encoded its carrier would trade image or audio quality for a privacy fix,
 * and no gate downstream of here measures that — this is the only place it can
 * be caught.
 */
interface ContentProof {
  readonly file: string;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
  /** Content-stream spans the remedy rewrote, set aside from the comparison. */
  readonly excluded?: readonly ByteSpan[];
  /** Charges the proof's own stepping; a caller proving one blob may omit it. */
  readonly meter?: WorkMeter;
}

export function assertContentPreserved(proof: ContentProof): string {
  const { file, before, after } = proof;
  const excluded = proof.excluded ?? [];
  assertProofIsNotHollow(file, before, excluded, proof.meter ?? new WorkMeter());
  const source = contentHash(before, excluded);
  const result = contentHash(after, excluded);
  if (source !== undefined && source === result) return source;
  throw new Error(
    `Stripping ${file} did not leave the container's content bytes identical. ` +
      `A privacy remedy may never re-encode what it is cleaning, so nothing was written.`
  );
}

/**
 * Regions a remedy may clear a disclosing field inside, and must never remove,
 * retype or blank: the container reads them to describe its own content, so a
 * file that keeps every content byte while losing one of these no longer plays.
 *
 * The proof below reads this table and the detector's findings, never a
 * remedy's own declaration — which is the whole of why it works. A remedy that
 * destroys one of these is caught by a check it took no part in, and the
 * content proof beside it cannot help: that one compares the coded payload,
 * and every region named here sits outside it.
 *
 * The unrecognised regions join them on the opposite evidence. The rest are here
 * because this module can say what the container reads them for; those are here
 * because nothing can, and a region whose role cannot be stated is the one whose
 * loss cannot be priced. Both memberships bind a remedy the same way, so the
 * proof means for the older members exactly what it meant before. The two sets
 * are spread rather than restated so a parser that gains a refusal cannot fail
 * to gain the proof that pins it.
 */
const CONTENT_DESCRIBING_KINDS: ReadonlySet<string> = new Set([
  ...ISO_TIME_KINDS,
  ISO_SAMPLE_ENTRY_KIND,
  ...UNNAMED_REGION_KINDS,
]);

/**
 * A width that no framing a described region can open with exceeds, in a
 * container whose own framing width this module does not read.
 *
 * The bound is taken rather than re-derived: computing it from a format's
 * framing rules would put a second copy of those rules here, free to drift from
 * the walk that owns them. So it is set wide enough for every framing those
 * walks report — and it is wrong, permissive exactly where the window it feeds
 * is meant to refuse, the moment one of them can report a wider one.
 */
const MAX_UNREAD_FRAMING_BYTES = 16;

/**
 * The bytes at a described region's head that its container reads to find and
 * name the unit — the window no remedy may write into.
 *
 * An ISO box declares its own header width in its size field, so the window is
 * read there and is exact. It has to be: a header box's times sit close enough
 * behind a narrow box's header that a window sized to cover the framings this
 * module cannot read would cover them too, and refuse the remedy that
 * legitimately clears them — so no one width serves a format that declares its
 * framing and a format that does not. Everywhere else the window is that
 * covering bound, so it errs toward refusing, which is the direction a
 * fail-closed guard wants — and the direction one shared width did not err in: a
 * width narrow enough to spare that remedy is narrower than the widest framing a
 * described region can open with, so every framing wider than it kept its tail
 * rewritable, the container whose narrowest form that width matched exactly
 * included.
 */
function describedFramingBytes(format: BinaryFormatId, view: Buffer, start: number): number {
  return format === 'isobmff' ? isoHeaderBytes(view, start) : MAX_UNREAD_FRAMING_BYTES;
}

/**
 * The largest share of a content-describing region one strip may overwrite.
 *
 * Clearing a disclosing field leaves the region standing; replacing most of one
 * replaces the region. The widest field any remedy here clears is the
 * thirty-two-byte compressor name inside a sample entry of at least eighty-six,
 * so a half is a boundary with headroom rather than a number fitted to today's
 * remedies.
 */
const MAX_DESCRIBED_EDIT_DIVISOR = 2;

/** The spans a strip must prove it only cleared a field inside. */
function describedSpans(targets: readonly Target[]): ByteSpan[] {
  return targets
    .filter((target) => CONTENT_DESCRIBING_KINDS.has(target.kind))
    .map((target) => ({ start: target.offset, end: target.offset + target.length }));
}

/**
 * Throws unless every region a remedy had to leave standing survived as one.
 *
 * The content proof cannot stand in for this. It compares the coded payload,
 * and a container that still holds every sample but has lost the description of
 * how to decode them passes it while playing nothing — which is exactly how a
 * remedy came to blank a codec configuration and report success.
 *
 * The blob and its format come along because the framing window is per format,
 * and for one of them per region: only the bytes say how wide a box's header is.
 */
interface DescriptionProof {
  readonly file: string;
  readonly format: BinaryFormatId;
  readonly bytes: Uint8Array;
  /** Read off the detector's findings, so no remedy can narrow its own proof. */
  readonly described: readonly ByteSpan[];
  readonly edits: readonly ByteEdit[];
  readonly meter: WorkMeter;
}

function assertDescriptionPreserved(proof: DescriptionProof): void {
  const { file, format, bytes, described, edits, meter } = proof;
  if (described.length === 0) return;
  meter.charge(described.length + edits.length);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const written = edits.map((edit) => ({ start: edit.start, end: edit.end }));
  for (const region of described) {
    const framing = {
      start: region.start,
      end: region.start + describedFramingBytes(format, view, region.start),
    };
    if (overlappingBytes([framing], written) > 0) {
      throw new Error(
        `Stripping ${file} would rewrite the framing of a region no remedy here may ` +
          `replace, so nothing was written.`
      );
    }
    if (
      overlappingBytes([region], written) * MAX_DESCRIBED_EDIT_DIVISOR >
      region.end - region.start
    ) {
      throw new Error(
        `Stripping ${file} would overwrite more of a region no remedy here may replace than ` +
          `a disclosing field inside one, so nothing was written.`
      );
    }
  }
}

/**
 * The largest share of a container's located content one remedy may carve out
 * of its own proof, as a divisor.
 *
 * Two remedies exclude: the in-payload one, and the element rewrite whose
 * located content is the whole blob and which therefore sits under this same
 * bound. On real files both carve out tens to hundreds of bytes, against
 * located content measured in megabytes for the first and in whole files for
 * the second, so a quarter is generous for either while still being a bound —
 * and a bound is the point: a proof allowed to exclude an unbounded share of
 * what it proves is a proof of nothing, which is how the digest of zero bytes
 * came to compare equal to itself one line further down.
 */
const MAX_EXCLUDED_CONTENT_DIVISOR = 4;

function assertProofIsNotHollow(
  file: string,
  before: Uint8Array,
  excluded: readonly ByteSpan[],
  meter: WorkMeter
): void {
  const located = contentSpans(before);
  if (located === undefined) return;
  // The proof's own stepping is charged: it walks the located spans against the
  // excluded ones, and a container declares both counts.
  meter.charge(located.length + excluded.length);
  if (meter.spent) {
    throw new Error(
      `Proving ${file} unchanged would cost more work than one blob is allowed ` +
        `to spend, so nothing was written.`
    );
  }
  const locatedBytes = totalSpanBytes(located);
  const carvedOut = overlappingBytes(located, excluded);
  if (carvedOut * MAX_EXCLUDED_CONTENT_DIVISOR <= locatedBytes) return;
  throw new Error(
    `Stripping ${file} would set aside too large a share of the content it is ` +
      `supposed to be proving unchanged, so nothing was written.`
  );
}

/**
 * Applies the edits and proves the two properties a strip has to hold: the
 * detector reports nothing it can act on, and the container's content survived
 * byte for byte.
 *
 * A remedy that leaves a finding standing yields `incomplete` and the original
 * bytes. That is the net under every future remedy: half a strip that reported
 * success would put a file back in the tree looking cleaned.
 */
interface VerifiedStripInput {
  readonly file: string;
  readonly format: BinaryFormatId;
  readonly bytes: Uint8Array;
  readonly edits: readonly ByteEdit[];
  /** Content-stream spans this strip rewrote and the comparison must set aside. */
  readonly excluded?: readonly ByteSpan[] | undefined;
  /** Carries the remedy's own charge into the proof, so one blob has one budget. */
  readonly meter?: WorkMeter | undefined;
  /** Findings no byte edit can resolve, carried into the result's reasons. */
  readonly notes?: readonly string[];
  /**
   * Regions the container reads to describe its own content, which this strip
   * has to leave standing. Derived from the detector's findings by the caller,
   * never from what the remedy says it did.
   */
  readonly described?: readonly ByteSpan[] | undefined;
}

const SHIFTED_EXCLUSION_SHAPE =
  'the strip moves bytes ahead of a span the content proof sets aside, so the two sides of ' +
  'that proof would not be read in the same coordinates';

const LOST_IDENTITY_SHAPE =
  'the stripped bytes no longer read as the container the file arrived as, so the remedy would ' +
  'have changed what the file is rather than what it discloses';

/**
 * The reason a strip cannot be proved, when its own edits move the bytes an
 * exclusion is expressed in.
 *
 * Exclusions are offsets into the blob as it arrived; the proof reads them
 * against the blob as it leaves. A remedy that only rewrites in place keeps the
 * two readings aligned, but one that drops bytes ahead of an excluded span does
 * not, and the digests then differ for a reason that has nothing to do with
 * re-encoding. Naming it here is the difference between sending a person after
 * a re-encode that never happened and telling them what actually stopped the
 * strip.
 */
function shiftedExclusion(
  edits: readonly ByteEdit[],
  excluded: readonly ByteSpan[]
): string | undefined {
  if (excluded.length === 0) return undefined;
  const first = Math.min(...excluded.map((span) => span.start));
  const moved = edits
    .filter((edit) => edit.end <= first)
    .reduce((sum, edit) => sum + edit.data.length - (edit.end - edit.start), 0);
  return moved === 0 ? undefined : SHIFTED_EXCLUSION_SHAPE;
}

export function verifiedStrip(input: VerifiedStripInput): StripResult {
  const { file, format, bytes, edits } = input;
  const described = input.described ?? [];
  const excluded = input.excluded ?? [];
  const notes = input.notes ?? [];
  const meter = input.meter ?? new WorkMeter();
  const shifted = shiftedExclusion(edits, excluded);
  if (shifted !== undefined) {
    return nothingApplied({
      file,
      format,
      bytes,
      status: 'refused',
      reasons: [...notes, shifted],
      described,
    });
  }
  assertDescriptionPreserved({ file, format, bytes, described, edits, meter });
  const out = applyByteEdits(bytes, edits);
  if (detectBinaryFormat(out)?.id !== format) {
    return nothingApplied({
      file,
      format,
      bytes,
      status: 'refused',
      reasons: [...notes, LOST_IDENTITY_SHAPE],
      described,
    });
  }
  const digest = assertContentPreserved({ file, before: bytes, after: out, excluded, meter });
  const remaining = scanBinaryBlob(file, out).filter(
    (finding) => !REPORT_ONLY_RULES.has(finding.rule)
  );
  if (remaining.length > 0) {
    return {
      file,
      format,
      status: 'incomplete',
      bytes,
      edits,
      contentExclusions: excluded,
      describedRegions: described,
      contentDigest: '',
      walkedBytes: meter.walked,
      reasons: [
        ...notes,
        ...remaining.map((finding) => `${finding.kind}: ${finding.shape} still present`),
      ],
    };
  }
  return {
    file,
    format,
    status: 'stripped',
    bytes: out,
    edits,
    contentExclusions: excluded,
    describedRegions: described,
    contentDigest: digest,
    walkedBytes: meter.walked,
    reasons: notes,
  };
}
