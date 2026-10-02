/**
 * Eagerly downloads the pinned gitleaks binary on `pnpm install` (wired as the
 * root `postinstall`). All logic lives in lib/privacy/gitleaks.ts; this is only the
 * runtime entry point.
 */
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { ensureGitleaks } from './lib/privacy/gitleaks.js';

export const COMMAND_LINE = {
  command: 'tsx scripts/ensure-gitleaks.ts',
  summary: 'Downloads the pinned gitleaks binary.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const bin = await ensureGitleaks();
    console.log(`gitleaks ready: ${bin}`);
  });
}
/* v8 ignore stop */
