import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * How this package waits for something one of its own processes produces, and
 * what each subject more than one suite waits on is worth.
 *
 * A wait here ends on a deadline, never on a count of attempts. The reads and
 * probes between the sleeps are unbounded, so a count prices sleeping time
 * only: its span stays near its own floor however long the work it covers
 * actually takes, and the same number spends wildly different amounts of
 * waiting as the host gets busier. That is how a suite comes to report the
 * host's load as a verdict about the thing it is testing.
 *
 * Every budget is named at the call, and a suite waiting on a subject only it
 * has names its own beside it. A wait that inherited one would be bounded by
 * whatever its neighbour waits on, and a subject with no boot in it under a
 * boot's budget surfaces a broken mechanism half a minute late rather than at
 * once.
 *
 * A bound on waiting and nothing else: what a case decides from is the ids a
 * tree announced and whether the kernel still knows them, never a clock.
 */

/**
 * What a wait for a chain of this repository's own processes to name itself may
 * spend. Every suite that drives this chain shape used to price it for itself,
 * and the smallest copy was the one that reported the host's load as a verdict
 * about the chain — which is the whole reason the number lives here instead of
 * in each of them.
 *
 * An announcement is a chain of node processes starting — the chain's own
 * module under the runner's loader, then the runner's command line under that,
 * each transpiling before it runs a line — so what is being waited for is CPU,
 * and CPU is the one thing a saturated host has none of. Nothing observable
 * shortens that boot, so a number is the only instrument there is for it.
 *
 * The worst is 31.6 seconds: an independent measurement of this chain, driven
 * to completion rather than truncated at a bound — a figure taken from a case
 * cut off at its own budget is a lower bound and not a worst — and
 * `scripts/lib/spawn/spawner-death.test.ts` records 31.4 for the same shape.
 * This is three times that worst, rounded up to the second.
 */
export const CHAIN_ANNOUNCEMENT_BUDGET_MS = 95_000;

/**
 * What a case that starts a chain and then watches it go may spend.
 *
 * Larger than the announcement above by a margin, because a case that starts a
 * chain waits on it more than once and whichever of those waits is going to
 * expire has to reach its own bound first. At the runner's default the first
 * announcement outlives the case and what surfaces is a generic timeout, which
 * says a case was slow rather than which process never arrived.
 */
export const CHAIN_CASE_TIMEOUT_MS = CHAIN_ANNOUNCEMENT_BUDGET_MS * 3;

/**
 * What one cold `node` fixture of ours may spend booting to the point where it
 * produces what a case is waiting for — a report file it writes, a port it
 * binds, a child it puts in the group a case is counting.
 *
 * Two shapes of fixture, one subject: a module of ours under the runner's
 * loader, and a one-liner on the command line with nothing of ours to compile.
 * The loader is what makes the first the expensive one, and a bound that covers
 * it covers the other by a wide margin.
 *
 * Derived from the chain above rather than from this subject's own
 * observations: that chain is two loader boots with a supervisor and a task
 * under them, so its worst upper-bounds any part of it, and this is that worst.
 * The largest completed observation of a loader boot alone is 2.3 seconds and
 * of a one-liner 115 ms, over four package runs under real concurrent load
 * reaching a host load average of 65 on 24 cores — maxima over runs that never
 * expired, which are not worsts.
 */
export const FIXTURE_BOOT_BUDGET_MS = 32_000;

/**
 * What a process of ours that is already running may spend doing what a signal
 * or a kill asks of it — exiting, writing what it was told to write — and what
 * a port or a socket it held may spend going with it. No boot in it, of either
 * shape above: the kernel delivers and a handler runs.
 *
 * This is the one figure here that is neither a worst nor derived from one, and
 * it says so rather than borrowing a neighbour's. Every direct observation of
 * this subject sits at the instrument's floor — twenty-five samples on a host
 * running other work, each returning true on the first probe after the kill,
 * inside the twenty-five milliseconds between probes — so there is no tail to
 * take a multiple of. The package runs that measured the rest recorded no
 * maximum for it either: what they reported for this class came from a
 * one-liner starting, which is a boot and is priced as one above.
 *
 * What fixes the figure is its two ends. It stays a fraction of one boot above,
 * so a mechanism that never acts surfaces in seconds rather than in half a
 * minute; and it stays orders above every observation, so a tail nobody has
 * seen does not reach it. Ten seconds is the round number between them, chosen
 * rather than derived.
 */
export const SIGNAL_REACTION_BUDGET_MS = 10_000;

/**
 * How long a case watches to establish that nothing happened, which — unlike a
 * death — is not an event anything can wait on.
 *
 * Longer than an armed teardown takes, or a case reads a tree that is going as
 * one nothing asked to go. The largest completed observation of an armed
 * teardown in this package is 2.7 seconds — a chain reached through the package
 * manager going after the process it watched was killed hard, over those same
 * four package runs — and this is three times it. The counts this replaced
 * spent about a second apiece, under that maximum, so each was a control that
 * could pass on a teardown it was too short to see.
 */
export const SURVIVAL_WINDOW_MS = 8000;

/**
 * Reads what one of our processes wrote about itself, ending on the content or
 * on `budgetMs`.
 */
export async function untilFileWritten(file: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const seen = await fs.readFile(file, 'utf8').catch(() => '');
    if (seen.length > 0) return seen;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Nothing was ever written to ${path.basename(file)} within ${String(budgetMs)} ms.`
  );
}

/**
 * Polls a fact our own machinery produces — a process being gone, a port being
 * bound — ending on the fact or on `budgetMs`.
 *
 * Polled rather than slept out, because the answer is immediate once true.
 */
export async function untilObserved(
  fact: () => boolean | Promise<boolean>,
  budgetMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await fact()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * A tree of ours going after the process it watched was killed hard.
 *
 * It has no measurement of its own. What a tree does then is a watcher waking
 * and reaping, which is the same host fact the boot above is — processes of
 * ours needing CPU — and plainly less of it, so the budget measured for the
 * boot over-covers this. The observation that put a deadline here at all was
 * truncated at the count it replaced, which is a lower bound of five seconds
 * and not a worst, and deriving a number from it would be deriving one from a
 * floor.
 */
export async function untilSettled(fact: () => boolean | Promise<boolean>): Promise<boolean> {
  return untilObserved(fact, CHAIN_ANNOUNCEMENT_BUDGET_MS);
}
