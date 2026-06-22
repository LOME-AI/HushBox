/**
 * Eagerly downloads the pinned gitleaks binary on `pnpm install` (wired as the
 * root `postinstall`). All logic lives in lib/gitleaks.ts; this is only the
 * runtime entry point.
 */
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { ensureGitleaks } from './lib/gitleaks.js';

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(async () => {
    const bin = await ensureGitleaks();
    console.log(`gitleaks ready: ${bin}`);
  });
}
/* v8 ignore stop */
