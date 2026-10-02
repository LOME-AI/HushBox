import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countLinesOfCode, isCountedPath } from './lines-of-code.js';

describe('countLinesOfCode', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'lines-of-code-test-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function write(relativePath: string, contents: string): void {
    const absolute = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  it('counts the physical lines of a single file', () => {
    write('app.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    expect(countLinesOfCode(rootDir)).toBe(3);
  });

  it('counts a final line without a trailing newline', () => {
    write('app.ts', 'const a = 1;\nconst b = 2;');

    expect(countLinesOfCode(rootDir)).toBe(2);
  });

  it('sums lines across multiple files', () => {
    write('a.ts', 'one\ntwo\n');
    write('b.tsx', 'one\ntwo\nthree\n');

    expect(countLinesOfCode(rootDir)).toBe(5);
  });

  it('recurses into nested directories', () => {
    write('top.ts', 'a\n');
    write('packages/web/src/deep.ts', 'a\nb\n');

    expect(countLinesOfCode(rootDir)).toBe(3);
  });

  it('counts code, style, and markup source extensions', () => {
    for (const extension of [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'css',
      'scss',
      'html',
      'astro',
    ]) {
      write(`file.${extension}`, 'a\n');
    }

    expect(countLinesOfCode(rootDir)).toBe(10);
  });

  it('counts config, CI workflow, script, and documentation extensions', () => {
    for (const extension of ['json', 'yml', 'yaml', 'toml', 'sh', 'mermaid', 'md', 'mdx']) {
      write(`file.${extension}`, 'a\n');
    }

    expect(countLinesOfCode(rootDir)).toBe(8);
  });

  it('counts dev tooling under the .claude directory', () => {
    write('app.ts', 'a\n');
    write('.claude/hooks/hook.mjs', 'x\ny\n');
    write('.claude/skills/skill.md', 'x\n');

    expect(countLinesOfCode(rootDir)).toBe(4);
  });

  it('ignores binary and unlisted file types', () => {
    write('app.ts', 'a\nb\n');
    write('logo.png', 'binary\n');
    write('font.woff2', 'binary\n');
    write('data.bin', 'binary\n');

    expect(countLinesOfCode(rootDir)).toBe(2);
  });

  it('skips dependency, build, and VCS directories', () => {
    write('app.ts', 'a\n');
    write('node_modules/pkg/index.ts', 'x\ny\nz\n');
    write('dist/bundle.js', 'x\ny\n');
    write('coverage/cov.ts', 'x\n');
    write('.git/hooks/pre-commit.js', 'x\n');

    expect(countLinesOfCode(rootDir)).toBe(1);
  });

  it('skips generated report, artifact, and migration directories', () => {
    write('app.ts', 'a\n');
    write('e2e/report/2026-01-01/bundle.js', 'x\ny\nz\n');
    write('playwright-report/index.html', 'x\ny\n');
    write('test-results/run/trace.js', 'x\n');
    write('maestro-results/out.js', 'x\n');
    write('e2e/.auth/state.ts', 'x\n');
    write('reports/jscpd/report.json', 'x\ny\n');
    write('packages/db/drizzle/0001_snapshot.json', 'x\ny\nz\n');

    expect(countLinesOfCode(rootDir)).toBe(1);
  });

  it('skips markdown under the process-record doc directories', () => {
    write('app.ts', 'a\n');
    write('docs/plans/runs/2026-01-01-run/plan.md', 'x\ny\nz\n');
    write('docs/audits/2026-01-01/f01.md', 'x\ny\n');
    write('docs/history/superseded.md', 'x\n');
    write('docs/decisions/0001-choice.md', 'x\n');

    expect(countLinesOfCode(rootDir)).toBe(1);
  });

  it('counts non-markdown files inside the process-record doc directories', () => {
    write('docs/plans/behavioral-spec/spec.ts', 'a\nb\n');
    write('docs/audits/2026-01-01/report.json', 'a\n');

    expect(countLinesOfCode(rootDir)).toBe(3);
  });

  it('counts markdown outside the process-record doc directories', () => {
    write('docs/DESIGN.md', 'a\n');
    write('plans/note.md', 'b\n');
    write('apps/web/docs/history/note.md', 'c\n');

    expect(countLinesOfCode(rootDir)).toBe(3);
  });

  it('skips auto-generated source files', () => {
    write('app.ts', 'a\nb\n');
    write('routeTree.gen.ts', 'x\ny\nz\n');
    write('src/client.gen.tsx', 'x\n');

    expect(countLinesOfCode(rootDir)).toBe(2);
  });

  it('skips dependency lockfiles', () => {
    write('app.ts', 'a\n');
    write('pnpm-lock.yaml', 'x\ny\nz\n');
    write('apps/web/package-lock.json', 'x\ny\n');
    write('yarn.lock', 'x\n');

    expect(countLinesOfCode(rootDir)).toBe(1);
  });

  it('counts an empty file as zero lines', () => {
    write('empty.ts', '');
    write('app.ts', 'a\n');

    expect(countLinesOfCode(rootDir)).toBe(1);
  });

  it('returns zero when only unlisted files exist', () => {
    write('logo.png', 'binary\n');

    expect(countLinesOfCode(rootDir)).toBe(0);
  });
});

describe('isCountedPath', () => {
  it('counts a source file at the repo root', () => {
    expect(isCountedPath('app.ts')).toBe(true);
  });

  it('counts a nested source file', () => {
    expect(isCountedPath('apps/web/src/main.tsx')).toBe(true);
  });

  it('rejects unlisted extensions', () => {
    expect(isCountedPath('assets/logo.png')).toBe(false);
  });

  it('rejects files under an ignored directory at any depth', () => {
    expect(isCountedPath('node_modules/pkg/index.ts')).toBe(false);
    expect(isCountedPath('apps/web/node_modules/pkg/index.ts')).toBe(false);
    expect(isCountedPath('packages/db/drizzle/0001_snapshot.json')).toBe(false);
    expect(isCountedPath('.git/hooks/pre-commit.js')).toBe(false);
  });

  it('rejects lockfiles and generated source files', () => {
    expect(isCountedPath('pnpm-lock.yaml')).toBe(false);
    expect(isCountedPath('apps/web/src/routeTree.gen.ts')).toBe(false);
  });

  it('counts dev tooling under the .claude directory', () => {
    expect(isCountedPath('.claude/hooks/hook.mjs')).toBe(true);
  });

  it('rejects markdown under the process-record doc directories', () => {
    expect(isCountedPath('docs/plans/runs/2026-01-01-run/plan.md')).toBe(false);
    expect(isCountedPath('docs/audits/2026-01-01.md')).toBe(false);
    expect(isCountedPath('docs/history/BACKEND-REDESIGN.md')).toBe(false);
    expect(isCountedPath('docs/decisions/0001-choice.mdx')).toBe(false);
  });

  it('counts non-markdown files under the process-record doc directories', () => {
    expect(isCountedPath('docs/plans/behavioral-spec/spec.ts')).toBe(true);
  });

  it('rejects markdown under the run-record directory', () => {
    expect(isCountedPath('docs/runs/2026-01-01-run/plan.md')).toBe(false);
  });

  it('counts markdown outside the process-record doc directories', () => {
    expect(isCountedPath('docs/DESIGN.md')).toBe(true);
    expect(isCountedPath('apps/web/docs/history/note.md')).toBe(true);
  });
});
