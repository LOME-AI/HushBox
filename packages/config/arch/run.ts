#!/usr/bin/env tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { discoverRuleFiles, formatViolations, loadRules, runRules } from './lib/harness.js';
import { REPO_ROOT, absoluteGlobs } from './lib/source-scope.js';

/**
 * Architecture-rule runner. Loads every `arch/rules/*.rule.ts`, builds the
 * ts-morph project over the declared source scope (`lib/source-scope.ts`),
 * runs the rules, and exits non-zero on violations.
 *
 * Run via `pnpm arch:check` (root) — also wired as a CI step.
 */

const ARCH_DIR = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const ruleFiles = discoverRuleFiles(path.join(ARCH_DIR, 'rules'));
  const rules = await loadRules(ruleFiles);
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(absoluteGlobs(REPO_ROOT));

  const results = runRules(rules, project);
  if (results.length > 0) {
    console.error('arch:check: ARCHITECTURE RULE VIOLATIONS');
    console.error(formatViolations(results));
    process.exitCode = 1;
    return;
  }
  console.warn(
    `arch:check: OK — ${String(rules.length)} rule(s) over ${String(project.getSourceFiles().length)} file(s)`
  );
}

await main();
