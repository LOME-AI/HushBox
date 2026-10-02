import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { spawnLongLived } from './lib/spawn/long-lived.js';
import { portForServer, type ServerSpec } from './lib/stack/server-ports.js';

/**
 * The database studio's entry point, and where the claim naming its port is
 * taken. The wrapper it runs behind cannot know what the command it was handed
 * binds, so a command that starts a server claims the port that server binds
 * here, where the port is chosen. Without it the studio a killed run leaves
 * behind is *unowned* — reported by the auditor and left standing by any
 * reclaim that was not given the printed permission an unowned resource needs;
 * `pnpm dev:clean --unowned` grants it.
 */
const DB_STUDIO: ServerSpec = { workspace: '@hushbox/db', script: 'db:studio' };

export async function runDrizzleStudio(
  env: NodeJS.ProcessEnv = process.env,
  spawn: typeof spawnLongLived = spawnLongLived
): Promise<number> {
  // One reading of the port serves both the flag the studio binds by and the
  // claim, so the two can never name different numbers.
  const port = portForServer(DB_STUDIO, env);
  const child = await spawn('drizzle-kit', ['studio', `--port=${String(port)}`], {
    stdio: 'inherit',
    ports: [port],
  });
  return child.exit;
}

export const COMMAND_LINE = {
  command: 'pnpm db:studio',
  summary: 'Starts the database studio.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via packages/db db:studio script */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return runDrizzleStudio();
  });
}
/* v8 ignore stop */
