import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withScratchDirectory } from './lib/scratch-directory.js';
import {
  checkDocumentPaths,
  citationsIn,
  citedPath,
  formatFinding,
  gitDocumentPathDependencies,
  gitIgnoreCoverage,
  isScannedDocument,
  nearestExistingDirectory,
  rootEntriesOf,
  runDocumentPathCheck,
  unresolvedCitations,
  type Citation,
  type DocumentPathDependencies,
  type IgnoreCoverage,
} from './verify-document-paths.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_PREFIX = 'hushbox-doc-paths-';

/** Stands for the repository root listing the admission test is asked against. */
const ROOTS = new Set(['docs', 'apps', 'packages', 'e2e', 'scripts', 'package.json', 'CLAUDE.md']);

/**
 * Runs one case against a fresh tree staged outside the repository, which the
 * architecture layer enumerates whole: a fixture under this package is a
 * directory a concurrent scan lists between one case's setup and the next's
 * teardown.
 */
function withFixture(body: (root: string) => Promise<void>): () => Promise<void> {
  return () => withScratchDirectory(FIXTURE_PREFIX, body);
}

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, ...file.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

function citation(cited: string, token: string = cited): Citation {
  return { file: 'docs/GUIDE.md', line: 3, token, cited };
}

const noCoverage: IgnoreCoverage = () => Promise.resolve(new Set<string>());

function coverageOf(covered: readonly string[]): IgnoreCoverage {
  return (asked) => Promise.resolve(new Set(asked.filter((entry) => covered.includes(entry))));
}

function dependenciesOver(
  paths: readonly string[],
  covered: readonly string[] = []
): DocumentPathDependencies {
  return { listPaths: () => Promise.resolve(paths), ignoreCoverage: coverageOf(covered) };
}

describe('the documents the check reads', () => {
  it('reads a documentation file', () => {
    expect(isScannedDocument('docs/TESTING.md')).toBe(true);
  });

  it('reads a documentation file in a subdirectory', () => {
    expect(isScannedDocument('docs/runbooks/infra/backup-repository.md')).toBe(true);
  });

  it.each(['docs/history/PLAN.md', 'docs/runs/a-run/plan.md', 'docs/audits/2026-01-01.md'])(
    'leaves the record file %s unread',
    (file) => {
      expect(isScannedDocument(file)).toBe(false);
    }
  );

  it('leaves a planning document unread', () => {
    expect(isScannedDocument('docs/plans/ADMIN-PLANE.md')).toBe(false);
  });

  it('reads an instruction file anywhere in the tree', () => {
    expect(isScannedDocument('apps/api/src/slices/admin/CLAUDE.md')).toBe(true);
  });

  it('reads the instruction file that governs a record directory', () => {
    expect(isScannedDocument('docs/audits/CLAUDE.md')).toBe(true);
  });

  it('leaves a non-markdown file under the documentation tree unread', () => {
    expect(isScannedDocument('docs/assets/diagram.svg')).toBe(false);
  });

  it('leaves a markdown file outside the documentation tree unread', () => {
    expect(isScannedDocument('packages/config/arch/README.md')).toBe(false);
  });
});

describe('the repository root listing', () => {
  it('names the first segment of every path in the worktree listing', () => {
    expect(rootEntriesOf(['docs/TESTING.md', 'apps/api/src/index.ts', 'package.json'])).toEqual(
      new Set(['docs', 'apps', 'package.json'])
    );
  });
});

