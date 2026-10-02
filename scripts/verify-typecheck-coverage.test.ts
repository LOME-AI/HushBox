import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { isOutsideRoot } from './lib/path-containment.js';

vi.mock('./lib/cli/workspaces.js', () => ({
  discoverWorkspaces: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PREFIX = 'hushbox-typecheck-coverage-';

/**
 * Runs one test against a fresh fixture tree, staged outside the repository.
 *
 * `scripts` is a workspace the architecture layer scans whole, so a fixture
 * tree under this file's own directory is a directory ts-morph enumerates: a
 * concurrent `arch:check` that lists it between one test's setup and the
 * next's teardown dies with a directory-not-found naming a path that is
 * nobody's source. Location is what closes that, not timing.
 */
function withFixtureTree(body: (fixtureDir: string) => Promise<void>): () => Promise<void> {
  return () => withScratchDirectory(FIXTURE_PREFIX, body);
}

describe('verify-typecheck-coverage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'stages its fixture tree outside the repository',
    withFixtureTree((fixtureDir) => {
      expect(isOutsideRoot(path, REPO_ROOT, fixtureDir)).toBe(true);
      return Promise.resolve();
    })
  );

  it('counts a path under the repository as inside it', () => {
    expect(isOutsideRoot(path, REPO_ROOT, path.join(REPO_ROOT, 'scripts'))).toBe(false);
  });

  // Injecting the `win32` flavour proves which branch the predicate selects for
  // a target on another drive. It is evidence about the selection, never about
  // how Windows itself behaves. The roots are forward-slashed, a spelling
  // `path.win32` and the Win32 API both take, because the backslashed one is a
  // shape the privacy gate reads as somebody's machine.
  it('counts a fixture on another Windows drive as outside the repository', () => {
    expect(isOutsideRoot(path.win32, 'D:/repo', 'C:/scratch/fix')).toBe(true);
  });

  describe('findOrphanedFiles', () => {
    it('returns files present in source but not in covered set', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set([
        '/root/apps/web/src/app.ts',
        '/root/apps/web/ios/test.ts',
        '/root/apps/api/src/index.ts',
      ]);
      const coveredFiles = new Set(['/root/apps/web/src/app.ts', '/root/apps/api/src/index.ts']);

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual(['/root/apps/web/ios/test.ts']);
    });

    it('returns empty array when all files are covered', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set(['/root/src/app.ts']);
      const coveredFiles = new Set(['/root/src/app.ts']);

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual([]);
    });

    it('returns all files when nothing is covered', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set(['/root/a.ts', '/root/b.ts']);
      const coveredFiles = new Set<string>();

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual(['/root/a.ts', '/root/b.ts']);
    });

    it('sorts orphaned files alphabetically', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set(['/root/z.ts', '/root/a.ts', '/root/m.ts']);
      const coveredFiles = new Set<string>();

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual(['/root/a.ts', '/root/m.ts', '/root/z.ts']);
    });
  });

  describe('formatReport', () => {
    it('returns success message when no orphans', async () => {
      const { formatReport } = await import('./verify-typecheck-coverage.js');

      const result = formatReport(
        { success: true, orphanedFiles: [], brokenProjects: [] },
        '/root'
      );

      expect(result).toContain('All TypeScript files are covered');
    });

    it('lists orphaned files with relative paths', async () => {
      const { formatReport } = await import('./verify-typecheck-coverage.js');

      const result = formatReport(
        {
          success: false,
          orphanedFiles: ['/root/apps/web/ios/test.ts', '/root/apps/web/android/test.ts'],
          brokenProjects: [],
        },
        '/root'
      );

      expect(result).toContain('apps/web/ios/test.ts');
      expect(result).toContain('apps/web/android/test.ts');
      expect(result).toContain('2 TypeScript file(s)');
    });

    it('names a project that cannot be loaded and why', async () => {
      const { formatReport } = await import('./verify-typecheck-coverage.js');

      const result = formatReport(
        {
          success: false,
          orphanedFiles: [],
          brokenProjects: [
            {
              tsconfig: '/root/tsconfig.json',
              loadErrors: ["Referenced project '/root/packages/db' must have setting 'composite'"],
            },
          ],
        },
        '/root'
      );

      expect(result).toContain('tsconfig.json');
      expect(result).toContain("must have setting 'composite'");
      expect(result).toContain('cannot be loaded');
    });
  });

  describe('findAllTsconfigs', () => {
    it(
      'discovers tsconfig.json files from workspace directories',
      withFixtureTree(async (fixtureDir) => {
        const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
          { name: 'api', path: 'apps/api', fullName: '@hushbox/api' },
        ]);

        await mkdir(path.join(fixtureDir, 'apps/web'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'apps/api'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'apps/web/tsconfig.json'), '{}');
        await writeFile(path.join(fixtureDir, 'apps/web/tsconfig.native-tests.json'), '{}');
        await writeFile(path.join(fixtureDir, 'apps/api/tsconfig.json'), '{}');
        await writeFile(path.join(fixtureDir, 'tsconfig.json'), '{}');

        const tsconfigs = findAllTsconfigs(fixtureDir);

        expect(tsconfigs).toContain(path.join(fixtureDir, 'tsconfig.json'));
        expect(tsconfigs).toContain(path.join(fixtureDir, 'apps/web/tsconfig.json'));
        expect(tsconfigs).toContain(path.join(fixtureDir, 'apps/web/tsconfig.native-tests.json'));
        expect(tsconfigs).toContain(path.join(fixtureDir, 'apps/api/tsconfig.json'));
      })
    );

    it(
      'excludes node_modules tsconfig files',
      withFixtureTree(async (fixtureDir) => {
        const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
        ]);

        await mkdir(path.join(fixtureDir, 'apps/web'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'apps/web/node_modules/pkg'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'apps/web/tsconfig.json'), '{}');
        await writeFile(path.join(fixtureDir, 'apps/web/node_modules/pkg/tsconfig.json'), '{}');
        await writeFile(path.join(fixtureDir, 'tsconfig.json'), '{}');

        const tsconfigs = findAllTsconfigs(fixtureDir);

        expect(tsconfigs).not.toContain(
          path.join(fixtureDir, 'apps/web/node_modules/pkg/tsconfig.json')
        );
      })
    );

    it(
      'skips workspaces whose directory does not exist',
      withFixtureTree(async (fixtureDir) => {
        const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');

        await writeFile(path.join(fixtureDir, 'tsconfig.json'), '{}');

        const tsconfigs = findAllTsconfigs(fixtureDir, [
          { name: 'ghost', path: 'apps/ghost', fullName: '@hushbox/ghost' },
        ]);

        expect(tsconfigs).toEqual([path.join(fixtureDir, 'tsconfig.json')]);
      })
    );

    it(
      'omits the root tsconfig when it is absent',
      withFixtureTree(async (fixtureDir) => {
        const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
        // fixtureDir has no root tsconfig.json, so the root entry is skipped.
        const tsconfigs = findAllTsconfigs(fixtureDir, []);
        expect(tsconfigs).toEqual([]);
      })
    );
  });

  describe('findAllSourceFiles', () => {
    it(
      'skips directories that do not exist',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');
        expect(findAllSourceFiles([path.join(fixtureDir, 'does-not-exist')])).toEqual([]);
      })
    );
  });

  describe('loadTsconfigProject', () => {
    it(
      'returns source files covered by a tsconfig include pattern',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x = 1;\n');
        await writeFile(path.join(fixtureDir, 'src/util.ts'), 'export const y = 2;\n');

        const { files } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
        expect(files.some((f) => f.endsWith('src/util.ts'))).toBe(true);
      })
    );

    it(
      'returns empty array when the tsconfig cannot be parsed',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        const { files } = loadTsconfigProject(path.join(fixtureDir, 'does-not-exist.json'));

        expect(files).toEqual([]);
      })
    );

    it(
      'reports a load error when the config matches no files',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await writeFile(path.join(fixtureDir, 'tsconfig.json'), JSON.stringify({ files: [] }));

        const { files, loadErrors } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(files).toEqual([]);
        expect(loadErrors.join('\n')).toContain("The 'files' list in config file");
      })
    );

    it(
      'reports a load error for an unknown option in a config that matches no files',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        // Covering no files is not a reason to excuse a config the compiler rejects:
        // the diagnostic has to survive the early return, not only the program path.
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { totallyBogusOptionKey: true },
            include: ['zzz-none'],
          })
        );

        const { files, loadErrors } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(files).toEqual([]);
        expect(loadErrors.join('\n')).toContain("Unknown compiler option 'totallyBogusOptionKey'");
      })
    );

    it(
      'filters out files inside node_modules',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x = 1;\n');

        const { files } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
        expect(files.every((f) => !f.includes('/node_modules/'))).toBe(true);
      })
    );

    it(
      'resolves files through tsconfig "extends"',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.base.json'),
          JSON.stringify({
            compilerOptions: {
              skipLibCheck: true,
              noEmit: true,
              strict: true,
              types: [],
            },
          })
        );
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            extends: './tsconfig.base.json',
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x: number = 1;\n');

        const { files } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
      })
    );

    it(
      'returns transitively imported files outside the include pattern',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'lib'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/entry.ts'],
          })
        );
        await writeFile(
          path.join(fixtureDir, 'src/entry.ts'),
          "import { helper } from '../lib/util.js';\nexport const x = helper();\n"
        );
        await writeFile(
          path.join(fixtureDir, 'lib/util.ts'),
          'export function helper(): number {\n  return 1;\n}\n'
        );

        const { files } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        // entry.ts is in `include`; util.ts is not, but is reachable via import
        expect(files.some((f) => f.endsWith('src/entry.ts'))).toBe(true);
        expect(files.some((f) => f.endsWith('lib/util.ts'))).toBe(true);
      })
    );

    it(
      'reports no load errors for a project the compiler can load',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, incremental: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x = 1;\n');

        const { loadErrors } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(loadErrors).toEqual([]);
      })
    );

    it(
      'reports a load error when a referenced project cannot be loaded',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'pkg/src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'pkg/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'pkg/src/index.ts'), 'export const y = 2;\n');
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
            references: [{ path: './pkg' }],
          })
        );
        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x = 1;\n');

        const { files, loadErrors } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        // The file is still listed — that is precisely why listing alone proved nothing.
        expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
        expect(loadErrors.join('\n')).toContain('composite');
      })
    );

    it(
      'reports a load error when a compiler option is not a real option',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { totallyNotARealOption: true },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x = 1;\n');

        const { files, loadErrors } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        // The file is still listed, so counting it as covered is what kept the gate green.
        expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
        expect(loadErrors.join('\n')).toContain("Unknown compiler option 'totallyNotARealOption'");
      })
    );

    it(
      'reports a load error when a compiler option carries an invalid value',
      withFixtureTree(async (fixtureDir) => {
        const { loadTsconfigProject } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { target: 'not-a-target' },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'src/app.ts'), 'export const x = 1;\n');

        const { loadErrors } = loadTsconfigProject(path.join(fixtureDir, 'tsconfig.json'));

        expect(loadErrors.join('\n')).toContain("Argument for '--target' option must be");
      })
    );
  });

  describe('findAllSourceFiles', () => {
    it(
      'finds .ts and .tsx files recursively in specified directories',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'src/app.ts'), '');
        await writeFile(path.join(fixtureDir, 'src/component.tsx'), '');

        const files = findAllSourceFiles([fixtureDir]);

        expect(files).toContain(path.join(fixtureDir, 'src/app.ts'));
        expect(files).toContain(path.join(fixtureDir, 'src/component.tsx'));
      })
    );

    it(
      'excludes node_modules directories',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'node_modules/pkg'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'src/app.ts'), '');
        await writeFile(path.join(fixtureDir, 'node_modules/pkg/index.ts'), '');

        const files = findAllSourceFiles([fixtureDir]);

        expect(files).toContain(path.join(fixtureDir, 'src/app.ts'));
        expect(files).not.toContain(path.join(fixtureDir, 'node_modules/pkg/index.ts'));
      })
    );

    it(
      'excludes .d.ts files',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'src/app.ts'), '');
        await writeFile(path.join(fixtureDir, 'src/types.d.ts'), '');

        const files = findAllSourceFiles([fixtureDir]);

        expect(files).toContain(path.join(fixtureDir, 'src/app.ts'));
        expect(files).not.toContain(path.join(fixtureDir, 'src/types.d.ts'));
      })
    );

    it(
      'excludes dist and build directories',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'dist'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'build'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'src/app.ts'), '');
        await writeFile(path.join(fixtureDir, 'dist/app.ts'), '');
        await writeFile(path.join(fixtureDir, 'build/app.ts'), '');

        const files = findAllSourceFiles([fixtureDir]);

        expect(files).toContain(path.join(fixtureDir, 'src/app.ts'));
        expect(files).not.toContain(path.join(fixtureDir, 'dist/app.ts'));
        expect(files).not.toContain(path.join(fixtureDir, 'build/app.ts'));
      })
    );

    it(
      'excludes generated files',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

        await mkdir(path.join(fixtureDir, 'src'), { recursive: true });
        await mkdir(path.join(fixtureDir, '.astro'), { recursive: true });
        await writeFile(path.join(fixtureDir, 'src/app.ts'), '');
        await writeFile(path.join(fixtureDir, 'src/routeTree.gen.ts'), '');
        await writeFile(path.join(fixtureDir, '.astro/types.d.ts'), '');

        const files = findAllSourceFiles([fixtureDir]);

        expect(files).toContain(path.join(fixtureDir, 'src/app.ts'));
        expect(files).not.toContain(path.join(fixtureDir, 'src/routeTree.gen.ts'));
        expect(files).not.toContain(path.join(fixtureDir, '.astro/types.d.ts'));
      })
    );

    it(
      'only scans specified directories, ignoring others at the same level',
      withFixtureTree(async (fixtureDir) => {
        const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

        const workspaceDir = path.join(fixtureDir, 'apps/web');
        const strayDir = path.join(fixtureDir, 'OldProject');
        await mkdir(path.join(workspaceDir, 'src'), { recursive: true });
        await mkdir(strayDir, { recursive: true });
        await writeFile(path.join(workspaceDir, 'src/app.ts'), '');
        await writeFile(path.join(strayDir, 'stray.ts'), '');

        const files = findAllSourceFiles([workspaceDir]);

        expect(files).toContain(path.join(workspaceDir, 'src/app.ts'));
        expect(files).not.toContain(path.join(strayDir, 'stray.ts'));
      })
    );
  });

  describe('verify', () => {
    it(
      'returns success when all source files are covered',
      withFixtureTree(async (fixtureDir) => {
        const { verify } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
        ]);

        await mkdir(path.join(fixtureDir, 'pkg/src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'pkg/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { skipLibCheck: true, noEmit: true, types: [] } })
        );
        await writeFile(path.join(fixtureDir, 'pkg/src/index.ts'), 'export const x = 1;\n');

        const result = verify(fixtureDir);

        expect(result.success).toBe(true);
        expect(result.orphanedFiles).toEqual([]);
      })
    );

    it(
      'returns failure when source files are not covered',
      withFixtureTree(async (fixtureDir) => {
        const { verify } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
        ]);

        await mkdir(path.join(fixtureDir, 'pkg/src'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'pkg/orphan'), { recursive: true });
        // pkg tsconfig only covers src/, leaving orphan/ uncovered
        await writeFile(
          path.join(fixtureDir, 'pkg/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        // Root tsconfig is scoped to a dummy root file so it does NOT fall back
        // to the default "**/*" include that would otherwise pick up orphan/lost.ts
        await writeFile(path.join(fixtureDir, 'root.ts'), 'export {};\n');
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['root.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'pkg/src/index.ts'), 'export const x = 1;\n');
        await writeFile(path.join(fixtureDir, 'pkg/orphan/lost.ts'), 'export const y = 2;\n');

        const result = verify(fixtureDir);

        expect(result.success).toBe(false);
        expect(result.orphanedFiles).toContain(path.join(fixtureDir, 'pkg/orphan/lost.ts'));
      })
    );

    it(
      'names a repository-root file that no config covers',
      withFixtureTree(async (fixtureDir) => {
        const { verify } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
        ]);

        await mkdir(path.join(fixtureDir, 'pkg/src'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'pkg/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        // The root config deliberately reaches only into the workspace, so the
        // root-level file below is covered by nothing.
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['pkg/src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'pkg/src/index.ts'), 'export const x = 1;\n');
        await writeFile(path.join(fixtureDir, 'stray.config.ts'), 'export const z = 3;\n');

        const result = verify(fixtureDir);

        expect(result.orphanedFiles).toContain(path.join(fixtureDir, 'stray.config.ts'));
        expect(result.success).toBe(false);
      })
    );

    it(
      'does not descend into directories below the repository root',
      withFixtureTree(async (fixtureDir) => {
        const { verify } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
        ]);

        await mkdir(path.join(fixtureDir, 'pkg/src'), { recursive: true });
        await mkdir(path.join(fixtureDir, 'not-a-workspace'), { recursive: true });
        await writeFile(
          path.join(fixtureDir, 'pkg/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['pkg/src/**/*.ts'],
          })
        );
        await writeFile(path.join(fixtureDir, 'pkg/src/index.ts'), 'export const x = 1;\n');
        await writeFile(path.join(fixtureDir, 'not-a-workspace/deep.ts'), 'export const w = 4;\n');

        const result = verify(fixtureDir);

        expect(result.orphanedFiles).toEqual([]);
        expect(result.success).toBe(true);
      })
    );

    it(
      'returns failure when a config lists files but its project cannot be loaded',
      withFixtureTree(async (fixtureDir) => {
        const { verify } = await import('./verify-typecheck-coverage.js');
        const { discoverWorkspaces } = await import('./lib/cli/workspaces.js');

        vi.mocked(discoverWorkspaces).mockReturnValue([
          { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
        ]);

        await mkdir(path.join(fixtureDir, 'pkg/src'), { recursive: true });
        // A referenced project that sets noEmit and omits composite cannot be
        // loaded as a reference, so the referencing project type-checks nothing.
        await writeFile(
          path.join(fixtureDir, 'pkg/tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['src/**/*.ts'],
          })
        );
        await writeFile(
          path.join(fixtureDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
            include: ['*.config.ts'],
            references: [{ path: './pkg' }],
          })
        );
        await writeFile(path.join(fixtureDir, 'pkg/src/index.ts'), 'export const x = 1;\n');
        await writeFile(
          path.join(fixtureDir, 'vite.config.ts'),
          'export const broken: number = "not a number";\n'
        );

        const result = verify(fixtureDir);

        expect(result.success).toBe(false);
        expect(result.brokenProjects.map((project) => project.tsconfig)).toContain(
          path.join(fixtureDir, 'tsconfig.json')
        );
      })
    );
  });
});
