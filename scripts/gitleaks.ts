/**
 * `pnpm gitleaks <args>` — ensures the pinned binary is present, then runs it
 * with the passed arguments, propagating its exit code.
 */
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { ensureGitleaks, runGitleaks } from './lib/gitleaks.js';

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(() =>
    runGitleaks(process.argv.slice(2), {
      ensure: ensureGitleaks,
      exec: (bin, args) => execa(bin, [...args], { stdio: 'inherit', reject: false }),
    })
  );
}
/* v8 ignore stop */
