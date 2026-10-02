/**
 * `pnpm fix:binary-privacy <paths…>` — the remedy the binary privacy gate points
 * developers at.
 *
 * It writes a file only when the strip removed every finding the gate can act on
 * *and* left the container's content bytes identical. Anything else — a damaged
 * container, a format with no lossless remedy, a strip that did not finish — is
 * reported and the file is left exactly as it was, because a file this tool
 * touched and could not clean must never read as one it cleaned.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { stripBinaryBlob } from './lib/privacy/binary-strip.js';
import { isMainModule } from './lib/cli/is-main.js';
import { isOutsideRoot } from './lib/path-containment.js';
import { runMain } from './lib/cli/run-main.js';
import { stagedWriteSync } from './lib/staged-write.js';
import type { StripStatus } from './lib/privacy/binary-strip.js';

/**
 * Statuses that leave nothing for a human to do.
 *
 * Exported so a caller checks membership rather than keeping its own copy: the
 * misnamed-extension contract is entirely a statement about what is *not* here,
 * and a second table would drift out from under it silently.
 */
export const CLEARED_STATUSES: ReadonlySet<StripStatus | 'unreadable'> = new Set<
  StripStatus | 'unreadable'
>(['stripped', 'clean']);

export interface FileOutcome {
  /** Relative to the working directory: an absolute path names the machine. */
  readonly file: string;
  readonly status: StripStatus | 'unreadable';
  readonly format: string;
  readonly reasons: readonly string[];
  readonly edits: number;
  /** The content digest the strip proved unchanged; empty where nothing was stripped. */
  readonly content: string;
}

const HASH_PREFIX_LENGTH = 12;

function displayPath(file: string): string {
  // A target outside the working directory renders as its name alone. The walk
  // up and out spells the host's directory layout — the disclosure this whole
  // gate exists to stop — and a report does not need it to be actionable. The
  // containment question is asked through the shared predicate rather than
  // spelled here, because a copy that misses an arm the shared one gains
  // surfaces as a leak rather than as a mismatch.
  const resolved = path.resolve(file);
  if (isOutsideRoot(path, process.cwd(), resolved)) return path.basename(file);
  return path.relative(process.cwd(), resolved).replaceAll('\\', '/');
}

function stripOne(file: string): FileOutcome {
  const shown = displayPath(file);
  let bytes: Buffer;
  let mode: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a regular file');
    mode = stat.mode;
    bytes = readFileSync(file);
  } catch {
    // The system's own message names the absolute path and the account it ran
    // under, so the shape of the failure is reported and the message is not.
    return {
      file: shown,
      status: 'unreadable',
      format: 'unknown',
      reasons: ['the path is unreadable or is not a regular file'],
      edits: 0,
      content: '',
    };
  }
  // A strip that cannot prove it preserved the content throws rather than
  // returning, and one bad file must not take the rest of the batch with it.
  let result;
  try {
    result = stripBinaryBlob(shown, bytes);
  } catch (error: unknown) {
    return {
      file: shown,
      status: 'refused',
      format: 'unknown',
      reasons: [String(error)],
      edits: 0,
      content: '',
    };
  }
  // A truncating write over the target is a state this tool must never be in: a
  // process killed part way through one leaves the file at zero length with the
  // original gone, which is the outcome this whole command exists to prevent.
  // An interruption cannot be caught — it is the absence of further execution —
  // so the only defence is arranging that the dangerous state never exists. The
  // mode is carried across because the replacement is a new file, where the
  // in-place write it replaces never changed the mode at all.
  if (result.status === 'stripped') stagedWriteSync(file, result.bytes, { mode });
  return {
    file: shown,
    status: result.status,
    format: result.format,
    reasons: result.reasons,
    edits: result.edits.length,
    content: result.contentDigest.slice(0, HASH_PREFIX_LENGTH),
  };
}

function outcomeLine(outcome: FileOutcome): string {
  const detail: string[] = [];
  if (outcome.status === 'stripped') {
    detail.push(
      `${String(outcome.edits)} edit${outcome.edits === 1 ? '' : 's'}`,
      `content unchanged (sha256 ${outcome.content})`
    );
  }
  const suffix = detail.length === 0 ? '' : ` — ${detail.join(', ')}`;
  return [
    `  ${outcome.status.padEnd(11)} ${outcome.file}${suffix}`,
    ...outcome.reasons.map((reason) => `      ${reason}`),
  ].join('\n');
}

export function formatStripReport(outcomes: readonly FileOutcome[]): string {
  if (outcomes.length === 0) return 'Binary privacy fix: no files given.';
  const unresolved = outcomes.filter((outcome) => !CLEARED_STATUSES.has(outcome.status));
  return [
    `Binary privacy fix: ${String(outcomes.length)} file(s), ${String(unresolved.length)} still needing a human.`,
    '',
    ...outcomes.map((outcome) => outcomeLine(outcome)),
    ...(unresolved.length === 0
      ? []
      : [
          '',
          'Nothing was written for the files above. A refusal means the gate could not read',
          'the content it was asked to clean; an unsupported format has no remedy that avoids',
          're-encoding it. Both are decisions for a person, not for this tool.',
        ]),
  ].join('\n');
}

export interface FixRun {
  readonly report: string;
  readonly code: number;
}

export function runBinaryPrivacyFix(paths: readonly string[]): FixRun {
  if (paths.length === 0) {
    return {
      report: 'Binary privacy fix: give it one or more paths to strip.',
      code: 1,
    };
  }
  const outcomes = paths.map((file) => stripOne(file));
  return {
    report: formatStripReport(outcomes),
    code: outcomes.every((outcome) => CLEARED_STATUSES.has(outcome.status)) ? 0 : 1,
  };
}

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(() => {
    const run = runBinaryPrivacyFix(process.argv.slice(2));
    console.log(run.report);
    return run.code;
  });
}
/* v8 ignore stop */
