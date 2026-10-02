import { z } from 'zod';

import { textBoxesOf } from '../look/contract.js';
import { LOOK_TEXT_PREFIX } from '../look/text.js';
import { gateResult } from '../qa/gate.js';

import type { LookBox, TextBox } from '../look/contract.js';
import type { GateFailure, GateResult } from '../qa/gate.js';

/** An axis-aligned rectangle in composition pixels, from its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where copy may sit on the 1080×1920 frame: x 65–888, y 288–1248, the
 * intersection of the Meta Reels, YouTube Shorts and TikTok overlay zones.
 */
export const SAFE_BOX: Rect = { x: 65, y: 288, width: 823, height: 960 };

/** Whether `inner` lies wholly inside `outer`, edges included. */
export function insideRect(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function isFiniteRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value));
}

/**
 * Whether two rects share any area; rects that only touch along an edge do not.
 * A rect with a coordinate or size that is not a finite number counts as
 * overlapping, whatever its other axis says.
 */
export function overlaps(a: Rect, b: Rect): boolean {
  if (!isFiniteRect(a) || !isFiniteRect(b)) {
    return true;
  }
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

type CopyRole = Exclude<TextBox['role'], 'imagery'>;

/** The smallest size copy is set at, by role: headline and the end card's cta rows, then support. */
export const SIZE_FLOOR_PX: Readonly<Record<CopyRole, number>> = {
  headline: 84,
  cta: 84,
  support: 44,
};

/** A text box whose role is copy, which every layout rule holds. */
type CopyBox = TextBox & { role: CopyRole };

function isCopy(role: TextBox['role']): role is CopyRole {
  return role !== 'imagery';
}

function isCopyBox(text: TextBox): text is CopyBox {
  return isCopy(text.role);
}

const lineHeadSchema = z.object({ frame: z.int().nonnegative(), boxes: z.unknown() });

/** A `films-look-text:` console line read into its frame and boxes; null for any other line. */
export function parseLookTextLine(line: string): { frame: number; boxes: LookBox[] } | null {
  if (!line.startsWith(LOOK_TEXT_PREFIX)) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(line.slice(LOOK_TEXT_PREFIX.length));
  } catch (error) {
    throw new SyntaxError(`a look text line holds no JSON: ${line}`, { cause: error });
  }
  const head = lineHeadSchema.safeParse(body);
  if (!head.success) {
    throw new TypeError(
      `a look text line does not hold a frame and its boxes: ${line}\n${z.prettifyError(head.error)}`
    );
  }
  const { frame, boxes } = head.data;
  return { frame, boxes: textBoxesOf('a look text line', frame, boxes) };
}

/** A spec text row as the reading-time rule reads it: its id, its role and its frames `[from, to)`. */
interface TextRow {
  id: string;
  role: TextBox['role'];
  from: number;
  to: number;
}

/** What the claims gate reads: the spec's text rows and every rendered frame's text boxes. */
export interface ClaimsEvidence {
  rows: readonly TextRow[];
  frames: ReadonlyMap<number, readonly TextBox[]>;
}

type ClaimRule = 'safe-box' | 'overlap' | 'size-floor' | 'reading-time';

/** One rule broken by one text on one frame. */
interface FrameViolation {
  rule: ClaimRule;
  id: string;
  /** What else the rule names, so each pair of overlapping texts is one failure. */
  other: string;
  frame: number;
  detail: string;
}

