import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { spawnLongLived } from './lib/spawn/long-lived.js';
import { portsForServers, type ServerSpec } from './lib/stack/server-ports.js';

/**
 * The audit console's entry point, and where the claim naming its port is
 * taken. The wrapper it runs behind cannot know what the command it was handed
 * binds, so a command that starts a server claims the port that server binds
 * here, where the server is chosen. Without it the console a killed run leaves
 * behind is *unowned* — reported by the auditor and left standing by any
 * reclaim that was not given the printed permission an unowned resource needs;
 * `pnpm dev:clean --unowned` grants it.
 *
 * The claim is taken for every invocation, including the ones whose arguments
 * ask the console package for a report rather than a server. A claim naming a
 * port nothing bound is harmless and lasts only as long as that report; telling
 * the two apart here would mean a second copy of the console's own argument
 * parser, and two spellings of one decision drift.
 */
const DOCKET_CONSOLE: ServerSpec = { workspace: '@hushbox/docket-console', script: 'start' };

export async function runDocket(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  spawn: typeof spawnLongLived = spawnLongLived
): Promise<number> {
  const ports = portsForServers([DOCKET_CONSOLE], env);
  const child = await spawn(
    'pnpm',
    ['--filter', DOCKET_CONSOLE.workspace, DOCKET_CONSOLE.script, ...argv],
    { stdio: 'inherit', ports }
  );
  return child.exit;
}

/* v8 ignore start -- CLI entry point exercised via the root docket script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runDocket(process.argv.slice(2)));
}
/* v8 ignore stop */
