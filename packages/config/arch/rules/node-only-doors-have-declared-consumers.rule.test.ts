import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import { NODE_ONLY_DOORS } from './published-doors-stay-browser-safe.rule.js';
import rule from './node-only-doors-have-declared-consumers.rule.js';

/**
 * The rule reads the guarded package's manifest off the project's file system
 * and judges the parsed source files, so a fixture writes both under
 * {@link REPO_ROOT}.
 *
 * Every fixture derives its door specifiers from {@link NODE_ONLY_DOORS} rather
 * than writing them out: the rule derives the ban from that same list, so a
 * fixture holding a copy would go on passing after the list moved.
 */

const PACKAGE_NAME = '@hushbox/shared';
const MANIFEST_PATH = 'packages/shared/package.json';

/** A door of the guarded package that is not node-only, for the passing shapes. */
const ORDINARY_DOOR = './documents';

/** Every specifier the ban derives, one per declared node-only door. */
const DOOR_SPECIFIERS = NODE_ONLY_DOORS.map((subpath) => `${PACKAGE_NAME}${subpath.slice(1)}`);

/** The module each door is served by, in fixture layout. */
function targetFor(subpath: string): string {
  return `./src${subpath.slice(1)}.ts`;
}

const DECLARED_EXPORTS: Record<string, string> = {
  ...Object.fromEntries(NODE_ONLY_DOORS.map((subpath) => [subpath, targetFor(subpath)])),
  [ORDINARY_DOOR]: targetFor(ORDINARY_DOOR),
};

interface Republication {
  /** The spelling, as a case name says which one it ran. */
  readonly form: string;
  /** A module republishing what it imports from `specifier`, in that spelling. */
  readonly write: (specifier: string) => string;
}

/**
 * Republication written as an import statement plus a separate export
 * statement. None of the three spellings carries a module specifier, which is
 * the whole of why the taint leg reads none of them.
 */
const REPUBLICATION_FORMS: readonly Republication[] = [
  {
    form: 'named export',
    write: (specifier) => `import { envConfig } from '${specifier}';\nexport { envConfig };\n`,
  },
  {
    form: 'default export',
    write: (specifier) => `import { envConfig } from '${specifier}';\nexport default envConfig;\n`,
  },
  {
    form: 'namespace import',
    write: (specifier) => `import * as registry from '${specifier}';\nexport { registry };\n`,
  },
];

/** Every declared door crossed with every republication spelling. */
const REPUBLICATIONS = DOOR_SPECIFIERS.flatMap((door) =>
  REPUBLICATION_FORMS.map((republication) => ({ door, ...republication }))
);

function projectWith(
  files: Record<string, string>,
  exports: Record<string, string> = DECLARED_EXPORTS
): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project
    .getFileSystem()
    .writeFileSync(
      path.join(REPO_ROOT, MANIFEST_PATH),
      JSON.stringify({ name: PACKAGE_NAME, exports }, null, 2)
    );
  for (const [file, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, file), source);
  }
  return project;
}

