import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { describePort, type StackMode } from '../stack/port-plan.js';
import { portsForServers, type ServerSpec } from '../stack/server-ports.js';
import { stackModeFrom } from '../stack/stack-mode.js';
import { stackSlotFrom } from '../stack/stack-slot.js';

/**
 * Which servers the end-to-end run starts, and which host ports each of those
 * servers binds — the two facts that run needs before it can claim what it
 * started, answered the way `../stack/server-ports.ts` answers them for a
 * package-script fan-out.
 *
 * The first fact is derived, never listed: Playwright starts exactly the
 * servers its configuration declares as `webServer` entries, so that
 * declaration is read and the answer follows it. A server added there enters
 * this set the moment it is declared, and one removed leaves it.
 *
 * The second fact is read off each declaration in the one way that declaration
 * states it — the ports of the workspace package script it runs, and any port
 * it names on its own command line. A declaration stating neither is refused by
 * name, because a server whose ports the run cannot state is one whose orphan
 * no reclaimer may touch: claiming ports this run never binds is the same
 * defect from the other side, since a dead peer's leaked listener on one of
 * them would resolve to this run's live claim and be left standing.
 */

/** One `webServer` entry, in the shape this module reads it. */
interface WebServerDeclaration {
  readonly name?: string | undefined;
  readonly command: string;
}

/** The configuration file Playwright loads, which is also what this reads. */
const CONFIG_FILE = 'playwright.config.ts';

const webServerSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1),
});

const configSchema = z.object({ webServer: z.array(webServerSchema) });

/** How a server is addressed in a refusal: its declared name, else its command. */
function label(server: WebServerDeclaration): string {
  return server.name ?? `\`${server.command}\``;
}

/**
 * The workspace package script a command runs, or nothing when it runs none.
 * `pnpm --filter <package> <script>` is the one spelling the declarations use,
 * and a command shaped any other way states its ports on its own line instead.
 */
function packageScriptIn(command: string): ServerSpec | undefined {
  const [runner, filter, workspace, script] = command.split(/\s+/u);
  if (runner !== 'pnpm' || filter !== '--filter') return undefined;
  if (workspace === undefined || script === undefined || script.startsWith('-')) return undefined;
  return { workspace, script };
}

const PORT_FLAG = '--port=';

/** Whether the port plan allocates `port` to this slot and this stack. */
function allocatedTo(port: number, slot: number, mode: StackMode): boolean {
  const allocated = describePort(port);
  if (allocated === undefined) return false;
  return allocated.slot === slot && allocated.modes.includes(mode);
}

/**
 * The ports a command names on its own line, each checked against the port plan
 * for the stack `env` carries. Unchecked, a mis-parsed number would be claimed
 * as if a server bound it, which is the masking this whole derivation exists to
 * remove; checked, a command whose port belongs to another slot or another mode
 * refuses instead.
 */
function portsNamedOn(server: WebServerDeclaration, env: NodeJS.ProcessEnv): number[] {
  const named = server.command
    .split(/\s+/u)
    .filter((token) => token.startsWith(PORT_FLAG))
    .map((token) => Number(token.slice(PORT_FLAG.length)));
  if (named.length === 0) return [];

  const slot = stackSlotFrom(env);
  const mode = stackModeFrom(env);
  for (const port of named) {
    if (!allocatedTo(port, slot, mode)) {
      throw new Error(
        `${label(server)} names port ${String(port)}, which the port plan does not allocate to ` +
          `the ${mode} stack this run loaded. A server of this run binds a port of this run's ` +
          `own stack, so claiming that one would name a port nothing here binds.`
      );
    }
  }
  return named;
}

/** Every host port one declared server binds, refusing a declaration stating none. */
function portsForWebServer(server: WebServerDeclaration, env: NodeJS.ProcessEnv): number[] {
  const script = packageScriptIn(server.command);
  const ports = [
    ...(script === undefined ? [] : portsForServers([script], env)),
    ...portsNamedOn(server, env),
  ];
  if (ports.length === 0) {
    throw new Error(
      `${label(server)} states no host port: its command neither runs a workspace package script ` +
        `nor names a port, so this run cannot claim what that server binds. Start it with ` +
        `\`pnpm --filter <package> <script>\`, whose ports are declared beside the port plan, or ` +
        `have it take its port as \`${PORT_FLAG}<port>\`.`
    );
  }
  return ports;
}

/** The host ports `servers` bind, each named once however many servers bind it. */
export function portsForWebServers(
  servers: readonly WebServerDeclaration[],
  env: NodeJS.ProcessEnv
): number[] {
  const ports = new Set<number>();
  for (const server of servers) {
    for (const port of portsForWebServer(server, env)) ports.add(port);
  }
  return [...ports];
}

/** How the configuration module is obtained, so a test can supply one. */
type LoadConfigModule = (specifier: string) => Promise<unknown>;

/**
 * The servers Playwright's own configuration declares, read from the file
 * Playwright reads. Loaded by path rather than imported by specifier: this
 * module is compiled as part of a package whose program the configuration is
 * not in, and the configuration is a runtime declaration whose shape is checked
 * here rather than at a seam the compiler owns.
 */
export async function declaredWebServers(
  repoRoot: string,
  load: LoadConfigModule = (specifier) => import(specifier)
): Promise<WebServerDeclaration[]> {
  const module = await load(pathToFileURL(path.join(repoRoot, CONFIG_FILE)).href);
  const parsed = configSchema.safeParse((module as { default?: unknown }).default);
  if (!parsed.success) {
    throw new Error(
      `${CONFIG_FILE} declares no readable \`webServer\` list, so which servers the end-to-end ` +
        `run starts — and therefore which ports it may claim — cannot be established.`
    );
  }
  return parsed.data.webServer;
}