describe('the admission test', () => {
  it('admits a root-anchored path', () => {
    expect(citedPath('apps/api/src/index.ts', ROOTS)).toBe('apps/api/src/index.ts');
  });

  it('admits a directory named with a trailing separator', () => {
    expect(citedPath('docs/runbooks/', ROOTS)).toBe('docs/runbooks/');
  });

  it('strips a line number', () => {
    expect(citedPath('apps/api/src/index.ts:42', ROOTS)).toBe('apps/api/src/index.ts');
  });

  it('strips a line range', () => {
    expect(citedPath('apps/api/src/index.ts:42-58', ROOTS)).toBe('apps/api/src/index.ts');
  });

  it('ignores a token carrying no separator', () => {
    expect(citedPath('package.json', ROOTS)).toBeNull();
  });

  it('ignores a command that happens to carry a separator', () => {
    expect(citedPath('pnpm test --filter apps/web', ROOTS)).toBeNull();
  });

  it.each(['docs/<name>.md', 'docs/{version}/index.md', 'docs/**/*.md'])(
    'ignores the placeholder token %s',
    (token) => {
      expect(citedPath(token, ROOTS)).toBeNull();
    }
  );

  it('ignores an example elided with an ellipsis character', () => {
    expect(citedPath('docs/…/TESTING.md', ROOTS)).toBeNull();
  });

  it('ignores an example elided with three dots', () => {
    expect(citedPath('docs/.../TESTING.md', ROOTS)).toBeNull();
  });

  it('ignores a path relative to the document that cites it', () => {
    expect(citedPath('src/lib/api-client.ts', ROOTS)).toBeNull();
  });

  it('ignores a path on the machine rather than in the repository', () => {
    expect(citedPath('/etc/hosts', ROOTS)).toBeNull();
  });
});

describe('the citations one document carries', () => {
  it('reports the line a citation sits on', () => {
    const text = ['# Title', '', 'See `docs/TESTING.md` for the mechanics.'].join('\n');
    expect(citationsIn('docs/CODE-RULES.md', text, ROOTS)).toEqual([
      { file: 'docs/CODE-RULES.md', line: 3, token: 'docs/TESTING.md', cited: 'docs/TESTING.md' },
    ]);
  });

  it('reports every citation a single line carries', () => {
    const text = 'Both `docs/TESTING.md` and `e2e/CLAUDE.md` apply.';
    expect(citationsIn('docs/CODE-RULES.md', text, ROOTS).map(({ cited }) => cited)).toEqual([
      'docs/TESTING.md',
      'e2e/CLAUDE.md',
    ]);
  });

  it('reports the path a citation claims without its line number', () => {
    const text = 'See `scripts/seed.ts:12`.';
    expect(citationsIn('docs/CODE-RULES.md', text, ROOTS)).toEqual([
      {
        file: 'docs/CODE-RULES.md',
        line: 1,
        token: 'scripts/seed.ts:12',
        cited: 'scripts/seed.ts',
      },
    ]);
  });

  it('ignores a path written as prose rather than as a citation', () => {
    const text = 'The file docs/TESTING.md holds the mechanics.';
    expect(citationsIn('docs/CODE-RULES.md', text, ROOTS)).toEqual([]);
  });
});

describe('resolving a citation against the tree', () => {
  it(
    'resolves a citation the tree holds',
    withFixture(async (root) => {
      await writeFixture(root, { 'apps/api/live.ts': '' });
      expect(await unresolvedCitations(root, [citation('apps/api/live.ts')], noCoverage)).toEqual(
        []
      );
    })
  );

  it(
    'reports a citation nothing resolves',
    withFixture(async (root) => {
      await writeFixture(root, { 'apps/api/live.ts': '' });
      const findings = await unresolvedCitations(root, [citation('apps/api/gone.ts')], noCoverage);
      expect(findings.map(({ cited }) => cited)).toEqual(['apps/api/gone.ts']);
    })
  );

  it(
    'resolves a citation an ignore rule covers',
    withFixture(async (root) => {
      const covers = coverageOf(['apps/web/dist/index.html']);
      expect(
        await unresolvedCitations(root, [citation('apps/web/dist/index.html')], covers)
      ).toEqual([]);
    })
  );
});

