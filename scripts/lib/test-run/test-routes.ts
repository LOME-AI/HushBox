/**
 * The supported routes into a coverage run, as one clause every refusal that
 * raises the question states.
 *
 * Three refusals raise it — a coverage run holding no claim, a coverage run
 * aimed at a directory its claim does not key, and a whole-package run handed
 * test files on its command line — and a refusal is where an agent meets the
 * question, so the answer has to be the same one at each. Kept here rather than
 * beside any one of them: the whole-package runner and the guard already import
 * one from the other, and a second edge between them would close the cycle.
 *
 * Both routes take the run claim in `with-env` before vitest starts and pass a
 * coverage directory keyed to it, which is what the refusals go on to say.
 */
export const COVERAGE_RUN_ROUTES =
  'Run it through `pnpm test:file <path>` for named test files, or `pnpm test:pkg <package>` for a whole package';
