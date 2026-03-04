import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('./workspaces.js', () => ({
  discoverWorkspaces: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '__test-fixtures-typecheck__');

describe('verify-typecheck-coverage', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TEST_DIR, { recursive: true, force: true });
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

      const result = formatReport([], '/root');

      expect(result).toContain('All TypeScript files are covered');
    });

    it('lists orphaned files with relative paths', async () => {
      const { formatReport } = await import('./verify-typecheck-coverage.js');

      const result = formatReport(
        ['/root/apps/web/ios/test.ts', '/root/apps/web/android/test.ts'],
        '/root'
      );

      expect(result).toContain('apps/web/ios/test.ts');
      expect(result).toContain('apps/web/android/test.ts');
      expect(result).toContain('2 TypeScript file(s)');
    });
  });

  describe('findAllTsconfigs', () => {
    it('discovers tsconfig.json files from workspace directories', async () => {
      const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
        { name: 'api', path: 'apps/api', fullName: '@hushbox/api' },
      ]);

      // Create workspace dirs with tsconfigs
      await mkdir(path.join(TEST_DIR, 'apps/web'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'apps/api'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'apps/web/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'apps/web/tsconfig.native-tests.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'apps/api/tsconfig.json'), '{}');
      // Root tsconfig
      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');

      const tsconfigs = findAllTsconfigs(TEST_DIR);

      expect(tsconfigs).toContain(path.join(TEST_DIR, 'tsconfig.json'));
      expect(tsconfigs).toContain(path.join(TEST_DIR, 'apps/web/tsconfig.json'));
      expect(tsconfigs).toContain(path.join(TEST_DIR, 'apps/web/tsconfig.native-tests.json'));
      expect(tsconfigs).toContain(path.join(TEST_DIR, 'apps/api/tsconfig.json'));
    });

    it('excludes node_modules tsconfig files', async () => {
      const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
      ]);

      await mkdir(path.join(TEST_DIR, 'apps/web'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'apps/web/node_modules/pkg'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'apps/web/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'apps/web/node_modules/pkg/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');

      const tsconfigs = findAllTsconfigs(TEST_DIR);

      expect(tsconfigs).not.toContain(
        path.join(TEST_DIR, 'apps/web/node_modules/pkg/tsconfig.json')
      );
    });
  });

  describe('getFilesFromTsconfig', () => {
    it('runs tsc --listFiles and returns file paths', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');
      const { execa } = await import('execa');

      vi.mocked(execa).mockResolvedValue({
        stdout: '/root/src/app.ts\n/root/src/utils.ts\n/root/node_modules/@types/node/index.d.ts',
      } as never);

      const files = await getFilesFromTsconfig('/root/tsconfig.json');

      expect(execa).toHaveBeenCalledWith(
        'tsc',
        ['--listFiles', '--noEmit', '-p', '/root/tsconfig.json'],
        expect.objectContaining({ reject: false })
      );
      // Should filter out node_modules files
      expect(files).toContain('/root/src/app.ts');
      expect(files).toContain('/root/src/utils.ts');
      expect(files).not.toContain('/root/node_modules/@types/node/index.d.ts');
    });

    it('returns empty array when tsc fails', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');
      const { execa } = await import('execa');

      vi.mocked(execa).mockResolvedValue({
        stdout: '',
        stderr: 'error TS6059',
        exitCode: 2,
      } as never);

      const files = await getFilesFromTsconfig('/root/tsconfig.json');

      expect(files).toEqual([]);
    });

    it('filters out .d.ts files from node_modules', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');
      const { execa } = await import('execa');

      vi.mocked(execa).mockResolvedValue({
        stdout: [
          '/root/src/index.ts',
          '/root/node_modules/typescript/lib/lib.es2022.d.ts',
          '/root/node_modules/.pnpm/@types+node@22/node_modules/@types/node/index.d.ts',
        ].join('\n'),
      } as never);

      const files = await getFilesFromTsconfig('/root/tsconfig.json');

      expect(files).toEqual(['/root/src/index.ts']);
    });
  });

  describe('findAllSourceFiles', () => {
    it('finds .ts and .tsx files recursively in specified directories', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/component.tsx'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).toContain(path.join(TEST_DIR, 'src/component.tsx'));
    });

    it('excludes node_modules directories', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'node_modules/pkg'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'node_modules/pkg/index.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'node_modules/pkg/index.ts'));
    });

    it('excludes .d.ts files', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/types.d.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/types.d.ts'));
    });

    it('excludes dist and build directories', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'dist'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'build'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'dist/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'build/app.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'dist/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'build/app.ts'));
    });

    it('excludes generated files', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, '.astro'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/routeTree.gen.ts'), '');
      await writeFile(path.join(TEST_DIR, '.astro/types.d.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/routeTree.gen.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, '.astro/types.d.ts'));
    });

    it('only scans specified directories, ignoring others at the same level', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      const workspaceDir = path.join(TEST_DIR, 'apps/web');
      const strayDir = path.join(TEST_DIR, 'OldProject');
      await mkdir(path.join(workspaceDir, 'src'), { recursive: true });
      await mkdir(strayDir, { recursive: true });
      await writeFile(path.join(workspaceDir, 'src/app.ts'), '');
      await writeFile(path.join(strayDir, 'stray.ts'), '');

      const files = findAllSourceFiles([workspaceDir]);

      expect(files).toContain(path.join(workspaceDir, 'src/app.ts'));
      expect(files).not.toContain(path.join(strayDir, 'stray.ts'));
    });
  });

  describe('verify', () => {
    it('returns success when all source files are covered', async () => {
      const { verify } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');
      const { execa } = await import('execa');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
      ]);

      // Create workspace with tsconfig and source file
      await mkdir(path.join(TEST_DIR, 'pkg'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'pkg/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');
      await mkdir(path.join(TEST_DIR, 'pkg/src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'pkg/src/index.ts'), '');

      // Mock tsc to report the source file as covered
      const sourceFile = path.join(TEST_DIR, 'pkg/src/index.ts');
      vi.mocked(execa).mockResolvedValue({
        stdout: sourceFile,
      } as never);

      const result = await verify(TEST_DIR);

      expect(result.success).toBe(true);
      expect(result.orphanedFiles).toEqual([]);
    });

    it('returns failure when source files are not covered', async () => {
      const { verify } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');
      const { execa } = await import('execa');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
      ]);

      // Create workspace with tsconfig and TWO source files
      await mkdir(path.join(TEST_DIR, 'pkg/src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'pkg/orphan'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'pkg/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'pkg/src/index.ts'), '');
      await writeFile(path.join(TEST_DIR, 'pkg/orphan/lost.ts'), '');

      // Mock tsc to only report ONE file as covered
      const coveredFile = path.join(TEST_DIR, 'pkg/src/index.ts');
      vi.mocked(execa).mockResolvedValue({
        stdout: coveredFile,
      } as never);

      const result = await verify(TEST_DIR);

      expect(result.success).toBe(false);
      expect(result.orphanedFiles).toContain(path.join(TEST_DIR, 'pkg/orphan/lost.ts'));
    });
  });
});
