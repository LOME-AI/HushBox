import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { reachesThroughReferences, referencedScripts, rootScripts } from './lib/root-manifest.js';
import { STAGE_SEPARATOR } from './with-run-claim.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The reclaimer that reports what it deliberately left standing. A listener no
 * claim accounts for is named and kept, and the command answers non-zero to say
 * so — a report to the developer rather than a failure of the work. So a
 * sequencer that stops at the first failure must never carry work after it: the
 * report would silently cancel the command the developer actually asked for.
 */
const REPORTING_RECLAIM = 'dev-clean.ts';

/** How that reclaimer turns what it left standing into an exit code. */
const UNOWNED_EXIT = 'ports.unowned.length + sockets.unowned.length';

/** Which of this checkout's own live runs a reclaim reaches. */
const OWN_RUNS_FLAG = '--all';

/**
 * The sequencers that stop at the first failure: the shell's conjunction, and
 * the run-claim wrapper's separator, which keeps the conjunction's semantics on
 * purpose.
 */
const FIRST_FAILURE_SEQUENCE = new RegExp(`&&|${STAGE_SEPARATOR}`);

/** Whether running this fragment runs the reporting reclaimer, however indirectly. */
function reachesReportingReclaim(body: string, scripts: Record<string, string>): boolean {
  return reachesThroughReferences(body, scripts, (fragment) =>
    fragment.includes(REPORTING_RECLAIM)
  );
}

/** The commands a body sequences such that a failure cancels the ones after it. */
function gatedSequence(body: string): string[] {
  return body.split(FIRST_FAILURE_SEQUENCE).map((part) => part.trim());
}

/** Whether a body lets the reclaimer's report cancel work the caller asked for. */
function gatesLaterWorkOnReclaim(body: string, scripts: Record<string, string>): boolean {
  const parts = gatedSequence(body);
  return parts.some(
    (part, index) => index < parts.length - 1 && reachesReportingReclaim(part, scripts)
  );
}

describe('the reclaimer that reports rather than repairs', () => {
  it('still answers non-zero for what it left standing, which is what the rule below is about', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'scripts', REPORTING_RECLAIM), 'utf8');

    expect(
      source,
      `scripts/${REPORTING_RECLAIM} no longer turns a resource it left standing into a non-zero exit, so the rule below guards a hazard that is gone`
    ).toContain(UNOWNED_EXIT);
  });

  it('is still found through the script a developer runs it by', () => {
    const scripts = rootScripts();

    expect(
      reachesReportingReclaim('pnpm dev:clean', scripts),
      `the derivation (a body naming ${REPORTING_RECLAIM}, directly or through another root script it runs) no longer reaches the reclaimer, so the cases below assert over less than they claim`
    ).toBe(true);
  });

  it('is still recognised when a script gates later work on it', () => {
    const scripts = {
      'a-composite': 'pnpm dev:clean && pnpm some-work',
      'dev:clean': 'tsx scripts/with-env.ts tsx scripts/dev-clean.ts',
      'some-work': 'tsx scripts/some-work.ts',
    };

    expect(gatesLaterWorkOnReclaim(scripts['a-composite'], scripts)).toBe(true);
  });

  it('never cancels the command a root script was run for', () => {
    const scripts = rootScripts();
    const gated = Object.entries(scripts)
      .filter(([, body]) => gatesLaterWorkOnReclaim(body, scripts))
      .map(([name]) => name);

    expect(
      gated,
      `these root scripts run the reporting reclaimer and then more work, in a sequence that stops at the first failure: ${JSON.stringify(gated)}. The reclaimer answers non-zero for a listener it deliberately left standing, so the report cancels the rest of the command instead of informing it. Sequence the stages through a runner that runs every one of them, or drop the reclaim where the command that follows already refuses on its own.`
    ).toEqual([]);
  });
});

describe('pnpm dev:restart', () => {
  it('reclaims and then starts, in that order', () => {
    const scripts = rootScripts();
    const restart = scripts['dev:restart'];

    expect(restart).toBeDefined();
    expect(referencedScripts(restart ?? '', scripts)).toEqual(['dev:clean', 'dev']);
  });

  it('reaches the live runs of this checkout, which is the stack a restart replaces', () => {
    const restart = rootScripts()['dev:restart'] ?? '';

    expect(
      restart,
      `pnpm dev:restart reclaims without ${OWN_RUNS_FLAG}, so it culls only what a dead run left and leaves the live stack bound to its ports — the start that follows then fails on them`
    ).toContain(OWN_RUNS_FLAG);
  });
});
