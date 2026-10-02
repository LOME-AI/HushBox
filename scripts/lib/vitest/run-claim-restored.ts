/**
 * The package-wide check that a test file hands the run-claim variable back the
 * way it found it, and the reason one is needed at all.
 *
 * A case that registers a run of its own has to start from no claim, or
 * `registerRun` adopts the inherited one and writes into the machine-wide
 * registry; and `registerRun` blanks the variable on its way out. So suites
 * here clear it deliberately, and a hook that puts back an empty string leaves
 * every later suite in the same file — and every child process it spawns —
 * creating resources no claim names, which no reclaimer running unasked will
 * ever end.
 *
 * The runner's own restoration does not cover it: the `unstubEnvs` setting
 * restores stubs before each test and never after the last one, so whatever a
 * per-test setup hook put in the variable — through `vi.stubEnv` or by
 * assignment — is still there when the file's final teardown runs. A stub from
 * a once-per-file hook or from module scope is undone before the first case
 * and never reaches that teardown; an assignment from anywhere does.
 */
import { RUN_CLAIM_ENV } from '../claims/registry.js';

/** How a claim state is named in the message, since the value itself may not be. */
function describeClaim(value: string): string {
  return value === '' ? 'holding no run claim' : 'holding a run claim';
}

/**
 * The refusal a file earns by leaving the run-claim variable somewhere other
 * than where it found it, or `null` when it left it alone.
 *
 * An absent variable defaults to the empty string on both sides, which is the
 * reading every consumer of the claim already takes.
 *
 * Neither value reaches the message: a claim directory is a path under the
 * developer's own temp directory and carries their account name.
 */
export function runClaimRestorationFailure(inherited = '', current = ''): string | null {
  if (current === inherited) return null;
  return (
    `${RUN_CLAIM_ENV} was not restored: this file was invoked ${describeClaim(inherited)} and ` +
    `left the worker ${describeClaim(current)}. A hook that clears the variable has to put back ` +
    `what it found — the empty string where there was nothing, since a computed key cannot be ` +
    `deleted and every reader treats an empty claim as none. The runner will not do it for you: ` +
    `it restores stubs before each test and never after the last one, so whatever a per-test ` +
    `setup hook put in the variable is still there when this file's final teardown runs.`
  );
}

/**
 * The guard as a hook that *wraps* a test file rather than one that queues
 * behind the file's own teardowns: it runs the file, then rules on what the
 * file left in the variable.
 *
 * The shape is what keeps a throwing teardown from skipping the verdict. The
 * runner walks a suite's once-per-file teardowns in one loop and abandons the
 * loop at the first throw, so a guard registered as a sibling of the file's own
 * teardown is skipped whenever that teardown throws — and registration order
 * puts it last, since the sequencing is reverse-registration and the setup file
 * registers before the test file does. A wrapping hook is outside that loop:
 * the runner catches the teardown loop's error and records it against the
 * suite, then unwinds the wrapper, so a throw from the file's own teardowns
 * cannot skip the verdict. That is what the position buys, and it is why the
 * wrapper still rules *after* those teardowns, which is what lets a file
 * restore in one. The verdict is reached only from inside the wrapper: a
 * failure that returns before it leaves the guard silent, and that silence is
 * the absence of a verdict rather than a clean one.
 *
 * The check deliberately does not sit in a `finally`: the only way the wrapped
 * run rejects is the runner's own abort after a hook timeout, and throwing on
 * the way out of that would replace the timeout error with this one.
 */
export function runClaimRestorationGuard(
  inherited: string | undefined,
  readCurrent: () => string | undefined
): (runFile: () => Promise<void>) => Promise<void> {
  return async (runFile) => {
    await runFile();
    const failure = runClaimRestorationFailure(inherited, readCurrent());
    if (failure !== null) throw new Error(failure);
  };
}
