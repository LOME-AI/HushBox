/**
 * ESLint wrapper with filtering by rule, package, and file.
 * Uses turbo for caching and workspaces.ts for dynamic package discovery.
 */

import { execa } from 'execa';
import { discoverWorkspaces, type Workspace } from './workspaces.js';

export interface LintMessage {
  ruleId: string | null;
  line: number;
  column: number;
  message: string;
  severity: number;
}

export interface LintResult {
  filePath: string;
  messages: LintMessage[];
  errorCount: number;
  warningCount: number;
}

export interface LintFilters {
  rules: string[];
  packages: string[];
  files: string[];
}

export function parseArgs(args: string[]): LintFilters {
  const filters: LintFilters = {
    rules: [],
    packages: [],
    files: [],
  };

  for (const argument of args) {
    if (argument.startsWith('--rule=')) {
      filters.rules.push(argument.slice('--rule='.length));
    } else if (argument.startsWith('--package=')) {
      filters.packages.push(argument.slice('--package='.length));
    } else if (argument.startsWith('--file=')) {
      filters.files.push(argument.slice('--file='.length));
    }
  }

  return filters;
}

export function validateFilters(filters: LintFilters, workspaces: Workspace[]): void {
  const workspaceNames = new Set(workspaces.map((w) => w.name));

  for (const package_ of filters.packages) {
    if (!workspaceNames.has(package_)) {
      const available = [...workspaceNames].toSorted((a, b) => a.localeCompare(b)).join(', ');
      throw new Error(`Unknown package: "${package_}". Available: ${available}`);
    }
  }
}

export function filterByRule(results: LintResult[], rules: string[]): LintResult[] {
  if (rules.length === 0) {
    return results;
  }

  return results
    .map((result) => ({
      ...result,
      messages: result.messages.filter((message) =>
        rules.some((rule) => message.ruleId?.includes(rule))
      ),
    }))
    .filter((result) => result.messages.length > 0);
}

export function filterByFile(results: LintResult[], files: string[]): LintResult[] {
  if (files.length === 0) {
    return results;
  }

  return results.filter((result) => files.some((file) => result.filePath.includes(file)));
}

function formatMessage(message: LintMessage): { line: string; isError: boolean } {
  const severity = message.severity === 2 ? 'error' : 'warning';
  const line = `  ${String(message.line)}:${String(message.column)}  ${severity}  ${message.message}  ${message.ruleId ?? ''}`;
  return { line, isError: message.severity === 2 };
}

export function formatOutput(results: LintResult[]): string {
  const resultsWithMessages = results.filter((r) => r.messages.length > 0);

  if (resultsWithMessages.length === 0) {
    return 'No lint errors found.';
  }

  const lines: string[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const result of resultsWithMessages) {
    lines.push(`\n${result.filePath}`);

    for (const message of result.messages) {
      const { line, isError } = formatMessage(message);
      lines.push(line);
      if (isError) totalErrors++;
      else totalWarnings++;
    }
  }

  lines.push('', `${String(totalErrors)} errors, ${String(totalWarnings)} warnings`);

  return lines.join('\n');
}

/**
 * Extract JSON arrays from turbo output.
 * Turbo prefixes each line with package name, e.g., "@lome-chat/web:lint: [...]"
 */
export function extractJsonFromTurboOutput(output: string): LintResult[] {
  const allResults: LintResult[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match lines containing JSON arrays (turbo output format: "package:task: [...]")
    const jsonMatch = /:\s*(\[[\s\S]*\])\s*$/.exec(line);
    if (jsonMatch?.[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as LintResult[];
        allResults.push(...parsed);
      } catch {
        // Ignore non-JSON lines in turbo output
      }
    }
  }

  return allResults;
}

export async function runLint(filters: LintFilters, rootDirectory?: string): Promise<LintResult[]> {
  const root = rootDirectory ?? process.cwd();
  const workspaces = discoverWorkspaces(root);

  validateFilters(filters, workspaces);

  // Build turbo filter args
  const filterArgs: string[] = [];
  if (filters.packages.length > 0) {
    const targetWorkspaces = workspaces.filter((w) => filters.packages.includes(w.name));
    for (const workspace of targetWorkspaces) {
      filterArgs.push('--filter', workspace.fullName);
    }
  }

  const args = ['turbo', 'lint', '--continue', ...filterArgs, '--', '--format', 'json'];

  const result = await execa('pnpm', args, { cwd: root, reject: false });
  const output = result.stdout + '\n' + result.stderr;

  let results = extractJsonFromTurboOutput(output);

  results = filterByRule(results, filters.rules);
  results = filterByFile(results, filters.files);

  return results;
}

/* v8 ignore start */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  void (async () => {
    try {
      const filters = parseArgs(process.argv.slice(2));
      const results = await runLint(filters);
      console.log(formatOutput(results));
      const hasErrors = results.some((r) => r.messages.some((m) => m.severity === 2));
      process.exit(hasErrors ? 1 : 0);
    } catch (error: unknown) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
