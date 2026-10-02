import path from 'node:path';

import { detectBinaryFormat } from './format-registry.js';
import { detectLeakValues, scanBitstreamLiterals } from './leak-values.js';
import { MAX_SWEPT_BYTES, RegionCollector } from './region.js';
import { isDayBoundarySeconds } from '../instants.js';
import type { BinaryFormat, BinaryFormatId, ScanRange } from './format-registry.js';
import type { LeakRule } from './leak-values.js';
import type { PrivacyAllowlistEntry } from '../allowlist.js';
import type { MetadataRegion } from './region.js';

export type BinaryRule =
  | LeakRule
  | 'metadata-carrier'
  | 'timestamp-field'
  | 'unparseable-structure'
  | 'extension-mismatch'
  | 'unrecognized-format';

export interface BinaryFinding {
  readonly file: string;
  readonly format: BinaryFormatId | 'unknown';
  /** The region's structural id, or the empty string for whole-file findings. */
  readonly kind: string;
  /** Where in the container the finding sits. Never file-controlled bytes. */
  readonly location: string;
  readonly rule: BinaryRule;
  /** Describes the disclosure. Never contains the disclosed value. */
  readonly shape: string;
  readonly offset: number;
  readonly length: number;
}

export type BinaryVerdict = 'clean' | 'exempt' | 'dirty';

interface BinaryClassification {
  readonly verdict: BinaryVerdict;
  readonly findings: readonly BinaryFinding[];
}

/** git's own heuristic: a NUL byte early in the blob means this is not text. */
const BINARY_SNIFF_BYTES = 8000;