function px(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function span(from: number, length: number): string {
  return `${px(from)}–${px(from + length)}`;
}

function describeRect(rect: Rect): string {
  return `x ${span(rect.x, rect.width)}, y ${span(rect.y, rect.height)}`;
}

function boxViolations(frame: number, text: CopyBox, copy: readonly CopyBox[]): FrameViolation[] {
  const violations: FrameViolation[] = [];
  const at = `at frame ${String(frame)}`;
  if (!insideRect(text.box, SAFE_BOX)) {
    violations.push({
      rule: 'safe-box',
      id: text.id,
      other: '',
      frame,
      detail: `${at} its box ${describeRect(text.box)} leaves the safe box ${describeRect(SAFE_BOX)}`,
    });
  }
  const floor = SIZE_FLOOR_PX[text.role];
  if (!Number.isFinite(text.fontSizePx) || text.fontSizePx < floor) {
    const cause = Number.isFinite(text.fontSizePx)
      ? `below ${String(floor)} px`
      : 'which is not a finite size';
    violations.push({
      rule: 'size-floor',
      id: text.id,
      other: '',
      frame,
      detail: `${at} a ${text.role} set at ${px(text.fontSizePx)} px, ${cause}`,
    });
  }
  for (const other of copy.slice(copy.indexOf(text) + 1)) {
    if (overlaps(text.box, other.box)) {
      violations.push({
        rule: 'overlap',
        id: text.id,
        other: other.id,
        frame,
        detail: `${at} its box overlaps the box of text "${other.id}"`,
      });
    }
  }
  return violations;
}

/** The frames as runs, `frame 4` or `frames 4–6, 9`. */
function frameRuns(frames: readonly number[]): string {
  const runs: [number, number][] = [];
  for (const frame of frames.toSorted((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last !== undefined && frame === last[1] + 1) {
      last[1] = frame;
    } else {
      runs.push([frame, frame]);
    }
  }
  const text = runs
    .map(([from, to]) => (from === to ? String(from) : `${String(from)}–${String(to)}`))
    .join(', ');
  return `${frames.length === 1 ? 'frame' : 'frames'} ${text}`;
}

function readingTimeFailure(
  filmId: string,
  row: TextRow,
  frames: ClaimsEvidence['frames']
): GateFailure | null {
  const length = row.to - row.from;
  const absent = Array.from({ length }, (_, index) => row.from + index).filter(
    (frame) => !(frames.get(frame) ?? []).some(({ id }) => id === row.id)
  );
  if (absent.length === 0) {
    return null;
  }
  return {
    filmId,
    rule: 'reading-time',
    at: `${frameRuns(absent)}, text "${row.id}"`,
    detail: `absent from ${String(absent.length)} of the ${String(length)} frames of its span, frames ${String(row.from)}–${String(row.to - 1)}`,
  };
}

/** Each rule and text's violations as one failure, naming every frame it broke on and the first frame's detail. */
function grouped(filmId: string, violations: readonly FrameViolation[]): GateFailure[] {
  const groups = new Map<string, FrameViolation[]>();
  for (const violation of violations) {
    const key = JSON.stringify([violation.rule, violation.id, violation.other]);
    groups.set(key, [...(groups.get(key) ?? []), violation]);
  }
  return [...groups.values()].map((group) => {
    const [first] = group as [FrameViolation, ...FrameViolation[]];
    return {
      filmId,
      rule: first.rule,
      at: `${frameRuns(group.map(({ frame }) => frame))}, text "${first.id}"`,
      detail: first.detail,
    };
  });
}

function measuredLine(evidence: ClaimsEvidence): string {
  const copyRows = evidence.rows.filter(({ role }) => isCopy(role)).length;
  const rows = `${String(copyRows)} copy ${copyRows === 1 ? 'row held across its span' : 'rows held across their spans'}`;
  let smallest: { frame: number; text: TextBox } | null = null;
  for (const [frame, boxes] of evidence.frames) {
    for (const text of boxes) {
      if (isCopyBox(text) && (smallest === null || text.fontSizePx < smallest.text.fontSizePx)) {
        smallest = { frame, text };
      }
    }
  }
  const size =
    smallest === null
      ? 'no frame holds copy text'
      : `smallest copy text ${px(smallest.text.fontSizePx)} px (frame ${String(smallest.frame)}, text "${smallest.text.id}")`;
  return `${String(evidence.frames.size)} frames of text boxes; ${rows}; ${size}`;
}

/**
 * Claims: on every frame, each copy box the look reports lies inside the safe
 * box, overlaps no other copy box and is set at its role's size floor; and each
 * copy row of the spec is reported, by its id, on every frame of its span.
 * Imagery has no floor and may sit anywhere.
 */
export function claimsGate(filmId: string, evidence: ClaimsEvidence): GateResult {
  const violations = [...evidence.frames]
    .toSorted(([a], [b]) => a - b)
    .flatMap(([frame, boxes]) => {
      const copy = boxes.filter((text) => isCopyBox(text));
      return copy.flatMap((text) => boxViolations(frame, text, copy));
    });
  const failures = [
    ...grouped(filmId, violations),
    ...evidence.rows
      .filter(({ role }) => isCopy(role))
      .flatMap((row) => readingTimeFailure(filmId, row, evidence.frames) ?? []),
  ];
  return gateResult('claims', failures, [measuredLine(evidence)]);
}

/** Whether the input props turn on the QA channel; `qa` is a boolean or absent. */
export function readQa(inputProps: Readonly<Record<string, unknown>>): boolean {
  const { qa } = inputProps;
  if (qa === undefined) {
    return false;
  }
  if (typeof qa !== 'boolean') {
    throw new TypeError(`input prop qa must be true or false, got ${JSON.stringify(qa)}`);
  }
  return qa;
}
