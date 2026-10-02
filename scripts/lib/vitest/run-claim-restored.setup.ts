/**
 * Arms {@link runClaimRestorationGuard} over every test file in this package,
 * as a hook that wraps the file rather than one that queues behind its own
 * teardowns — the guard states why that placement is what makes the verdict
 * reachable at all.
 *
 * Per file rather than per case: a suite here clears the variable in setup on
 * purpose, and what has to hold is that the file gives it back — which is the
 * granularity that also attributes the leak, since the value this module reads
 * at load is the one the file was handed.
 *
 * That last clause rests on the runner giving each test file a process of its
 * own and evaluating this module once inside it, which is what makes a verdict
 * here independent of file order and worker assignment. A configuration that
 * reused one worker across files, carrying one environment forward, would still
 * re-evaluate this module per file, so the reading stays that file's own start;
 * what it costs is completeness — the first leak becomes the next file's
 * baseline, so the guard names whichever file leaked first and stays quiet about
 * every later one leaking the same way. A shared process id is not that
 * condition: a worker thread shares one and is handed its own copy of the
 * environment.
 *
 * Per-file re-evaluation is a property of registration in `setupFiles`, which
 * the runner invalidates between test files.
 */
import { aroundAll } from 'vitest';

import { RUN_CLAIM_ENV } from '../claims/registry.js';
import { runClaimRestorationGuard } from './run-claim-restored.js';

const inherited = process.env[RUN_CLAIM_ENV];

aroundAll(runClaimRestorationGuard(inherited, () => process.env[RUN_CLAIM_ENV]));