describe('node-only-doors-have-declared-consumers', () => {
  it.each(DOOR_SPECIFIERS)(
    'refuses an import of %s from a tree with no declared consumer',
    (door) => {
      const violations = rule.check(
        projectWith({ 'apps/web/src/thing.ts': `import { envConfig } from '${door}';\n` })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toBe('apps/web/src/thing.ts');
      expect(violations[0]?.line).toBe(1);
      expect(violations[0]?.message).toContain(door);
    }
  );

  it.each(DOOR_SPECIFIERS)('refuses a re-export of %s from such a tree', (door) => {
    const violations = rule.check(
      projectWith({ 'apps/web/src/barrel.ts': `export { envConfig } from '${door}';\n` })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(door);
  });

  it.each(DOOR_SPECIFIERS)('refuses a type-only import of %s', (door) => {
    const violations = rule.check(
      projectWith({ 'apps/web/src/thing.ts': `import type { VariableConfig } from '${door}';\n` })
    );

    expect(violations).toHaveLength(1);
  });

  it.each(DOOR_SPECIFIERS)('refuses a dynamic import of %s', (door) => {
    const violations = rule.check(
      projectWith({
        'apps/web/src/thing.ts': `export const load = async (): Promise<unknown> => import('${door}');\n`,
      })
    );

    expect(violations).toHaveLength(1);
  });

  it.each(DOOR_SPECIFIERS)('refuses an import of a module that re-exports %s', (door) => {
    const violations = rule.check(
      projectWith({
        'scripts/echo.ts': `export { envConfig } from '${door}';\n`,
        'apps/web/src/plain.ts': 'export const plain = 1;\n',
        // The two imports beside the laundered one are the shapes a laundering
        // check must pass over: a module that resolves and carries no door, and
        // a package specifier that resolves to no scanned module at all.
        'apps/web/src/thing.ts':
          "import { envConfig } from '../../../scripts/echo.js';\n" +
          "import { plain } from './plain.js';\n" +
          "import { z } from 'zod';\n" +
          'export const used = [envConfig, plain, z];\n',
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('apps/web/src/thing.ts');
    expect(violations[0]?.message).toContain('scripts/echo.ts');
  });

  it.each(DOOR_SPECIFIERS)('carries the taint of %s through a further re-export', (door) => {
    const violations = rule.check(
      projectWith({
        'scripts/echo.ts': `export { envConfig } from '${door}';\n`,
        'scripts/barrel.ts': "export * from './echo.js';\n",
        'apps/web/src/thing.ts': "import { envConfig } from '../../../scripts/barrel.js';\n",
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('apps/web/src/thing.ts');
  });

  it.each(DOOR_SPECIFIERS)('admits the scripts workspace importing %s', (door) => {
    expect(
      rule.check(projectWith({ 'scripts/seed.ts': `import { envConfig } from '${door}';\n` }))
    ).toEqual([]);
  });

  it.each(DOOR_SPECIFIERS)('admits the api tree importing %s', (door) => {
    expect(
      rule.check(
        projectWith({ 'apps/api/src/platform/thing.ts': `import { envConfig } from '${door}';\n` })
      )
    ).toEqual([]);
  });

  it.each(DOOR_SPECIFIERS)('admits a test file anywhere importing %s', (door) => {
    expect(
      rule.check(
        projectWith({ 'apps/web/src/thing.test.ts': `import { envConfig } from '${door}';\n` })
      )
    ).toEqual([]);
  });

  it('passes over an ordinary door imported from a browser tree', () => {
    expect(
      rule.check(
        projectWith({
          'apps/web/src/thing.ts': `import { clampDocumentText } from '${PACKAGE_NAME}${ORDINARY_DOOR.slice(1)}';\n`,
        })
      )
    ).toEqual([]);
  });

  it('passes over a reference whose specifier is not written out', () => {
    expect(
      rule.check(
        projectWith({
          'apps/web/src/thing.ts':
            "const load = require;\nexport const registry = load('./x.js');\n",
        })
      )
    ).toEqual([]);
  });

  // The taint leg reads static import and export declarations only, so it is
  // narrower than the door leg's every-form reach. A dynamic import or a
  // `require` of a laundering module is the gap that narrowness leaves; the
  // static-import case above is refused.
  it.each(DOOR_SPECIFIERS)('passes over a dynamic import of a module re-exporting %s', (door) => {
    expect(
      rule.check(
        projectWith({
          'scripts/echo.ts': `export { envConfig } from '${door}';\n`,
          'apps/web/src/thing.ts':
            "export const load = async (): Promise<unknown> => import('../../../scripts/echo.js');\n",
        })
      )
    ).toEqual([]);
  });

  it.each(DOOR_SPECIFIERS)('passes over a require of a module re-exporting %s', (door) => {
    expect(
      rule.check(
        projectWith({
          'scripts/echo.ts': `export { envConfig } from '${door}';\n`,
          'apps/web/src/thing.ts':
            'declare const require: (specifier: string) => unknown;\n' +
            "export const echoed = require('../../../scripts/echo.js');\n",
        })
      )
    ).toEqual([]);
  });

  // Only an `export … from` declaration launders, so a module republishing a
  // door through separate statements seeds no chain, and one standing
  // mid-chain continues none — the spellings below differ, the missing
  // module specifier does not.
  it.each(REPUBLICATIONS)(
    'passes over an import of a module republishing $door through a separate $form',
    ({ door, write }) => {
      expect(
        rule.check(
          projectWith({
            'scripts/echo.ts': write(door),
            'apps/web/src/thing.ts': "import { envConfig } from '../../../scripts/echo.js';\n",
          })
        )
      ).toEqual([]);
    }
  );

  it.each(REPUBLICATIONS)(
    'stops the taint of $door at a link republishing it through a separate $form',
    ({ door, write }) => {
      expect(
        rule.check(
          projectWith({
            'scripts/echo.ts': `export { envConfig } from '${door}';\n`,
            'scripts/relay.ts': write('./echo.js'),
            'apps/web/src/thing.ts': "import { envConfig } from '../../../scripts/relay.js';\n",
          })
        )
      ).toEqual([]);
    }
  );

  it.each(NODE_ONLY_DOORS)('throws when the manifest stops publishing %s', (subpath) => {
    const remaining = Object.fromEntries(
      Object.entries(DECLARED_EXPORTS).filter(([door]) => door !== subpath)
    );

    expect(() => rule.check(projectWith({}, remaining))).toThrow(
      /NODE_ONLY_DOORS names '.+', which packages\/shared\/package\.json does not publish/
    );
  });

  it('throws when the manifest publishes a pattern door the derivation cannot enumerate', () => {
    expect(() => rule.check(projectWith({}, { ...DECLARED_EXPORTS, './*': './src/*.ts' }))).toThrow(
      /pattern door/
    );
  });
});
