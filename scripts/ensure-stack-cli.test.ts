import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CLI = path.join(SCRIPTS_DIR, 'ensure-stack-cli.ts');
const DEV_VARS = path.join(REPO_ROOT, 'apps', 'api', '.dev.vars');

function mtimeMsOrNull(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mtimeMs;
}

describe('ensure-stack-cli CI behavior', () => {
  // The CLI must not touch env files when CI is set. The workflow's
  // generate:env step has already written CI-mode env files; a regen here
  // would overwrite them with Mode.Development values and drop the
  // GitHub-secret bindings the tests rely on.
  it('exits cleanly without rewriting apps/api/.dev.vars when CI=1', async () => {
    if (!existsSync(DEV_VARS)) {
      writeFileSync(DEV_VARS, '# placeholder for ensure-stack-cli.test\n');
    }
    const before = mtimeMsOrNull(DEV_VARS);

    const result = await execa('tsx', [CLI], {
      env: { ...process.env, CI: '1' },
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('CI no-op');
    const after = mtimeMsOrNull(DEV_VARS);
    expect(after).toBe(before);
  }, 30_000);
});
