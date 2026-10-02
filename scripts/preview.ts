import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { withBuildLease } from './lib/bundling/lease.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { spawnLongLived, type LongLivedChild } from './lib/spawn/long-lived.js';
import { portForServer, portsForServers, type ServerSpec } from './lib/stack/server-ports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Leased around the build alone, never around the server that follows it: the
 * preview server outlives the build by however long someone leaves it open, and
 * a lease held that long would refuse every other writer for the same span.
 */
export async function runBuild(repoRoot: string = REPO_ROOT): Promise<void> {
  await withBuildLease(repoRoot, 'web-dist', 'pnpm preview', async () => {
    await execa('pnpm', ['--filter', '@hushbox/web', 'build'], {
      stdio: 'inherit',
    });
  });
}

const WEB_PREVIEW: ServerSpec = { workspace: '@hushbox/web', script: 'preview' };

interface PreviewServer {
  readonly spec: ServerSpec;
  /** What the server needs on its command line beyond the script that starts it. */
  readonly extraArgs: (env: NodeJS.ProcessEnv) => string[];
}

/**
 * The servers `pnpm preview` starts. One declaration decides both what runs and
 * what the run claims — the ports come from these same entries, so a server
 * added here is claimed without anyone remembering to widen a port list.
 */
const PREVIEW_SERVERS: readonly PreviewServer[] = [
  { spec: { workspace: '@hushbox/api', script: 'dev' }, extraArgs: () => [] },
  {
    spec: WEB_PREVIEW,
    // `vite preview` takes its port on the command line and binds strictly;
    // the config's `server.port` is the dev server's, a different port.
    extraArgs: (env) => ['--port', String(portForServer(WEB_PREVIEW, env)), '--open'],
  },
];

/** Where the line naming each server as it starts goes by default. */
function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The one exit code the command reports, and the end of every server that did
 * not produce it.
 *
 * A preview session ends when either half ends: the web server closing is the
 * developer finishing, and the api server exiting is a failure they need to
 * see. Both cases are the same act — stop the rest, report what the first one
 * said.
 */
async function untilOneEnds(children: readonly LongLivedChild[]): Promise<number> {
  const first = await Promise.race(
    children.map(async (child, index) => ({ index, code: await child.exit }))
  );
  await Promise.all(
    children.map((child, index) => (index === first.index ? child.exit : child.kill()))
  );
  return first.code;
}

/**
 * Starts the preview servers, claiming the ports each one binds before it
 * exists.
 *
 * Each server is spawned as a long-lived tree of its own rather than through a
 * concurrent-process helper, because the helper spawned children nothing
 * recorded: a run killed while they were up left servers holding their ports
 * with no claim naming them, so every reclaimer had to report them and leave
 * them standing. The cost is the helper's per-line name prefix, replaced by one
 * line naming each server and its ports as it starts; the servers' own output
 * reaches the terminal unchanged.
 */
export async function runPreviewServers(
  env: NodeJS.ProcessEnv = process.env,
  spawn: typeof spawnLongLived = spawnLongLived,
  report: (line: string) => void = writeLine
): Promise<number> {
  const started: LongLivedChild[] = [];
  try {
    for (const server of PREVIEW_SERVERS) {
      const { workspace, script } = server.spec;
      const ports = portsForServers([server.spec], env);
      report(`preview: ${workspace} ${script} on ${ports.join(', ')}`);
      started.push(
        await spawn('pnpm', ['--filter', workspace, script, ...server.extraArgs(env)], {
          stdio: 'inherit',
          ports,
        })
      );
    }
  } catch (error) {
    // Whatever is already up would otherwise outlive the failure holding its
    // port, which is the orphan this entry point exists to prevent.
    await Promise.all(started.map((child) => child.kill()));
    throw error;
  }

  return untilOneEnds(started);
}

export const COMMAND_LINE = {
  command: 'pnpm preview',
  summary: 'Builds the apps and starts the preview servers.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via root preview script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    await runBuild();
    return runPreviewServers();
  });
}
/* v8 ignore stop */
