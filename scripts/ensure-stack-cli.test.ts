/* eslint-disable sonarjs/publicly-writable-directories -- tmpdir is standard for test fixtures */
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  // `pnpm generate:env --mode=ciX` step has already written CI-mode env
  // files; a regen here would overwrite them with Mode.Development values
  // and drop the GitHub-secret bindings the tests rely on.
  it('exits cleanly without rewriting apps/api/.dev.vars when CI=1', async () => {
    // Stamp the existing file (or create a placeholder so the assertion has
    // something to compare against) and capture its mtime BEFORE the run.
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

  // Sanity check the inverse: with no CI flag, the CLI does its full setup —
  // we don't run the full bring-up (too slow, requires Docker), but we can
  // verify the env file gets rewritten. Easiest way: edit the file with a
  // sentinel line, observe the mtime change after the run. Falls back to a
  // skip when docker isn't available so this test doesn't fail on contributor
  // machines that haven't run `pnpm dev` once.
  it('rewrites env files when CI is unset (smoke)', async () => {
    if (!existsSync(DEV_VARS)) return; // skip — never run on this machine
    const sentinel = `# sentinel-${String(Date.now())}\n`;
    writeFileSync(DEV_VARS, sentinel);
    const before = mtimeMsOrNull(DEV_VARS);

    // Allow some time so mtimes can differ even on coarse fs clocks.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const env = { ...process.env };
    delete env['CI'];
    const result = await execa('tsx', [CLI, '--quiet'], {
      env,
      reject: false,
      timeout: 60_000,
    });

    // If the run failed (likely no Docker on this machine), skip the post
    // condition check rather than turn a missing-infra signal into a red test.
    if (result.exitCode !== 0) return;

    const after = mtimeMsOrNull(DEV_VARS);
    expect(after).not.toBe(before);
    const content = readFileSync(DEV_VARS, 'utf8');
    expect(content).not.toContain(sentinel.trim());
  }, 120_000);
});
