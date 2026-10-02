import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './playwright-projects-from-registry.rule.js';

/**
 * The rule reads the repo-root Playwright config off the project's file system
 * rather than its parsed source files — the layer's globs select no root file —
 * so every fixture writes a real path under {@link REPO_ROOT} into an in-memory
 * one.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  const fileSystem = project.getFileSystem();
  for (const [relative, contents] of Object.entries(files)) {
    fileSystem.writeFileSync(path.join(REPO_ROOT, relative), contents);
  }
  return project;
}

const REGISTRY_IMPORT =
  "import { BROWSER_MATRIX_PROJECTS, PLANE_PROJECTS } from './scripts/lib/playwright/projects';";

/**
 * A config whose whole `projects` array sits on one line, so every fixture's
 * violation lands on the same known line and the expectations stay literal.
 */
function configWith(projects: string, head: readonly string[] = [REGISTRY_IMPORT]): string {
  return [
    "import { defineConfig } from '@playwright/test';",
    ...head,
    '',
    'export default defineConfig({',
    `  projects: ${projects},`,
    '});',
    '',
  ].join('\n');
}

const DERIVED = '[...PLANE_PROJECTS.map(testProject), ...BROWSER_MATRIX_PROJECTS.map(testProject)]';

describe('playwright-projects-from-registry', () => {
  it('accepts an array composed only of spreads over registry imports', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(DERIVED, [
        REGISTRY_IMPORT,
        "import './e2e/register-hooks';",
        "import playwright from '@playwright/test';",
      ]),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a bare registry spread with no mapper', () => {
    const project = projectWith({ 'playwright.config.ts': configWith('[...PLANE_PROJECTS]') });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a registry export bound under an alias', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('[...PLANES.map(testProject)]', [
        "import { PLANE_PROJECTS as PLANES } from './scripts/lib/playwright/projects.js';",
      ]),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a registry list reached through a namespace import', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('[...registry.PLANE_PROJECTS.map(testProject)]', [
        "import * as registry from './scripts/lib/playwright/projects';",
      ]),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('flags an object literal appended to the array', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(
        "[...PLANE_PROJECTS.map(testProject), { name: 'experiment', use: {} }]"
      ),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 5,
        message:
          'playwright.config.ts writes a Playwright project into its projects array by hand. ' +
          'Which projects exist is stated once, in scripts/lib/playwright/projects.ts, and the CI ' +
          'matrix is generated from it — so a project written here runs locally and in no CI ' +
          'job. Add it to E2E_PROJECTS there, give it a PROJECT_SETTINGS entry, and let the ' +
          'existing spreads carry it.',
      },
    ]);
  });

  it('flags a project literal spread in through an array literal', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(
        "[...PLANE_PROJECTS.map(testProject), ...[{ name: 'experiment' }]]"
      ),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 5,
        message:
          'playwright.config.ts spreads "[{ name: \'experiment\' }]" into its projects array, ' +
          'which is not a value imported from scripts/lib/playwright/projects.ts. A list built ' +
          'anywhere else can carry a project the generated CI matrix never sees. Spread a ' +
          'registry export instead, optionally through .map(...).',
      },
    ]);
  });

  it('flags a spread of a locally assembled list', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(
        '[...PLANE_PROJECTS.map(testProject), ...EXTRA_PROJECTS]',
        [REGISTRY_IMPORT, "const EXTRA_PROJECTS = [{ name: 'experiment' }];"]
      ),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 6,
        message:
          'playwright.config.ts spreads "EXTRA_PROJECTS" into its projects array, which is not ' +
          'a value imported from scripts/lib/playwright/projects.ts. A list built anywhere else can ' +
          'carry a project the generated CI matrix never sees. Spread a registry export ' +
          'instead, optionally through .map(...).',
      },
    ]);
  });

  it('flags a conditionally appended project', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(
        "[...PLANE_PROJECTS.map(testProject), ...(isCI ? [] : [{ name: 'experiment' }])]"
      ),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 5,
        message:
          'playwright.config.ts spreads "isCI ? [] : [{ name: \'experiment\' }]" into its ' +
          'projects array, which is not a value imported from scripts/lib/playwright/projects.ts. A ' +
          'list built anywhere else can carry a project the generated CI matrix never sees. ' +
          'Spread a registry export instead, optionally through .map(...).',
      },
    ]);
  });

  it('flags a registry list narrowed by a call other than map', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(
        "[...BROWSER_MATRIX_PROJECTS.filter((name) => name !== 'webkit').map(testProject)]"
      ),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 5,
        message:
          'playwright.config.ts applies .filter(...) to a registry list on the way into its ' +
          'projects array. Only .map(...) may sit in between: anything else drops projects ' +
          'locally or adds ones the generated CI matrix never sees. Change what ' +
          'scripts/lib/playwright/projects.ts exports instead.',
      },
    ]);
  });

  it('flags a projects value that is not an array literal', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('buildProjects()'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 5,
        message:
          "playwright.config.ts's projects must be an array literal of spreads over " +
          'scripts/lib/playwright/projects.ts exports. A computed value hides which projects exist ' +
          'from this rule and from anyone reading the config; compose the array inline.',
      },
    ]);
  });

  it('checks a quoted projects key as well as a bare one', () => {
    const project = projectWith({
      'playwright.config.ts': configWith("[{ name: 'experiment' }]").replace(
        'projects:',
        "'projects':"
      ),
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a quoted key that is not projects', () => {
    const project = projectWith({
      'playwright.config.ts': configWith(DERIVED).replace(
        'export default defineConfig({',
        "export default defineConfig({\n  metadata: { 'run-label': 'local' },"
      ),
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('flags a project list mutated after the config literal', () => {
    const project = projectWith({
      'playwright.config.ts': [
        configWith(DERIVED).replace(
          'export default defineConfig({',
          'const config = defineConfig({'
        ),
        "config.projects.push({ name: 'experiment' });",
        'export default config;',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 8,
        message:
          'playwright.config.ts reaches a .projects member. The project list is composed ' +
          'exactly once, in the config literal, from spreads over ' +
          'scripts/lib/playwright/projects.ts, and nothing in this file may reach it again — ' +
          'writing to it (push, reassign) adds projects the generated CI matrix never sees, ' +
          'and reading it back (mapping it for names or counts) asks the config a question ' +
          'scripts/lib/playwright/projects.ts already answers. Derive from a registry export instead.',
      },
    ]);
  });

  it('flags a read of the assembled project list, not only a write', () => {
    const project = projectWith({
      'playwright.config.ts': [
        configWith(DERIVED).replace(
          'export default defineConfig({',
          'const config = defineConfig({'
        ),
        'const names = config.projects.map((project) => project.name);',
        'export default config;',
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a config that declares no projects at all', () => {
    const project = projectWith({
      'playwright.config.ts': [
        "import { defineConfig } from '@playwright/test';",
        '',
        "export default defineConfig({ testDir: './e2e' });",
        '',
      ].join('\n'),
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'playwright.config.ts',
        line: 1,
        message:
          'playwright.config.ts declares no projects array. The Playwright projects are the ' +
          "run's units of work and the generated CI matrix derives from them; compose them " +
          'in a projects array of spreads over scripts/lib/playwright/projects.ts exports.',
      },
    ]);
  });

  it('flags a missing config rather than passing silently', () => {
    expect(rule.check(projectWith({}))).toEqual([
      {
        file: 'playwright.config.ts',
        line: 1,
        message:
          'playwright.config.ts is missing from the repository root, where this rule reads ' +
          'it. It is the only gate keeping the Playwright project list derived from ' +
          'scripts/lib/playwright/projects.ts; if the config moved, point this rule at its new path ' +
          'in the same change.',
      },
    ]);
  });

  it('ignores a same-named import from another module', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('[...PLANE_PROJECTS.map(testProject)]', [
        "import { PLANE_PROJECTS } from './scripts/lib/other-projects';",
      ]),
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a default import of the registry, which exports no default', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('[...registryDefault.map(testProject)]', [
        "import registryDefault from './scripts/lib/playwright/projects';",
      ]),
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an inline type-only specifier as a source of values', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('[...ProjectName.map(testProject)]', [
        "import { PLANE_PROJECTS, type ProjectName } from './scripts/lib/playwright/projects';",
      ]),
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a type-only registry import as a source of values', () => {
    const project = projectWith({
      'playwright.config.ts': configWith('[...ProjectName.map(testProject)]', [
        "import type { ProjectName } from './scripts/lib/playwright/projects';",
      ]),
    });
    expect(rule.check(project)).toHaveLength(1);
  });
});
