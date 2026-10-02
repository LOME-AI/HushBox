import path from 'node:path';

/** The directory a tree's coverage output sits in. */
export const COVERAGE_DIRECTORY_NAME = 'coverage';

/**
 * Where a coverage run writes when nothing keyed a directory to its claim.
 *
 * It is a directory *below* {@link COVERAGE_DIRECTORY_NAME} rather than that
 * directory itself, and the distinction is the whole point: the v8 provider
 * removes its reports directory at the start of every run, from vitest's own
 * start path, before global setup and so before any code here runs. A default
 * naming the parent therefore makes any run reaching vitest outside the runners
 * delete every concurrent run's coverage directory — the runners key theirs
 * inside that parent — and the refusal such a run then earns arrives after the
 * removal it cannot undo. Named a level down, the same removal reaches one
 * run's own output and nothing else.
 *
 * The name is deliberately one no run identifier can be read out of, so a run
 * landing here is still refused and the reclaim still passes it over rather than
 * attributing it to a run.
 */
export const UNKEYED_COVERAGE_DIRECTORY = path.join(COVERAGE_DIRECTORY_NAME, 'unkeyed');
