import path from 'node:path';
import { Project } from 'ts-morph';
import { REPO_ROOT } from './source-scope.js';
import type { SourceFile } from 'ts-morph';

/**
 * The program a rule reads the web package's types off: one where its `@/`
 * alias resolves.
 *
 * Owns that one reading. The layer's shared project is built with no compiler
 * configuration, so in it the alias resolves to nothing, and a type reached
 * through it reads as unknown. A rule that judges types in the web package then
 * reports legitimate code, or passes code it never read. Which files a rule
 * judges in the returned program, and what it does with them, stay the rule's
 * own.
 *
 * Reach: a handed project that already resolves the alias, which is how a rule's
 * colocated test drives it, is returned as it is. Otherwise the program is built
 * from the web package's own tsconfig.
 */

const WEB_TSCONFIG = 'apps/web/tsconfig.json';

/** The alias whose resolution decides whether a handed project can be read for types. */
export const WEB_ALIAS = '@/*';

/**
 * The web package's typed program. With `overlay`, the program is rooted at
 * exactly those files, with the text the rule was handed, under the web
 * package's options; the compiler reaches what they import from disk. Without
 * it, it loads the tsconfig's own file set from disk.
 */
export function webProgram(project: Project, overlay?: readonly SourceFile[]): Project {
  if (project.getCompilerOptions().paths?.[WEB_ALIAS] !== undefined) return project;
  const program = new Project({
    tsConfigFilePath: path.join(REPO_ROOT, WEB_TSCONFIG),
    skipAddingFilesFromTsConfig: overlay !== undefined,
  });
  for (const sourceFile of overlay ?? []) {
    program.createSourceFile(sourceFile.getFilePath(), sourceFile.getFullText(), {
      overwrite: true,
    });
  }
  return program;
}
