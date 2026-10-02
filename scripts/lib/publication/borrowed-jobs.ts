/**
 * The `ci.yml` jobs whose verdict is a function of the commit alone, so a
 * successful run of them on staging's trusted push run proves the same commit
 * on public. A matrix job is named here by its key; its legs report as
 * `key (…)`.
 *
 * The one list every reader of that proof takes: the outbound mirror's
 * publication predicate, the public push's borrow and the gate that judges it.
 */
export const BORROWED_JOBS = [
  'lint',
  'typecheck',
  'duplication',
  'unused',
  'test',
  'e2e-build',
  'e2e',
  'mobile-test',
] as const;

/** The workflow whose push run on staging's `main` is the proof. */
export const TRUSTED_WORKFLOW_FILE = 'ci.yml';