export function isBinaryBlob(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function regionFindings(
  file: string,
  format: BinaryFormat,
  region: MetadataRegion
): BinaryFinding[] {
  const base = {
    file,
    format: format.id,
    kind: region.kind,
    location: region.location,
    offset: region.offset,
    length: region.length,
  } as const;
  const findings: BinaryFinding[] = [];
  if (region.malformed !== undefined) {
    findings.push({ ...base, rule: 'unparseable-structure', shape: region.malformed });
  }
  if (region.carriesIdentity) {
    findings.push({
      ...base,
      rule: 'metadata-carrier',
      shape: `${format.label} metadata region disclosing the authoring toolchain`,
    });
  }
  for (const instant of region.instants) {
    if (isDayBoundarySeconds(instant.secondsUtc)) continue;
    findings.push({
      ...base,
      rule: 'timestamp-field',
      shape: `${instant.field} field at second resolution`,
    });
  }
  for (const leak of detectLeakValues(region.text)) {
    findings.push({ ...base, rule: leak.rule, shape: leak.shape });
  }
  return findings;
}

function extensionFinding(
  file: string,
  format: BinaryFormat,
  bytes: Uint8Array
): BinaryFinding | undefined {
  const extension = path.posix.extname(normalizePath(file)).toLowerCase();
  if (extension === '' || format.extensions.includes(extension)) return undefined;
  return {
    file,
    format: format.id,
    kind: '',
    location: '',
    rule: 'extension-mismatch',
    shape: `named as ${extension} but the magic bytes are a ${format.label}`,
    offset: 0,
    length: bytes.length,
  };
}

function normalizePath(file: string): string {
  return file.replaceAll('\\', '/');
}

/**
 * Known toolchain literals inside a container's coded payload, metered.
 *
 * The sweep spends a per-blob budget of its own. A payload that yields no hit
 * still costs its length to search, so the region budget — which counts results
 * — cannot bound it, and the ranges come out of a structure table the file
 * controls. Each range is charged *before* it is searched and the loop stops on
 * the charge that spends the budget, so the range that went over is never swept
 * and neither is anything behind it.
 *
 * The ranges are handed in rather than read off the format, because the meter is
 * unreachable through any producer the registry holds today: all of them emit
 * disjoint spans inside the blob, so only a range that over-declares can spend
 * the ceiling, and that is the case worth pinning.
 */
export function sweepCodedPayload(
  file: string,
  format: BinaryFormat,
  bytes: Uint8Array,
  ranges: readonly ScanRange[]
): BinaryFinding[] {
  const sweep = new RegionCollector(MAX_SWEPT_BYTES);
  const findings: BinaryFinding[] = [];
  for (const range of ranges) {
    sweep.chargeWork(range.end - range.start);
    if (sweep.exhausted) break;
    for (const hit of scanBitstreamLiterals(bytes, range.start, range.end)) {
      findings.push({
        file,
        format: format.id,
        kind: `${format.id}:bitstream`,
        location: range.location,
        rule: 'toolchain-identity',
        shape: hit.shape,
        offset: hit.offset,
        length: 0,
      });
    }
  }
  for (const region of sweep.collect(bytes.length)) {
    findings.push(...regionFindings(file, format, region));
  }
  return findings;
}

/**
 * Every privacy finding in one binary blob: metadata regions its format
 * declares, values inside them, fixed-width timestamp fields, and toolchain
 * literals in the coded payload.
 *
 * A blob matching no registered format is reported rather than passed. Silence
 * on an unrecognized container is indistinguishable from silence on a clean
 * one, and only one of those is safe.
 */
export function scanBinaryBlob(file: string, bytes: Uint8Array): BinaryFinding[] {
  const format = detectBinaryFormat(bytes);
  if (format === undefined) {
    return [
      {
        file,
        format: 'unknown',
        kind: '',
        location: '',
        rule: 'unrecognized-format',
        shape: 'binary blob matching no registered container format',
        offset: 0,
        length: bytes.length,
      },
    ];
  }
  const findings: BinaryFinding[] = [];
  const mismatch = extensionFinding(file, format, bytes);
  if (mismatch !== undefined) findings.push(mismatch);
  for (const region of format.parse(bytes)) {
    findings.push(...regionFindings(file, format, region));
  }
  findings.push(...sweepCodedPayload(file, format, bytes, format.scanRanges?.(bytes) ?? []));
  return findings;
}

/**
 * Findings an exemption cannot absorb.
 *
 * An exemption is granted for a specific vendored artifact, and that
 * justification does not survive bytes that are not that artifact. Each of these
 * says the gate is not looking at what the entry named:
 *
 * - `unparseable-structure` — the gate could not read the content.
 * - `unrecognized-format` — the gate has no idea what the content is, which the
 *   allowlist would otherwise convert into a pass.
 * - `extension-mismatch` — the content is a *different* format. An entry granted
 *   for a font exempts a font; an image sitting at that path is not the artifact
 *   anyone approved, however well formed it is.
 *
 * The path is allowlisted; the bytes now at it are not the bytes anyone
 * approved, so a human decides rather than the verdict reading as a pass.
 */
const BLOCKS_EXEMPTION: ReadonlySet<BinaryRule> = new Set([
  'unparseable-structure',
  'unrecognized-format',
  'extension-mismatch',
]);

/**
 * Whether an entry is the binary form at all: it names neither a literal nor a
 * rule.
 *
 * A binary entry is literal-free by necessity — its disclosing values are
 * compressed or packed fields no literal could name — while a text entry
 * narrows an exemption to the exact strings a reviewer approved. One list feeds
 * both gates, so honouring a text entry's `path` here would silently widen that
 * reviewer's narrow exemption into a whole-file one. There is nothing on this
 * side to match a literal against, so the entry is refused instead.
 *
 * A rule-named entry pins nothing either, so literal-free alone hands it the
 * whole blob — and what its reviewer approved is one text rule on one path,
 * which is a different decision from exempting an artifact whole. Absence of
 * literals stopped being evidence of the binary form the moment that second
 * literal-free shape existed, so the shape is read off the entry rather than
 * inferred from what it lacks. Nothing re-asks either question when a path's
 * bytes later become a format this registry claims.
 *
 * Exported because the tracked-tree sweep asks the same question to decide which
 * entries are binary exemptions, and a second copy of it there is a copy that has
 * to be hand-corrected whenever this changes — which is how it went stale once.
 */
export function isBinaryExemption(entry: PrivacyAllowlistEntry): boolean {
  return entry.literals === undefined && entry.rule === undefined;
}

/** Whether an entry is the binary form and names this blob's path. */
function exempts(entry: PrivacyAllowlistEntry, file: string): boolean {
  return entry.path === file && isBinaryExemption(entry);
}

/**
 * The blob's verdict alongside its findings. `exempt` is deliberately distinct
 * from `clean`: an allowlisted artifact still discloses, and a report that
 * folded the two together would hide how much of the tree is admitted rather
 * than actually clean.
 *
 * `allowlist` is required rather than defaulted. The entries live in the
 * repository's one allowlist file, and a default would let a call site that
 * forgot to load it fall back to something staler — failing as `exempt` where
 * the answer is `dirty`, which is a silently widened hole rather than a crash.
 */
export function classifyBinaryBlob(
  file: string,
  bytes: Uint8Array,
  allowlist: readonly PrivacyAllowlistEntry[]
): BinaryClassification {
  const findings = scanBinaryBlob(file, bytes);
  if (findings.length === 0) return { verdict: 'clean', findings };
  if (findings.some((finding) => BLOCKS_EXEMPTION.has(finding.rule))) {
    return { verdict: 'dirty', findings };
  }
  const normalized = normalizePath(file);
  const allowed = allowlist.some((entry) => exempts(entry, normalized));
  return { verdict: allowed ? 'exempt' : 'dirty', findings };
}
