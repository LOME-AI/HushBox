import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DAY_MS } from './durations.ts';

/** Lines shown either side of the cited range. */
const CONTEXT_LINES = 6;
/** Hard ceiling on a window, so a citation naming a whole file stays a peek. */
const MAX_WINDOW_LINES = 200;

interface SourceRequest {
  /** Repo-relative, as every citation is written. */
  readonly path: string;
  readonly start: number;
  readonly end?: number;
  /** `YYYY-MM-DD`; a file touched after that day reads back `stale`. */
  readonly auditDate: string;
}

export interface SourceWindow {
  readonly path: string;
  readonly exists: boolean;
  readonly stale: boolean;
  readonly requestedStart: number;
  readonly requestedEnd: number;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

export type SourceError = 'outside-root' | 'invalid-range';

export type SourceOutcome =
  | { readonly ok: true; readonly value: SourceWindow }
  | { readonly ok: false; readonly error: SourceError };

/**
 * Lexical containment. Absolute inputs are refused outright rather than
 * resolved: a citation is repo-relative by definition, so an absolute one is
 * already outside the format.
 */
function containedRelativePath(candidate: string): string | null {
  if (candidate === '' || path.isAbsolute(candidate)) return null;
  const normalized = path.normalize(candidate);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return null;
  return normalized;
}

/**
 * Containment survives symlinks: the lexical check above sees only the string,
 * so a link inside the root pointing out of it would otherwise read a file the
 * boundary exists to keep unreadable.
 */
async function realPathIsContained(root: string, full: string): Promise<boolean> {
  const real = await fs.realpath(full);
  const realRoot = await fs.realpath(root);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

function missing(request: SourceRequest, relative: string, end: number): SourceWindow {
  return {
    path: relative,
    exists: false,
    stale: false,
    requestedStart: request.start,
    requestedEnd: end,
    start: request.start,
    end,
    lines: [],
  };
}

/** Later than the last moment of the audit's day, so same-day work is not drift. */
function isStale(modified: Date, auditDate: string): boolean {
  const dayAfter = Date.parse(`${auditDate}T00:00:00Z`) + DAY_MS;
  return Number.isNaN(dayAfter) ? false : modified.getTime() >= dayAfter;
}

function window(
  lines: readonly string[],
  start: number,
  end: number
): { start: number; end: number; lines: readonly string[] } {
  const total = lines.length;
  if (total === 0) return { start, end, lines: [] };

  // A citation past the end of the file lands on the closest real lines rather
  // than failing: a drifted line number is the case source peek exists for.
  const anchorEnd = Math.min(end, total);
  const anchorStart = Math.min(start, anchorEnd);
  const first = Math.max(1, anchorStart - CONTEXT_LINES);
  const last = Math.min(total, Math.min(anchorEnd + CONTEXT_LINES, first + MAX_WINDOW_LINES - 1));
  return { start: first, end: last, lines: lines.slice(first - 1, last) };
}

/**
 * Reads a cited range out of the working tree. The input is a string that came
 * from a document and the output is file content, so containment is a security
 * boundary rather than a nicety: anything resolving outside the root is refused,
 * before and after symlink resolution.
 */
export async function readSource(root: string, request: SourceRequest): Promise<SourceOutcome> {
  const end = request.end ?? request.start;
  if (!Number.isInteger(request.start) || request.start < 1 || end < request.start) {
    return { ok: false, error: 'invalid-range' };
  }

  const relative = containedRelativePath(request.path);
  if (relative === null) return { ok: false, error: 'outside-root' };

  const full = path.join(root, relative);
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    return { ok: true, value: missing(request, relative, end) };
  }
  if (!stat.isFile()) return { ok: true, value: missing(request, relative, end) };
  if (!(await realPathIsContained(root, full))) return { ok: false, error: 'outside-root' };

  const text = await fs.readFile(full, 'utf8');
  const lines = text === '' ? [] : text.split('\n');
  const cut = window(lines, request.start, end);

  return {
    ok: true,
    value: {
      path: relative,
      exists: true,
      stale: isStale(stat.mtime, request.auditDate),
      requestedStart: request.start,
      requestedEnd: end,
      ...cut,
    },
  };
}
