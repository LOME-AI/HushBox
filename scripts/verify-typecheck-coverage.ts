#!/usr/bin/env tsx
/**
 * TypeScript Coverage Verification Script
 *
 * Ensures every .ts/.tsx file in the repo is covered by at least one tsconfig
 * that the compiler can load. Catches orphaned files that escape typecheck
 * coverage, and configs that list files while type-checking none of them.
 *
 * Usage:
 *   pnpm verify:typecheck-coverage
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { discoverWorkspaces } from './lib/cli/workspaces.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLineOrRefuse, type CommandSpec } from './lib/cli/command-line.js';
import type { Workspace } from './lib/cli/workspaces.js';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  '.astro',
  '.wrangler',
  'coverage',
]);

const EXCLUDED_FILES = new Set(['routeTree.gen.ts']);

/**
 * Find all tsconfig*.json files across the repo (root + workspaces).
 * Excludes node_modules.
 */
export function findAllTsconfigs(rootDirectory: string, workspaces?: Workspace[]): string[] {
  const tsconfigs: string[] = [];

  const rootTsconfig = path.join(rootDirectory, 'tsconfig.json');
  if (existsSync(rootTsconfig)) {
    tsconfigs.push(rootTsconfig);
  }

  const resolvedWorkspaces = workspaces ?? discoverWorkspaces(rootDirectory);
  for (const workspace of resolvedWorkspaces) {
    const workspaceDirectory = path.join(rootDirectory, workspace.path);
    if (!existsSync(workspaceDirectory)) continue;

    const entries = readdirSync(workspaceDirectory);
    for (const entry of entries) {
      if (entry.startsWith('tsconfig') && entry.endsWith('.json')) {
        tsconfigs.push(path.join(workspaceDirectory, entry));
      }
    }
  }

  return tsconfigs;
}

export interface TsconfigProject {
  /** Files the project covers, including transitively imported ones. */
  files: string[];
  /**
   * Project-level failures that stop the compiler loading the project as
   * configured. A project that cannot load type-checks nothing it lists, so
   * its `files` are coverage on paper only.
   */
  loadErrors: string[];
}

/**
 * Load a tsconfig as the compiler would and report both what it covers and
 * whether it can be loaded at all. Uses the TypeScript compiler API so we do
 * not depend on the `tsc` CLI or any of its unstable diagnostic flags
 * (e.g. `--listFiles`). Filters out files inside node_modules.
 *
 * Synchronous: `ts.createProgram` does not do any async I/O.
 */
export function loadTsconfigProject(tsconfigPath: string): TsconfigProject {
  const readResult = ts.readConfigFile(tsconfigPath, (filePath) => ts.sys.readFile(filePath));
  if (readResult.error || !readResult.config) {
    return { files: [], loadErrors: [] };
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    // Naming the config file is what sets `options.configFilePath`. Without it
    // the compiler judges the options as if they came from a command line and
    // reports failures the real project does not have (`--incremental` needs an
    // output target; `typeRoots` resolve from the wrong directory).
    tsconfigPath
  );
  // A config the compiler rejects as written — an unknown option, an invalid
  // option value — is loaded with those settings dropped, so it type-checks its
  // files under something other than what it declares. That is a broken project,
  // not a warning to continue past.
  const configErrors = parsed.errors.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  );

  if (parsed.fileNames.length === 0) {
    return { files: [], loadErrors: configErrors };
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    // Referenced projects are part of how the compiler resolves this one. Drop
    // them and a project whose references cannot load — the state that lists
    // files and checks none of them — looks indistinguishable from a healthy one.
    ...(parsed.projectReferences !== undefined && {
      projectReferences: parsed.projectReferences,
    }),
  });

  const files = program
    .getSourceFiles()
    .map((sourceFile) => sourceFile.fileName)
    .filter((fileName) => !fileName.replaceAll('\\', '/').includes('/node_modules/'));

  const programErrors = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map(
    (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  );

  return { files, loadErrors: [...configErrors, ...programErrors] };
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRS.has(name);
}

function isExcludedFile(name: string): boolean {
  /* v8 ignore next -- isTypeScriptFile already filters .d.ts before this is called */
  if (name.endsWith('.d.ts')) return true;
  return EXCLUDED_FILES.has(name);
}

function isTypeScriptFile(name: string): boolean {
  return (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts');
}

/**
 * Recursively find all .ts/.tsx files in specified directories,
 * excluding standard ignore patterns.
 */
export function findAllSourceFiles(directories: string[]): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    const entries = readdirSync(directory);
    for (const entry of entries) {
      const fullPath = path.join(directory, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!isExcludedDirectory(entry)) {
          walk(fullPath);
        }
      } else if (isTypeScriptFile(entry) && !isExcludedFile(entry)) {
        files.push(fullPath);
      }
    }
  }

  for (const directory of directories) {
    if (existsSync(directory)) {
      walk(directory);
    }
  }
  return files;
}

