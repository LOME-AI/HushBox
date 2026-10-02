import { TEST_FILE_PATTERN } from '../../test-file-spellings.js';
import type { Project, SourceFile } from 'ts-morph';

/**
 * The path facts the rules read, resolved once each, and the one way a rule
 * aborts over them ({@link failWith}) — which lives here because the message it
 * renders is the message {@link assertNamedPathsExist} already renders, and two
 * spellings of a rule's own name in its own failure is the same second copy
 * everything else in this module exists to prevent.
 *
 * None of these is a rule's SCOPE. Which tree a rule watches is that rule's own
 * decision and stays in its own `isInScope`; what a repo-relative path IS, what
 * a test file is NAMED, and what a repo-local specifier LOOKS LIKE have one
 * answer apiece, and a second copy of any of them is a rule reading the
 * repository differently from its neighbours for no stated reason.
 *
 * {@link isTestFile} is the only spelling in the layer. Narrower ones survived
 * here for a while — `.endsWith('.test.ts')` in `route-shapes`' `isApiSourceFile`,
 * in `single-writer-per-table` and in three `isInScope` copies, and
 * `/\.test\.tsx?$/` in `event-counting-lives-in-api` — and every one of them
 * read the `.spec.ts` files the scanned scope reaches as non-test source. A
 * Playwright spec IS a test file, so that was a wrong name rather than a
 * narrower scope: a rule that means to scan test files does not consult this at
 * all, and a rule that excludes them was excluding by spelling.
 *
 * `.setup.` carries the same argument one step further: a vitest global setup,
 * a Playwright auth setup and an integration suite's shared seeding file exist
 * only so tests can run, and reading one as production source was the same
 * spelling mistake. Which files a rule is willing to exempt beyond that — a
 * whole scaffolding directory, say — is that rule's own judgement and stays
 * with it, because the rules that police test seams must keep seeing them.
 *
 * The set of spellings is not this layer's to hold, though. The boundaries
 * perimeter releases the same files from its import rules and refuses them as
 * import targets in exchange, and the shared coverage config releases them from
 * measurement; all three read the declaration in `test-file-spellings.ts`,
 * because a file exempt from one gate and source to the next is a result
 * nobody can defend at the moment they meet it.
 */

/**
 * A rule's abort: what it names is the rule itself, so the message carries the
 * rule's name whoever throws it.
 *
 * A caller binds the result to an explicitly annotated `const` — TypeScript
 * narrows on a never-returning call only for a function declaration or a `const`
 * carrying its own type annotation, so dropping that annotation silently costs
 * every `if (…) fail(…)` its narrowing.
 */
export function failWith(rule: string): (message: string) => never {
  return (message) => {
    throw new Error(`${rule}: ${message}`);
  };
}

/** The repo-relative path a violation reports. */
export function relativePath(sourceFile: SourceFile): string {
  return sourceFile.getFilePath().replace(/^\//, '');
}

/** A scanned file IS the repo-relative path named, however the project is rooted. */
export function isRepoPath(filePath: string, repoPath: string): boolean {
  return filePath === repoPath || filePath.endsWith(`/${repoPath}`);
}

/** A colocated test, spec, or test-setup file, in the one spelling the repository declares. */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

/** The scanned file at a repo-relative path, or undefined when there is none. */
export function sourceFileAt(project: Project, repoPath: string): SourceFile | undefined {
  return project
    .getSourceFiles()
    .find((sourceFile) => isRepoPath(relativePath(sourceFile), repoPath));
}

/**
 * Every path a rule names still names a file.
 *
 * A path-shaped constant decays without a symptom: the entry stays, the file it
 * named moves or dies, and every check that consults it goes on passing over
 * nothing — the rule keeps enforcing, just not over the thing it was aimed at.
 * There is no violation to report, because what went missing is the rule's own
 * subject, so the throw is the only signal available.
 *
 * Rules pass their own list and their own remedy; the traversal is one
 * implementation because two that must agree about what "this path exists"
 * means is the same decay one level up.
 */
export function assertNamedPathsExist(
  rule: string,
  project: Project,
  paths: readonly string[],
  remedy: string
): void {
  const fail = failWith(rule);
  for (const named of paths) {
    if (sourceFileAt(project, named) !== undefined) continue;
    fail(`'${named}' names no file in the scanned tree. ${remedy}`);
  }
}

/**
 * A specifier that resolves inside the repository: relative, or through the
 * `@/` alias. A bare specifier names a package and reaches no tree a rule owns,
 * so a rule chasing a same-repo import starts here.
 */
export function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('@/');
}
