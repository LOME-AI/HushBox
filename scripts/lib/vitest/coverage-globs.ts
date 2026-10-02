import { globSync } from 'node:fs';
import path from 'node:path';

import { loadConfigFromFile } from 'vite';

/**
 * Coverage include/exclude globs live package-relative in each package's own
 * vitest config; the consolidated run and the per-package scoped run both need
 * them repo-root-relative. One remapping implementation serves the root
 * projects config (union across packages) and the test client (own package).
 */

interface CoverageGlobs {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Remap a package-relative glob list to repo-root-relative. */
export function remapGlobs(dir: string, globs?: readonly string[]): string[] {
  return (globs ?? []).map((glob) =>
    glob.startsWith('!') ? `!${path.posix.join(dir, glob.slice(1))}` : path.posix.join(dir, glob)
  );
}

const CONFIG_ENV = { command: 'serve', mode: 'test' } as const;

/**
 * The files a coverage glob list resolves to on disk. A negated entry drops its
 * matches from that same list's set, which is what `!` means in either list: in
 * an include it withholds files from measurement, in an exclude it withholds
 * files from the exclusion. One implementation serves both.
 *
 * Disk, not the coverage map: this answers "is there anything here to measure"
 * before vitest starts, which is the question `--coverage.include` cannot
 * answer once a run has produced an empty map for some other reason.
 */
function resolveGlobs(repoRoot: string, globs: readonly string[]): Set<string> {
  const matched = new Set(
    globSync(
      globs.filter((glob) => !glob.startsWith('!')),
      { cwd: repoRoot }
    )
  );
  for (const withheld of globSync(
    globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1)),
    { cwd: repoRoot }
  )) {
    matched.delete(withheld);
  }
  return matched;
}

/**
 * One package's coverage globs, remapped to repo-root-relative, read from its
 * own vitest config through Vite's config loader — the same loader vitest
 * uses, so `__dirname`/`import.meta.url` tricks inside configs keep working.
 *
 * Throws when the package's scope would measure nothing. Both callers turn
 * coverage on for the package whose scope this is, so a package that declares
 * none is not measured at 0% — its files are absent from the report entirely
 * and its 95% gate passes over an empty set (CODE-RULES §95% Test Coverage,
 * "no exceptions"). Failing here rather than after the run is what makes the
 * absence loud: a run that reaches vitest at all has a scope to measure.
 */
export async function loadPackageCoverageGlobs(
  repoRoot: string,
  dir: string,
  configFile: string
): Promise<CoverageGlobs> {
  const file = path.join(repoRoot, dir, configFile);
  const loaded = await loadConfigFromFile(CONFIG_ENV, file, path.join(repoRoot, dir));
  if (!loaded) {
    throw new Error(`failed to load ${file}`);
  }
  const coverage = (
    loaded.config as { test?: { coverage?: { include?: string[]; exclude?: string[] } } }
  ).test?.coverage;
  const include = remapGlobs(dir, coverage?.include);
  const exclude = remapGlobs(dir, coverage?.exclude);
  if (include.length === 0) {
    throw new Error(
      `${dir}: NO COVERAGE SCOPE — ${configFile} declares no test.coverage.include, so this package's source is absent from the coverage report and its gate passes over nothing. Declare package-relative include globs in that config.`
    );
  }
  const reached = resolveGlobs(repoRoot, include);
  if (reached.size === 0) {
    throw new Error(
      `${dir}: COVERAGE SCOPE REACHES NO FILE — test.coverage.include (${include.join(', ')}) matches nothing on disk, so this package's gate passes over nothing. Fix the globs in ${configFile}; they are package-relative there.`
    );
  }
  for (const excluded of resolveGlobs(repoRoot, exclude)) {
    reached.delete(excluded);
  }
  if (reached.size === 0) {
    throw new Error(
      `${dir}: COVERAGE SCOPE MEASURES NO FILE — test.coverage.include (${include.join(', ')}) reaches files on disk but test.coverage.exclude removes every one of them, so this package's gate passes over nothing. An include that lands only on test files, barrels or configs does this, because the shared base config already excludes those.`
    );
  }
  return { include, exclude };
}
