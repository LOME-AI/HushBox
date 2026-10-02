/**
 * The vocabulary a strip is planned in: the byte edits a remedy produces, the
 * regions it is handed, and the meter that bounds the walking it may do.
 */
import type { ByteSpan } from '../binary-content.js';
import type { BinaryFormat, ScanRange } from './format-registry.js';
import type { BinaryFinding, BinaryRule } from './scan.js';

export interface ByteEdit {
  readonly start: number;
  readonly end: number;
  /** What replaces `[start, end)`. Empty drops the span. */
  readonly data: Uint8Array;
  /** What the edit does, for the report. Never file content. */
  readonly reason: string;
}

/**
 * Rebuilds `bytes` with each edit's span replaced by its own bytes.
 *
 * Overlapping edits throw rather than resolving by position, because an overlap
 * means two remedies claimed the same bytes and only one of them can be right.
 */
export function applyByteEdits(bytes: Uint8Array, edits: readonly ByteEdit[]): Uint8Array {
  const ordered = edits.toSorted((left, right) => left.start - right.start);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      throw new Error(
        `Two strip edits overlap at byte ${String(edit.start)} (${edit.reason}); ` +
          `one of the remedies is claiming bytes that are not its own.`
      );
    }
    parts.push(bytes.subarray(cursor, edit.start), edit.data);
    cursor = edit.end;
  }
  parts.push(bytes.subarray(cursor));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A misnamed file is reported and still stripped: the remedy is a rename, which
 * is a human's call and not a byte edit, so it must not block the metadata work
 * and must not be mistaken for an incomplete strip afterwards.
 */
export const REPORT_ONLY_RULES: ReadonlySet<BinaryRule> = new Set(['extension-mismatch']);

/** One entry per region the findings name, deduplicated across a region's rules. */
export interface Target {
  readonly kind: string;
  readonly offset: number;
  readonly length: number;
}

export function targetsOf(findings: readonly BinaryFinding[]): Target[] {
  const seen = new Map<string, Target>();
  for (const finding of findings) {
    if (REPORT_ONLY_RULES.has(finding.rule)) continue;
    const key = `${finding.kind}:${String(finding.offset)}:${String(finding.length)}`;
    if (!seen.has(key)) {
      seen.set(key, { kind: finding.kind, offset: finding.offset, length: finding.length });
    }
  }
  return [...seen.values()];
}

export interface RemedyInput {
  readonly bytes: Uint8Array;
  readonly view: Buffer;
  readonly format: BinaryFormat;
  /** The container's coded-payload ranges; empty for a format that declares none. */
  readonly ranges: readonly ScanRange[];
  readonly targets: readonly Target[];
  /** Charges the byte-stepping a remedy does over bytes it did not write. */
  readonly meter: WorkMeter;
}

export interface RemedyPlan {
  readonly edits: readonly ByteEdit[];
  /** The meter the remedy spent, so the proof continues the same budget. */
  readonly meter?: WorkMeter;
  /** Set when the remedy declined to plan at all; the strip refuses and writes nothing. */
  readonly refusal?: string;
  /**
   * Spans the remedy rewrote *inside* the content stream. One remedy has to:
   * an encoder's build banner rides in the coded payload, so the strongest
   * available proof there is that every coded byte outside these is identical.
   */
  readonly excluded?: readonly ByteSpan[];
}

export type Remedy = (input: RemedyInput) => RemedyPlan;

/** A whole chunk goes, header and CRC with it; PNG declares no offsets to fix up. */

/**
 * The bytes this module may step over on one blob's behalf before it gives up.
 *
 * What is charged is the byte-at-a-time stepping this module performs — the
 * candidate scan behind an occurrence, the printable run in front of it, and the
 * merge that builds the content proof. Native substring search is deliberately
 * not charged: it is linear in the blob and already bounded by the blob's own
 * size, and folding it in would put the budget out of reach of any fixture that
 * could pin it.
 *
 * The costliest real file in this repository charges 4257 bytes, so the ceiling
 * is roughly two hundred and fifty times measured need.
 */
const MAX_STRIP_WALKED_BYTES = 1_048_576;

/** Charges the byte-stepping this module does itself, so a blob cannot buy unbounded work. */
export class WorkMeter {
  #walked = 0;

  /** Bytes charged so far, so a caller can pin the budget at its own resolution. */
  get walked(): number {
    return this.#walked;
  }

  get spent(): boolean {
    return this.#walked > MAX_STRIP_WALKED_BYTES;
  }

  charge(bytes: number): void {
    this.#walked += bytes;
  }
}

/** A fresh meter, for a caller exercising one span rule on its own. */
export function newWorkMeter(): WorkMeter {
  return new WorkMeter();
}
