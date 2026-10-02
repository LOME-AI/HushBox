import { Mode } from '@hushbox/shared';
import { stackModeFor } from '../../generate-env.js';
import { ENV_MODE_VARIABLE, envModeFrom } from '../../with-env.js';

/**
 * Refuse a Playwright run whose loaded env files are not the end-to-end
 * stack's.
 *
 * Each stack bands its own ports and addresses its own database, Redis
 * namespace and bucket, so a run that loaded the development stack would take
 * that stack's band and that stack's data — the collision the banding exists to
 * remove. The whole of `playwright.config.ts` reads variables the loaded stack
 * supplies, which is why this is checked once here rather than at each read.
 *
 * It is a `globalSetup` module, not a check in the config body, because the
 * config is also LOADED by tools that run nothing: knip resolves this repo's
 * entry points through it, and a refusal there took the whole unused-export
 * gate down. A run is what must refuse; an import must not.
 *
 * The `webServer` list is started, and awaited, before any global setup module
 * runs, so a wrong-stack run reaches this having already spawned its servers on
 * the wrong band. Two things bound that. Nothing is evicted, because every
 * server declares `reuseExistingServer: false` — Playwright fails on a bound
 * port rather than taking it. And this refuses ahead of the suite's own global
 * setup and its setup projects, the first of the suite's steps that write to a
 * stack: none of them reaches a stack this did not admit. Which is also why it
 * is declared first in the list.
 */
export default function requireE2eStack(): void {
  const wanted = stackModeFor(Mode.E2E);
  const named = envModeFrom(process.env);
  if (named !== undefined && stackModeFor(named) === wanted) return;
  throw new Error(
    `${ENV_MODE_VARIABLE} is "${named ?? '<unset>'}", which is no mode of the ${wanted} stack - run Playwright through \`pnpm e2e\`, which loads the ${wanted} stack's env files.`
  );
}
