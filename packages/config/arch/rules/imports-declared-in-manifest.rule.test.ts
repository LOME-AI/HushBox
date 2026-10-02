import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './imports-declared-in-manifest.rule.js';

/**
 * The rule reads whole workspaces off the project's file system rather than
 * its parsed source files, so every fixture writes real paths under
 * {@link REPO_ROOT} into an in-memory file system.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  const fileSystem = project.getFileSystem();
  for (const [relative, contents] of Object.entries(files)) {
    fileSystem.writeFileSync(path.join(REPO_ROOT, relative), contents);
  }
  return project;
}

const manifest = (name: string, sections: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, ...sections });

describe('imports-declared-in-manifest', () => {
  it('flags a bare import the workspace manifest declares nowhere', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)).toEqual([
      {
        file: 'apps/alpha/src/index.ts',
        line: 1,
        message:
          '@hushbox/alpha imports "execa" but its own package.json declares it nowhere. Resolution succeeds today only because a hoisted copy sits higher in the tree.',
      },
    ]);
  });

  it('accepts an import declared in dependencies', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        dependencies: { execa: '^9.6.1' },
      }),
      'apps/alpha/src/index.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an import declared in devDependencies', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        devDependencies: { vitest: '^4.1.10' },
      }),
      'apps/alpha/src/index.test.ts': "import { it } from 'vitest';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an import declared in peerDependencies', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        peerDependencies: { react: '^19.2.7' },
      }),
      'apps/alpha/src/index.ts': "import React from 'react';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an import declared in optionalDependencies', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        optionalDependencies: { sharp: '^0.34.5' },
      }),
      'apps/alpha/src/index.ts': "import sharp from 'sharp';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('still flags an import that only the root workspace declares', () => {
    const project = projectWith({
      'package.json': manifest('hushbox', { devDependencies: { execa: '^9.6.1' } }),
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a Node builtin written with the node: scheme', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import path from 'node:path';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a Node builtin written as a bare name', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import path from 'path';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a runtime module namespace no package name can spell', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { DurableObject } from 'cloudflare:workers';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a relative specifier', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { helper } from './helper.js';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores the repo-local path alias', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { helper } from '@/lib/helper';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a package-internal subpath import', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { helper } from '#internal/helper';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a workspace importing its own package name', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { helper } from '@hushbox/alpha/helper';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('resolves an unscoped subpath specifier to its package name', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        dependencies: { 'drizzle-orm': '^0.45.2' },
      }),
      'apps/alpha/src/index.ts': "import { pgTable } from 'drizzle-orm/pg-core';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('resolves a scoped subpath specifier to its scope and name', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        dependencies: { '@hushbox/shared': 'workspace:*' },
      }),
      'apps/alpha/src/index.ts': "import { schema } from '@hushbox/shared/documents';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a type-only import satisfied by an @types declaration', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        devDependencies: { '@types/adm-zip': '0.5.8' },
      }),
      'apps/alpha/src/index.ts': "import type AdmZip from 'adm-zip';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('flags a value import that only an @types declaration covers', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        devDependencies: { '@types/adm-zip': '0.5.8' },
      }),
      'apps/alpha/src/index.ts': "import AdmZip from 'adm-zip';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a scoped type-only import through its mangled @types name', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha', {
        devDependencies: { '@types/playwright__test': '1.0.0' },
      }),
      'apps/alpha/src/index.ts': "import type { Reporter } from '@playwright/test/reporter';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('flags an undeclared package reached by a dynamic import', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "export const load = async () => import('dotenv');\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an undeclared package reached by require', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.cjs': "const ws = require('ws');\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an undeclared package reached by a re-export', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "export { retry } from 'cockatiel';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an undeclared package reached by a side-effect import', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import 'katex/dist/katex.min.css';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an undeclared package reached by an inline import type', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "export type Zip = import('adm-zip').default;\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('skips a fixture corpus, whose imports are analysed text rather than code', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/__test-fixtures-boundaries__/violating.ts': "import { z } from 'zod';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('skips build output', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/dist/bundle.js': "import x from '@emotion/is-prop-valid';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('skips a static asset root', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/public/vendored.mjs': "const ws = require('ws');\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('skips installed dependencies', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/node_modules/dep/index.js': "import x from 'undeclared-transitive';\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('reports one violation per package however many sites import it', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/a.ts': "import { execa } from 'execa';\n",
      'apps/alpha/src/b.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports the first import site in path order', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/a.ts': "import { execa } from 'execa';\n",
      'apps/alpha/src/b.ts': "\nimport { execa } from 'execa';\n",
    });
    expect(rule.check(project)[0]).toMatchObject({ file: 'apps/alpha/src/a.ts', line: 1 });
  });

  it('reports every workspace, not only the first with a violation', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import { execa } from 'execa';\n",
      'packages/beta/package.json': manifest('@hushbox/beta'),
      'packages/beta/src/index.ts': "import { it } from 'vitest';\n",
    });
    expect(rule.check(project)).toHaveLength(2);
  });

  it('tolerates a workspace with no source files', () => {
    const project = projectWith({ 'apps/alpha/package.json': manifest('@hushbox/alpha') });
    expect(rule.check(project)).toEqual([]);
  });

  it('flags an undeclared package reached by an import-equals declaration', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "import archiver = require('archiver');\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an export that names no module', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': 'const value = 1;\nexport { value };\n',
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a dynamic import whose specifier is not a literal', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': 'export const load = async (n: string) => import(n);\n',
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a call that is neither import nor require', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': "declare function load(s: string): void;\nload('execa');\n",
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an import declaration whose specifier the parser did not read as a string', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': 'import execa from execa;\n',
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an inline import type whose argument is a type rather than a literal', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': 'export type Zip = import(Elsewhere).default;\n',
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an inline import type whose literal is not a string', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts': 'export type Zip = import(123).default;\n',
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an import-equals that aliases a namespace rather than a module', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/index.ts':
        'namespace Outer {\n  export const value = 1;\n}\nimport Inner = Outer.value;\n',
    });
    expect(rule.check(project)).toEqual([]);
  });

  it('parses a file whose extension makes JSX legal syntax', () => {
    const project = projectWith({
      'apps/alpha/package.json': manifest('@hushbox/alpha'),
      'apps/alpha/src/view.tsx':
        "import { motion } from 'framer-motion';\nexport const V = () => <div />;\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a manifest section that holds no object', () => {
    const project = projectWith({
      'apps/alpha/package.json': JSON.stringify({
        name: '@hushbox/alpha',
        dependencies: null,
      }),
      'apps/alpha/src/index.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });

  it('names an unnamed workspace by its path', () => {
    const project = projectWith({
      'apps/alpha/package.json': JSON.stringify({ version: '0.0.0' }),
      'apps/alpha/src/index.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)[0]?.message).toMatch(/^apps\/alpha imports "execa"/);
  });

  it('reads a workspace the manifest names outright, not only a collection member', () => {
    const project = projectWith({
      'scripts/package.json': manifest('@hushbox/scripts'),
      'scripts/build.ts': "import { execa } from 'execa';\n",
    });
    expect(rule.check(project)).toHaveLength(1);
  });
});
