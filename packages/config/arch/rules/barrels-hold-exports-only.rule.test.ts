import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './barrels-hold-exports-only.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const BARREL = 'packages/shared/src/topic/index.ts';
const REEXPORT = "export { thing } from './thing.js';\n";

describe('barrels-hold-exports-only', () => {
  describe('the runtime side of the line', () => {
    it('flags a function declaration', () => {
      const project = projectWith(
        BARREL,
        `${REEXPORT}export function build(): number {\n  return 1;\n}\n`
      );

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: BARREL, line: 2 });
      expect(violations[0]?.message).toContain('build');
    });

    it('flags an arrow function bound to an exported const', () => {
      const project = projectWith(BARREL, `${REEXPORT}export const build = (): number => 1;\n`);

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a variable initialised by a call, the Zod-schema shape', () => {
      const project = projectWith(
        BARREL,
        `import { z } from 'zod';\n${REEXPORT}export const schema = z.string();\n`
      );

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('schema');
    });

    it('flags a variable initialised by a literal, which emits and so is not type-erased', () => {
      const project = projectWith(BARREL, `${REEXPORT}export const LIMIT = 5;\n`);

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('LIMIT');
    });

    it('flags a class declaration', () => {
      const project = projectWith(BARREL, `${REEXPORT}export class Boom extends Error {}\n`);

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Boom');
    });

    it('flags an enum, which emits an object even though it reads as a type', () => {
      const project = projectWith(BARREL, `${REEXPORT}export enum Colour {\n  Red = 'red',\n}\n`);

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags runtime code the barrel keeps private, since privacy does not make it measured', () => {
      const project = projectWith(BARREL, `const cache = new Map<string, string>();\n${REEXPORT}`);

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ line: 1 });
    });

    it('flags a bare expression statement in a barrel that also exports', () => {
      const project = projectWith(BARREL, `${REEXPORT}console.warn('side effect');\n`);

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags an export assignment, which evaluates at module load', () => {
      const project = projectWith(
        BARREL,
        `import { thing } from './thing.js';\nexport default thing;\n`
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags an anonymous default-exported class, naming its kind', () => {
      const project = projectWith(BARREL, `${REEXPORT}export default class extends Error {}\n`);

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ClassDeclaration');
    });

    it('reports every emitting statement, not just the first', () => {
      const project = projectWith(
        BARREL,
        `${REEXPORT}export const A = 1;\nexport const B = 2;\nexport function c(): void {}\n`
      );

      expect(rule.check(project)).toHaveLength(3);
    });
  });

  describe('the type side of the line', () => {
    it('passes an interface declaration, which the compiler erases', () => {
      const project = projectWith(
        BARREL,
        `${REEXPORT}export interface Row {\n  readonly id: string;\n}\n`
      );

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a type alias', () => {
      const project = projectWith(BARREL, `${REEXPORT}export type Id = string;\n`);

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a type-only re-export', () => {
      const project = projectWith(BARREL, "export type { Row } from './row.js';\n");

      expect(rule.check(project)).toEqual([]);
    });

    it('passes an ambient declaration, which emits nothing', () => {
      const project = projectWith(BARREL, `${REEXPORT}declare const injected: string;\n`);

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('what a barrel is allowed to be', () => {
    it('passes a barrel of named and star re-exports', () => {
      const project = projectWith(
        BARREL,
        "export * from './a.js';\nexport { b } from './b.js';\nexport * as c from './c.js';\n"
      );

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a re-export written as an import plus an export clause', () => {
      const project = projectWith(
        BARREL,
        "import { thing } from './thing.js';\nexport { thing };\n"
      );

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('scope', () => {
    it('passes a file that exports nothing, a framework entry point rather than a barrel', () => {
      const project = projectWith(
        'ads/src/index.ts',
        "import { Root } from './root.js';\nregisterRoot(Root);\n"
      );

      expect(rule.check(project)).toEqual([]);
    });

    it('governs a barrel whose only export is the runtime declaration itself', () => {
      const project = projectWith(BARREL, 'export const LIMIT = 5;\n');

      expect(rule.check(project)).toHaveLength(1);
    });

    it('passes a module that is not named index.ts', () => {
      const project = projectWith(
        'packages/shared/src/topic/thing.ts',
        'export const LIMIT = 5;\n'
      );

      expect(rule.check(project)).toEqual([]);
    });

    it('passes index.tsx, which is a component and which coverage measures', () => {
      const project = projectWith(
        'apps/web/src/routes/index.tsx',
        'export const Page = (): null => null;\n'
      );

      expect(rule.check(project)).toEqual([]);
    });
  });
});
