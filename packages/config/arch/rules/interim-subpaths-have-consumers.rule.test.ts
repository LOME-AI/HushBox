import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './interim-subpaths-have-consumers.rule.js';

/**
 * The rule reads the shared package's manifest off the project's file system
 * and its consumers out of the parsed source files, so a fixture writes both:
 * the manifest as text, every consumer as a real source file, all under
 * {@link REPO_ROOT}.
 */
function manifestWith(subpaths: readonly string[]): string {
  return JSON.stringify(
    {
      name: '@hushbox/shared',
      exports: Object.fromEntries([
        ['.', './src/index.ts'],
        ['./affordability', './src/affordability/index.ts'],
        ...subpaths.map((subpath) => [subpath, `./src${subpath.slice(1)}.ts`]),
        ['./models', './src/models/index.ts'],
      ]),
    },
    null,
    2
  );
}

const MANIFEST_PATH = 'packages/shared/package.json';
const CONSUMER = 'apps/api/src/slices/models/domain/estimate-run.ts';

function projectWith(manifest: string, files: Record<string, string> = {}): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.getFileSystem().writeFileSync(path.join(REPO_ROOT, MANIFEST_PATH), manifest);
  for (const [relative, contents] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), contents);
  }
  return project;
}

/** The manifest line a violation points at, read back out of the fixture text. */
function pointedLine(manifest: string, line: number): string {
  return manifest.split('\n')[line - 1] ?? '';
}

describe('a published door with no consumer', () => {
  it('flags the entry, at its own line in the exports map', () => {
    const manifest = manifestWith(['./affordability/budget']);

    const violations = rule.check(projectWith(manifest));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(MANIFEST_PATH);
    expect(pointedLine(manifest, violations[0]?.line ?? 0)).toContain('"./affordability/budget"');
    expect(violations[0]?.message).toContain("'./affordability/budget'");
  });

  it('names both places the entry lives, so neither half is left behind', () => {
    const violations = rule.check(projectWith(manifestWith(['./affordability/budget'])));

    expect(violations[0]?.message).toContain('packages/shared/package.json');
    expect(violations[0]?.message).toContain('INTERIM_UNIT_SUBPATHS');
    expect(violations[0]?.message).toContain('packages/shared/src/affordability/index.test.ts');
  });

  it('flags every consumerless door rather than only the first', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/budget', './affordability/constants']))
    );

    expect(violations).toHaveLength(2);
  });
});

describe('what counts as a consumer', () => {
  it('accepts a door a file imports', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/constants']), {
        [CONSUMER]:
          "import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('accepts a door reached by a type-only import, which erases before runtime', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/estimate/types']), {
        [CONSUMER]:
          "import type { Manifest } from '@hushbox/shared/affordability/estimate/types';\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('accepts a door reached only by a RE-EXPORT, which an import-only scan misses', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/constants']), {
        [CONSUMER]:
          "export { MINIMUM_OUTPUT_TOKENS as ANSWER_FLOOR } from '@hushbox/shared/affordability/constants';\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('accepts a door reached by a string-literal call — a dynamic import or a mock', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/estimate/reducers']), {
        [CONSUMER]: "vi.mock('@hushbox/shared/affordability/estimate/reducers');\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('rejects a mention in a comment, which binds no module', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/budget']), {
        [CONSUMER]: "// see '@hushbox/shared/affordability/budget' for the ladder\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('rejects the specifier written as a plain string, the shape a fixture corpus holds', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/budget']), {
        [CONSUMER]: 'const source = "import x from \'@hushbox/shared/affordability/budget\';";\n',
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('rejects the declaring package reaching its own unit relatively, which uses no door', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/budget']), {
        'packages/shared/src/index.ts':
          "export { generateNotifications } from './affordability/budget.js';\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('rejects the declaring package reaching the door by specifier, which is self-reference', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/budget']), {
        'packages/shared/src/affordability/turn-options.ts':
          "import { generateNotifications } from '@hushbox/shared/affordability/budget';\n",
      })
    );

    expect(violations).toHaveLength(1);
  });
});

describe('a consumer whose door is gone', () => {
  it('flags the reach at its own line, so removing a live entry cannot be silent', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/constants']), {
        [CONSUMER]:
          "import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';\n" +
          "import { effectiveCompletionCap } from '@hushbox/shared/affordability/completion-cap';\n",
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(CONSUMER);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.message).toContain('@hushbox/shared/affordability/completion-cap');
  });

  it('names both places the entry must be restored', () => {
    const violations = rule.check(
      projectWith(manifestWith([]), {
        [CONSUMER]:
          "import { effectiveCompletionCap } from '@hushbox/shared/affordability/completion-cap';\n",
      })
    );

    expect(violations[0]?.message).toContain('packages/shared/package.json');
    expect(violations[0]?.message).toContain('INTERIM_UNIT_SUBPATHS');
  });

  it('reports one violation per undeclared door, not one per reach of it', () => {
    const violations = rule.check(
      projectWith(manifestWith([]), {
        [CONSUMER]:
          "import { effectiveCompletionCap } from '@hushbox/shared/affordability/completion-cap';\n",
        'apps/api/src/slices/chat/domain/turn-definition.ts':
          "import { effectiveCompletionCap } from '@hushbox/shared/affordability/completion-cap';\n",
      })
    );

    expect(violations).toHaveLength(1);
  });
});

describe('what the rule stands over', () => {
  it('passes a manifest whose interim doors all carry a consumer', () => {
    const violations = rule.check(
      projectWith(manifestWith(['./affordability/constants', './affordability/completion-cap']), {
        [CONSUMER]:
          "import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';\n" +
          "import { effectiveCompletionCap } from '@hushbox/shared/affordability/completion-cap';\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('ignores the affordability barrel itself, which is a sanctioned door', () => {
    const violations = rule.check(
      projectWith(manifestWith([]), {
        [CONSUMER]: "import { priceableModelFrom } from '@hushbox/shared/affordability';\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('ignores exports map entries outside the affordability module', () => {
    expect(rule.check(projectWith(manifestWith([])))).toEqual([]);
  });
});