/**
 * The `.ts`/`.tsx` files sitting directly at the repository root, without
 * descending: every directory below the root is either a workspace, which has
 * its own scan root, or one the workspace walk deliberately leaves out.
 */
export function findRootSourceFiles(rootDirectory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(rootDirectory)) {
    if (!isTypeScriptFile(entry) || isExcludedFile(entry)) continue;
    const fullPath = path.join(rootDirectory, entry);
    if (statSync(fullPath).isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Return files in allSourceFiles that are not in coveredFiles.
 */
export function findOrphanedFiles(
  allSourceFiles: Set<string>,
  coveredFiles: Set<string>
): string[] {
  const orphans: string[] = [];
  for (const file of allSourceFiles) {
    if (!coveredFiles.has(file)) {
      orphans.push(file);
    }
  }
  return orphans.toSorted((a, b) => a.localeCompare(b));
}

export interface BrokenProject {
  tsconfig: string;
  loadErrors: string[];
}

export interface VerifyResult {
  success: boolean;
  orphanedFiles: string[];
  brokenProjects: BrokenProject[];
}

/**
 * Format a human-readable report of projects that cannot load and files no
 * loadable project covers.
 */
export function formatReport(result: VerifyResult, rootDirectory: string): string {
  const sections: string[] = [];

  if (result.brokenProjects.length > 0) {
    sections.push(
      [
        `✗ ${String(result.brokenProjects.length)} tsconfig(s) list files but cannot be loaded, so nothing type-checks them:`,
        '',
        ...result.brokenProjects.flatMap((project) => [
          `  ${path.relative(rootDirectory, project.tsconfig)}`,
          ...project.loadErrors.map((error) => `    ${error}`),
        ]),
        '',
        'Fix: repair the tsconfig so the compiler can load it as configured.',
      ].join('\n')
    );
  }

  if (result.orphanedFiles.length > 0) {
    sections.push(
      [
        `✗ ${String(result.orphanedFiles.length)} TypeScript file(s) not covered by any tsconfig:`,
        '',
        ...result.orphanedFiles.map((file) => `  ${path.relative(rootDirectory, file)}`),
        '',
        'Fix: Add these files to the appropriate tsconfig "include" pattern.',
      ].join('\n')
    );
  }

  if (sections.length === 0) {
    return '✓ All TypeScript files are covered by a tsconfig that compiles them.';
  }

  return sections.join('\n\n');
}

/**
 * Run the full verification: find all source files, check that every one is
 * covered by a tsconfig the compiler can actually load, report.
 */
export function verify(rootDirectory: string): VerifyResult {
  const workspaces = discoverWorkspaces(rootDirectory);
  const tsconfigs = findAllTsconfigs(rootDirectory, workspaces);
  const coveredFiles = new Set<string>();
  const brokenProjects: BrokenProject[] = [];

  for (const tsconfig of tsconfigs) {
    const project = loadTsconfigProject(tsconfig);
    if (project.loadErrors.length > 0) {
      // A project that cannot load checks none of its files, so counting them
      // as covered is what let the whole gate stay green over a dead project.
      brokenProjects.push({ tsconfig, loadErrors: project.loadErrors });
      continue;
    }
    for (const file of project.files) {
      coveredFiles.add(file);
    }
  }

  const workspaceDirectories = workspaces.map((ws) => path.join(rootDirectory, ws.path));
  const allSourceFiles = new Set([
    ...findAllSourceFiles(workspaceDirectories),
    ...findRootSourceFiles(rootDirectory),
  ]);
  const orphanedFiles = findOrphanedFiles(allSourceFiles, coveredFiles);

  return {
    success: orphanedFiles.length === 0 && brokenProjects.length === 0,
    orphanedFiles,
    brokenProjects,
  };
}

export const COMMAND_LINE = {
  command: 'pnpm verify:typecheck-coverage',
  summary: 'Checks that every TypeScript file is covered by a tsconfig.',
  flags: [],
  positionals: { kind: 'none' },
  effect: 'reports',
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point */
function main(): void {
  const rootDirectory = process.cwd();

  console.log('Verifying TypeScript coverage...\n');

  const result = verify(rootDirectory);
  const report = formatReport(result, rootDirectory);

  console.log(report);

  if (!result.success) {
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    if (readCommandLineOrRefuse(COMMAND_LINE, process.argv.slice(2)) !== null) main();
  } catch (error: unknown) {
    console.error('Unexpected error:', error);
    process.exit(1);
  }
}
/* v8 ignore stop */
