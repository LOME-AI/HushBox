import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, WEB_SOURCE_TREE } from './source-scope.js';
import { WEB_ALIAS, webProgram } from './web-program.js';

/** A handed project that already resolves the web package's alias, as a rule's own test builds it. */
function aliasedProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { paths: { [WEB_ALIAS]: [path.join(REPO_ROOT, 'apps/web/src/*')] } },
  });
}

/** A handed project with no compiler configuration, as the layer's runner builds it. */
function bareProject(): Project {
  return new Project({ useInMemoryFileSystem: true });
}

const OVERLAID = path.join(REPO_ROOT, 'apps/web/src/lib/web-program-overlay.ts');

describe('webProgram', () => {
  it('returns a handed project that already resolves the web alias', () => {
    const handed = aliasedProject();
    expect(webProgram(handed)).toBe(handed);
  });

  it('returns a handed project that already resolves the web alias when given an overlay', () => {
    const handed = aliasedProject();
    expect(webProgram(handed, [])).toBe(handed);
  });

  it('roots a program at an overlay under the web package options, so the alias resolves', () => {
    const program = webProgram(bareProject(), []);
    expect(program.getCompilerOptions().paths?.[WEB_ALIAS]).toBeDefined();
  });

  it('holds exactly the overlaid files, with the text they were handed', () => {
    const handed = bareProject();
    const file = handed.createSourceFile(OVERLAID, 'export const overlaid = 1;\n');
    const program = webProgram(handed, [file]);
    expect(program.getSourceFiles().map((sourceFile) => sourceFile.getFilePath())).toEqual([
      OVERLAID,
    ]);
    expect(program.getSourceFileOrThrow(OVERLAID).getFullText()).toBe(
      'export const overlaid = 1;\n'
    );
  });

  it("loads the web package's own file set when no overlay is given", () => {
    const program = webProgram(bareProject());
    const root = path.join(REPO_ROOT, WEB_SOURCE_TREE);
    expect(
      program.getSourceFiles().some((sourceFile) => sourceFile.getFilePath().startsWith(root))
    ).toBe(true);
    expect(program.getCompilerOptions().paths?.[WEB_ALIAS]).toBeDefined();
  });
});
