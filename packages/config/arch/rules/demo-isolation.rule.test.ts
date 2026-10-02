import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './demo-isolation.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('demo-isolation', () => {
  it('flags a static import of a demo internal from production code', () => {
    const project = projectWith({
      'apps/web/src/router.tsx': "import { seedSession } from './demo/seed-session';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/router.tsx', line: 1 });
    expect(violations[0]?.message).toContain('demo');
  });

  it('flags a static import of the demo bundle via the @/ alias', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "import { mountDemo } from '@/demo/bootstrap';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/thing.ts');
  });

  it('flags a static import reaching demo internals through a parent path', () => {
    const project = projectWith({
      'apps/web/src/components/x.tsx':
        "import { fetchShim } from '../demo/mock-backend/fetch-shim';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a named re-export of a demo internal from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/session.ts': "export { seedSession } from './demo/seed-session';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/session.ts', line: 1 });
    expect(violations[0]?.message).toContain('demo');
  });

  it('flags a wildcard re-export of the demo bundle via the @/ alias', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "export * from '@/demo/bootstrap';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/thing.ts');
  });

  it('flags a type-only re-export reaching demo internals through a parent path', () => {
    const project = projectWith({
      'apps/web/src/components/x.tsx':
        "export type { FetchShim } from '../demo/mock-backend/fetch-shim';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an import assignment of a demo internal from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/session.ts': "import seed = require('./demo/seed-session');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/session.ts', line: 1 });
  });

  it('flags a bare require of a demo internal from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "const seed = require('@/demo/seed-session');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/thing.ts', line: 1 });
  });

  it('flags a type-position import of a demo internal from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/types.ts': "export type Seed = import('./demo/seed-session').Seed;\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a glob of the demo directory from production code', () => {
    const project = projectWith({
      'apps/web/src/router.tsx': "const demos = import.meta.glob('./demo/*');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/router.tsx', line: 1 });
  });

  it('flags an eager glob of the whole web tree, whose wildcard enumerates the demo directory', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts':
        "const all = import.meta.glob('@/**/*.ts', { eager: true });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a glob anchored at the project root that descends into the demo directory', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const demos = import.meta.glob('/src/demo/*');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a glob whose wildcard reaches the demo directory through a parent path', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const some = import.meta.glob('../*/seed-session.ts');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a glob writing a pattern construct the segment matcher does not read', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const some = import.meta.glob('@/{demo,lib}/*');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags one violation for a glob list where a single pattern reaches the demo directory', () => {
    const project = projectWith({
      'apps/web/src/router.tsx':
        "const mixed = import.meta.glob(['./routes/*.tsx', './demo/*']);\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes a glob that cannot enumerate the demo directory', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const routes = import.meta.glob('./routes/**/*.tsx');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a glob too shallow to descend as far as the demo directory', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const top = import.meta.glob('/*');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a negated glob pattern, which excludes rather than enumerates', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const none = import.meta.glob('!./demo/**');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a bare glob pattern, which names a package rather than a path in this tree', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const bare = import.meta.glob('demo/*');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a glob whose pattern is not written out, which Vite refuses to build', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts':
        "const pattern = './demo/x';\nconst demos = import.meta.glob(pattern);\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a glob call written with no pattern at all, which Vite refuses to build', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': 'const none = import.meta.glob();\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an import.meta member that names a module without linking one', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const url = import.meta.resolve('./demo/seed-session');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a call that is neither a glob nor a module loader', () => {
    const project = projectWith({
      'apps/web/src/lib/registry.ts': "const value = describe('./demo/seed-session');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes re-exports of production modules, including the is-demo-path helper', () => {
    const project = projectWith({
      'apps/web/src/lib/index.ts':
        "export { isDemoPath } from './is-demo-path';\n" +
        "export * from '@/lib/api-client';\n" +
        "export type { Session } from '../hooks/session';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an export with no module specifier', () => {
    const project = projectWith({
      'apps/web/src/lib/local.ts': 'const demo = 1;\nexport { demo };\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes demo-internal re-exports (a demo barrel re-exporting demo files)', () => {
    const project = projectWith({
      'apps/web/src/demo/index.ts':
        "export { seedSession } from './seed-session';\n" +
        "export * from './mock-backend/fetch-shim';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes main.tsx dynamic import of the demo bundle', () => {
    const project = projectWith({
      'apps/web/src/main.tsx':
        "import { isDemoPath } from './lib/is-demo-path';\n" +
        'if (isDemoPath(location.pathname)) {\n' +
        "  const demo = await import('./demo/bootstrap');\n" +
        '  demo.mountDemo();\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes demo-internal imports (a demo file importing another demo file)', () => {
    const project = projectWith({
      'apps/web/src/demo/bootstrap.tsx':
        "import { seedSession } from './seed-session';\n" +
        "import { installFetchShim } from './mock-backend/fetch-shim';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag the is-demo-path helper import (not the demo directory)', () => {
    const project = projectWith({
      'apps/web/src/components/banner/announcement-banner.tsx':
        "import { isDemoPath } from '@/lib/is-demo-path';\n",
      'apps/web/src/main.tsx': "import { isDemoPath } from './lib/is-demo-path';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files that import demo internals directly', () => {
    const project = projectWith({
      'apps/web/src/demo/seed-session.test.ts': "import { seedSession } from './seed-session';\n",
      'apps/web/src/lib/is-demo-path.test.ts':
        "import { seedSession } from '../demo/seed-session';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the apps/web/src tree', () => {
    const project = projectWith({
      'apps/api/src/lib/thing.ts': "import { x } from '../demo/seed-session';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });
});