describe('the directory a finding points at', () => {
  it(
    'names the closest ancestor the tree holds',
    withFixture(async (root) => {
      await writeFixture(root, { 'apps/api/live.ts': '' });
      expect(nearestExistingDirectory(root, 'apps/api/domain/gone.ts')).toBe('apps/api');
    })
  );

  it(
    'names the repository root when no ancestor exists',
    withFixture(async (root) => {
      await writeFixture(root, { 'apps/api/live.ts': '' });
      expect(nearestExistingDirectory(root, 'packages/shared/gone.ts')).toBe('.');
    })
  );

  it(
    'names the file, the line, the token and what that directory holds',
    withFixture(async (root) => {
      await writeFixture(root, { 'apps/api/live.ts': '', 'apps/api/other.ts': '' });
      expect(formatFinding(root, citation('apps/api/gone.ts', 'apps/api/gone.ts:12'))).toBe(
        '  docs/GUIDE.md:3  `apps/api/gone.ts:12`\n    apps/api holds: live.ts, other.ts'
      );
    })
  );

  it(
    'counts the neighbours it does not list, so a crowded directory stays readable',
    withFixture(async (root) => {
      const crowd = Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`scripts/file-${String(index + 10)}.ts`, ''])
      );
      await writeFixture(root, crowd);
      const neighbours = Array.from({ length: 20 }, (_, index) => `file-${String(index + 10)}.ts`);
      expect(formatFinding(root, citation('scripts/gone.ts'))).toBe(
        [
          '  docs/GUIDE.md:3  `scripts/gone.ts`',
          `    scripts holds: ${neighbours.join(', ')}, and 5 more`,
        ].join('\n')
      );
    })
  );
});

describe('the check over a tree', () => {
  it(
    'passes over a tree whose every citation resolves',
    withFixture(async (root) => {
      await writeFixture(root, {
        'docs/GUIDE.md': 'See `apps/api/live.ts`.',
        'apps/api/live.ts': '',
      });
      expect(
        await runDocumentPathCheck(root, dependenciesOver(['docs/GUIDE.md', 'apps/api/live.ts']))
      ).toEqual({
        report: [
          'Doc paths: every backticked repository path the documentation cites.',
          '  citations checked: 1',
          '  no findings',
        ].join('\n'),
        code: 0,
      });
    })
  );

  it(
    'fails naming the citation nothing resolves',
    withFixture(async (root) => {
      await writeFixture(root, {
        'docs/GUIDE.md': 'See `apps/api/gone.ts`.',
        'apps/api/live.ts': '',
      });
      expect(
        await runDocumentPathCheck(root, dependenciesOver(['docs/GUIDE.md', 'apps/api/live.ts']))
      ).toEqual({
        report: [
          'Doc paths: every backticked repository path the documentation cites.',
          '  citations checked: 1',
          '  docs/GUIDE.md:1  `apps/api/gone.ts`',
          '    apps/api holds: live.ts',
        ].join('\n'),
        code: 1,
      });
    })
  );

  it(
    'reads no record document',
    withFixture(async (root) => {
      await writeFixture(root, { 'docs/runs/a-run/plan.md': 'See `apps/api/gone.ts`.' });
      const outcome = await runDocumentPathCheck(
        root,
        dependenciesOver(['docs/runs/a-run/plan.md'])
      );
      expect(outcome.code).toBe(0);
    })
  );

  it(
    'reads no document the worktree no longer holds',
    withFixture(async (root) => {
      await writeFixture(root, {
        'docs/GUIDE.md': 'See `apps/api/live.ts`.',
        'apps/api/live.ts': '',
      });
      const outcome = await runDocumentPathCheck(
        root,
        dependenciesOver(['docs/GUIDE.md', 'docs/DELETED.md', 'apps/api/live.ts'])
      );
      expect(outcome.code).toBe(0);
    })
  );
});

describe('the ignore rules as git reads them', () => {
  it('covers a path an ignore rule names', async () => {
    const covered = await gitIgnoreCoverage(REPO_ROOT)(['apps/web/dist/index.html']);
    expect([...covered]).toEqual(['apps/web/dist/index.html']);
  });

  it('leaves a path no ignore rule names uncovered', async () => {
    const covered = await gitIgnoreCoverage(REPO_ROOT)(['docs/CODE-RULES.md']);
    expect([...covered]).toEqual([]);
  });

  it(
    'refuses an answer git could not give',
    withFixture(async (root) => {
      await expect(gitIgnoreCoverage(root)(['docs/CODE-RULES.md'])).rejects.toThrow('check-ignore');
    })
  );
});

describe('the check over this repository', () => {
  it('reads the documentation this repository ships', async () => {
    const check = await checkDocumentPaths(REPO_ROOT, gitDocumentPathDependencies(REPO_ROOT));
    expect(check.citations.length).toBeGreaterThan(100);
  });

  it('reports how many citations it checked', async () => {
    const outcome = await runDocumentPathCheck(REPO_ROOT);
    expect(outcome.report).toMatch(/^ {2}citations checked: \d+$/m);
  });
});
