/**
 * The privacy gate as CI runs it: both content gates over the whole tree of the
 * commit under test.
 *
 * This is the backstop for a bypassed hook. The hooks are skippable by design
 * (`--no-verify`, `HUSKY=0`), so the only thing standing between a bypassed
 * push and a published disclosure is a check nobody can skip — which makes this
 * sweep's enumeration load-bearing rather than belt-and-braces.
 *
 * It sweeps the whole tree rather than a range, and that is the point. Every
 * time this gate family has been blinded, it was blinded through the question
 * "what is new here?" — which needs the destination's answer about what it
 * already holds, and a sweep that asked its own clone would be answering with a
 * guess. A whole-tree sweep has no such question to get wrong: everything the
 * commit carries is in scope. It also re-judges what earlier bypasses already
 * landed, which a range never revisits.
 *
 * The enumeration itself is the hook's, imported rather than rebuilt: the same
 * NUL-framed, pair-keyed tree listing, the same blob reader, the same two gates,
 * and the same allowlist read from the judged commit. A second enumeration here
 * would re-inherit every hole that one has already had closed.
 */
import path from 'node:path';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import {
  formatGateReport,
  isBlocked,
  listTreePairs,
  readAllowlistFromTip,
  reportablePath,
  scanBlobs,
} from './privacy-gate.js';
import { readBlobsByEntries } from './lib/privacy/verify-content-privacy.js';
import type { BinaryOutcome, GateFindings, GateOutcome } from './privacy-gate.js';
import type { PrivacyFinding } from './lib/privacy/rules.js';

/**
 * How many object-and-path pairs one read covers. The blob reader already caps
 * the bytes of a single `git cat-file` invocation, but it returns every blob it
 * was asked for at once, so the whole tree in one call is the whole tree in
 * memory. Scanning is per blob and carries nothing between them, so the sweep
 * reads and scans a batch at a time and keeps only the findings.
 */
export const SWEEP_BATCH_SIZE = 256;

/**
 * Fixed-size runs, in order, so the caller reads a bounded slice at a time.
 *
 * Generic over the element because the body reads nothing off one: the working-tree
 * check batches a plain path list, which carries no object id, and a second
 * count-batcher for it would be the copy this file's own reuse avoids.
 */
export function batchEntries<T>(entries: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < entries.length; index += size) {
    batches.push(entries.slice(index, index + size));
  }
  return batches;
}

/**
 * The checkout root, derived from this module's own location rather than from
 * the process's working directory. A workflow step's directory is whatever the
 * step before it left, and a gate that reads a tree relative to that answers for
 * a subtree nobody chose.
 */
export function repositoryRoot(moduleDirectory: string): string {
  return path.resolve(moduleDirectory, '..');
}

export async function sweepCommit(repoRoot: string, commit: string): Promise<GateFindings> {
  const pairs = await listTreePairs(repoRoot, commit);
  const allowlist = await readAllowlistFromTip(repoRoot, commit);
  const text: PrivacyFinding[] = [];
  const binary: BinaryOutcome[] = [];
  for (const batch of batchEntries(pairs, SWEEP_BATCH_SIZE)) {
    const entries = batch.map((entry) => ({
      objectId: entry.objectId,
      path: reportablePath(entry.path),
    }));
    const findings = scanBlobs(await readBlobsByEntries(repoRoot, entries), allowlist);
    text.push(...findings.text);
    binary.push(...findings.binary);
  }
  return { text, binary };
}

export async function runPrivacySweep(repoRoot: string, commit: string): Promise<GateOutcome> {
  const findings = await sweepCommit(repoRoot, commit);
  const report = [
    'Privacy sweep: both gates over every blob this commit carries, at every path it carries it at.',
    formatGateReport(findings),
  ].join('\n\n');
  return { report, code: isBlocked(findings) ? 1 : 0 };
}

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const [commit = 'HEAD'] = process.argv.slice(2);
    const outcome = await runPrivacySweep(repositoryRoot(import.meta.dirname), commit);
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */
