import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './published-doors-declare-a-node-runtime.rule.js';

/**
 * The rule reads the guarded package's manifest off the project's file system
 * and every module out of the parsed source files, so a fixture writes both:
 * the exports map and the runtime declaration as manifest text, every module as
 * a real source file, all under {@link REPO_ROOT}. Nothing here touches the
 * repository: a violating door exists only inside an in-memory project, so the
 * firing evidence costs the working tree nothing.
 */

const PACKAGE_DIR = 'packages/shared';
const MANIFEST_PATH = `${PACKAGE_DIR}/package.json`;

interface ManifestFields {
  readonly exports: Record<string, string>;
  readonly nodeRuntimeDoors?: unknown;
}

function manifestWith({ exports, nodeRuntimeDoors }: ManifestFields): string {
  return JSON.stringify(
    {
      name: '@hushbox/shared',
      exports,
      ...(nodeRuntimeDoors === undefined ? {} : { nodeRuntimeDoors }),
    },
    null,
    2
  );
}

function projectWith(manifest: string, files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.getFileSystem().writeFileSync(path.join(REPO_ROOT, MANIFEST_PATH), manifest);
  for (const [relative, contents] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), contents, { overwrite: true });
  }
  return project;
}

/** The message the rule refuses a fixture with, so a case can read what it says. */
function refusalFor(manifest: string, files: Record<string, string>): string {
  try {
    rule.check(projectWith(manifest, files));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the rule returned rather than refusing, so there is no account to read');
}

describe('a browser-facing door whose closure reaches a Node built-in', () => {
  it('flags the door, pointing at the edge that pulls the built-in in', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { './cache': './src/cache.ts' } }), {
        [`${PACKAGE_DIR}/src/cache.ts`]:
          "import { size } from './size.js';\nimport { readFileSync } from 'node:fs';\nexport const read = { size, readFileSync };\n",
        [`${PACKAGE_DIR}/src/size.ts`]: 'export const size = 1;\n',
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(`${PACKAGE_DIR}/src/cache.ts`);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.message).toContain("'./cache'");
    expect(violations[0]?.message).toContain("'node:fs'");
  });

  it('prints the chain from the door to the edge, so the module to change is visible', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { '.': './src/index.ts' } }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export * from './cache.js';\n",
        [`${PACKAGE_DIR}/src/cache.ts`]: "export { readFileSync } from 'node:fs';\n",
      })
    );

    expect(violations[0]?.message).toContain(
      `${PACKAGE_DIR}/src/index.ts -> ${PACKAGE_DIR}/src/cache.ts -> node:fs`
    );
  });

  it('reads a built-in named without its prefix, which resolves to the same module', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { './cache': './src/cache.ts' } }), {
        [`${PACKAGE_DIR}/src/cache.ts`]: "export { readFileSync } from 'fs';\n",
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'fs'");
  });

  it('names the remedy: declare the door in the manifest, or cut the edge', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { './cache': './src/cache.ts' } }), {
        [`${PACKAGE_DIR}/src/cache.ts`]: "export { readFileSync } from 'node:fs';\n",
      })
    );

    expect(violations[0]?.message).toContain('nodeRuntimeDoors');
    expect(violations[0]?.message).toContain(MANIFEST_PATH);
  });

  it('flags each such door, so one fix does not hide the next', () => {
    const violations = rule.check(
      projectWith(
        manifestWith({ exports: { './cache': './src/cache.ts', './log': './src/log.ts' } }),
        {
          [`${PACKAGE_DIR}/src/cache.ts`]: "export { readFileSync } from 'node:fs';\n",
          [`${PACKAGE_DIR}/src/log.ts`]: "export { hostname } from 'node:os';\n",
        }
      )
    );

    expect(violations).toHaveLength(2);
  });
});

describe('a door the manifest declares as needing a Node runtime', () => {
  it('is admitted where the same closure is refused undeclared', () => {
    const files = {
      [`${PACKAGE_DIR}/src/cache.ts`]: "export { readFileSync } from 'node:fs';\n",
    };

    expect(
      rule.check(
        projectWith(
          manifestWith({
            exports: { './cache': './src/cache.ts' },
            nodeRuntimeDoors: ['./cache'],
          }),
          files
        )
      )
    ).toEqual([]);
    expect(
      rule.check(projectWith(manifestWith({ exports: { './cache': './src/cache.ts' } }), files))
    ).toHaveLength(1);
  });

  it('is refused when the manifest publishes no such door', () => {
    const message = refusalFor(
      manifestWith({ exports: { './cache': './src/cache.ts' }, nodeRuntimeDoors: ['./gone'] }),
      { [`${PACKAGE_DIR}/src/cache.ts`]: 'export const cache = 1;\n' }
    );

    expect(message).toContain("'./gone'");
    expect(message).toContain('does not publish');
  });

  it('is refused when its closure reaches no built-in, so a dead declaration is dropped', () => {
    const message = refusalFor(
      manifestWith({ exports: { './cache': './src/cache.ts' }, nodeRuntimeDoors: ['./cache'] }),
      { [`${PACKAGE_DIR}/src/cache.ts`]: 'export const cache = 1;\n' }
    );

    expect(message).toContain("'./cache'");
    expect(message).toContain('drop the entry');
  });
});

describe('the runtime declaration itself', () => {
  it('is optional, so a package publishing no such door needs no field', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { './cache': './src/cache.ts' } }), {
        [`${PACKAGE_DIR}/src/cache.ts`]: 'export const cache = 1;\n',
      })
    );

    expect(violations).toEqual([]);
  });

  it('is refused when it is not a list of subpaths, rather than read as empty', () => {
    const message = refusalFor(
      manifestWith({ exports: { './cache': './src/cache.ts' }, nodeRuntimeDoors: './cache' }),
      { [`${PACKAGE_DIR}/src/cache.ts`]: "export { readFileSync } from 'node:fs';\n" }
    );

    expect(message).toContain('nodeRuntimeDoors');
    expect(message).toContain('list of subpaths');
  });
});

describe('a door reaching nothing this rule refuses', () => {
  it('passes when its closure leaves the repository through a third-party package', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { './cache': './src/cache.ts' } }), {
        [`${PACKAGE_DIR}/src/cache.ts`]: "export { z } from 'zod';\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('passes when a sibling door it opens by the package specifier reaches no built-in', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { '.': './src/index.ts', './size': './src/size.ts' } }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export { size } from '@hushbox/shared/size';\n",
        [`${PACKAGE_DIR}/src/size.ts`]: 'export const size = 1;\n',
      })
    );

    expect(violations).toEqual([]);
  });

  it('flags a built-in reached through a sibling door, which a bundler inlines the same way', () => {
    const violations = rule.check(
      projectWith(manifestWith({ exports: { '.': './src/index.ts', './size': './src/size.ts' } }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export { size } from '@hushbox/shared/size';\n",
        [`${PACKAGE_DIR}/src/size.ts`]: "export { size } from 'node:os';\n",
      })
    );

    expect(violations).toHaveLength(2);
  });
});
