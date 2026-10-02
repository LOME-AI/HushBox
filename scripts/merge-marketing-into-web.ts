#!/usr/bin/env tsx
// eslint-disable-next-line comments/resolvable-cross-reference -- both cited directories are the build outputs this script merges and git ignores, so the citations are correct and resolve only after both apps are built
/** Merge `apps/marketing/dist` on top of `apps/web/dist` so a single static
 * directory can be served by `vite preview` (E2E) or Cloudflare Pages
 * (production). Mirrors what `cp -r apps/marketing/dist/* apps/web/dist/`
 * would do, with the existence checks and a summary printed at the end.
 *
 * Single source of truth for the merge step, called from:
 *   - `.github/workflows/ci.yml`
 *   - `playwright.config.ts` (E2E web server)
 *
 * Both source dirs must exist; running this before either app is built is
 * a usage error and fails fast.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';

interface MergeOptions {
  readonly repoRoot: string;
  readonly sourceRelativePath?: string;
  readonly targetRelativePath?: string;
}

interface MergeResult {
  readonly filesCopied: number;
  readonly sourceDir: string;
  readonly targetDir: string;
}

const DEFAULT_SOURCE = 'apps/marketing/dist';
const DEFAULT_TARGET = 'apps/web/dist';

async function assertDirectoryExists(directory: string, label: string): Promise<void> {
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) {
      throw new Error(`${label} (${directory}) exists but is not a directory`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `${label} (${directory}) does not exist. Build ${label.toLowerCase()} before merging.`
      );
    }
    throw error;
  }
}

async function countFiles(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).length;
}

export async function mergeMarketingIntoWeb(options: MergeOptions): Promise<MergeResult> {
  const sourceDir = path.resolve(options.repoRoot, options.sourceRelativePath ?? DEFAULT_SOURCE);
  const targetDir = path.resolve(options.repoRoot, options.targetRelativePath ?? DEFAULT_TARGET);

  await assertDirectoryExists(sourceDir, 'Marketing dist');
  await assertDirectoryExists(targetDir, 'Web dist');

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(targetDir, entry.name);
    await fs.cp(source, destination, { recursive: true, force: true });
  }

  const filesCopied = await countFiles(sourceDir);
  return { filesCopied, sourceDir, targetDir };
}

export const COMMAND_LINE = {
  command: 'tsx scripts/merge-marketing-into-web.ts',
  summary: 'Merges the marketing bundle on top of the web bundle.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via shell */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const result = await mergeMarketingIntoWeb({ repoRoot });
    console.log(
      `Merged ${String(result.filesCopied)} files: ${result.sourceDir} -> ${result.targetDir}`
    );
  });
}
/* v8 ignore stop */
