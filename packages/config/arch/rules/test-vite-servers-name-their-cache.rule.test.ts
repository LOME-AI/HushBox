import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './test-vite-servers-name-their-cache.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('test-vite-servers-name-their-cache', () => {
  it('flags a test that starts a Vite server with no cacheDir', () => {
    const project = projectWith({
      'apps/web/src/components/x.browser.test.ts':
        "import { createServer } from 'vite';\nconst server = await createServer({ root });\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2 });
    expect(violations[0]?.message).toContain('cacheDir');
  });

  it('leaves a test that names its cacheDir alone', () => {
    const project = projectWith({
      'apps/web/src/components/x.browser.test.ts':
        "import { createServer } from 'vite';\nconst server = await createServer({ root, cacheDir: dir });\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a cacheDir written in shorthand alone', () => {
    const project = projectWith({
      'apps/web/src/components/x.browser.test.tsx':
        "import { createServer } from 'vite';\nconst server = await createServer({ root, cacheDir });\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves production code alone', () => {
    const project = projectWith({
      'apps/docket/src/server/start.ts':
        "import { createServer } from 'vite';\nconst server = await createServer({ root });\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('flags the call under an aliased import', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts':
        "import { createServer as startVite } from 'vite';\nawait startVite({ root });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the call through a namespace import', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts':
        "import * as vite from 'vite';\nawait vite.createServer({ root });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a call whose config is not an inline object, since nothing shows a cacheDir in it', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts':
        "import { createServer } from 'vite';\nawait createServer(config);\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a call with no config at all', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts': "import { createServer } from 'vite';\nawait createServer();\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('leaves a createServer imported from another module alone', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts':
        "import { createServer } from 'node:http';\nconst server = createServer(handler);\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves another Vite export called through the namespace alone', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts':
        "import * as vite from 'vite';\nconst config = vite.defineConfig({ root });\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a call whose callee is itself a call alone', () => {
    const project = projectWith({
      'scripts/lib/x.test.ts':
        "import { createServer } from 'vite';\nconst server = makeServer()({ root });\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });
});
