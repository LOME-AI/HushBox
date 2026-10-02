import { readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverWorkspaces } from '../cli/workspaces.js';
import { portEnvName } from './dev-ports.js';
import { missingPortVariable } from './generated-port.js';
import { stackModeFrom } from './stack-mode.js';
import type { ServiceKey } from './port-plan.js';

/**
 * Which servers a command starts, and which host ports each of those servers
 * binds — the two facts a command needs before it can claim what it started.
 *
 * The first fact is derived, never listed: a command that fans a package script
 * out across the workspace starts a server in every package whose manifest
 * declares that script, so the manifests are read and the answer follows them.
 * A hand-written set of ports would say something different the moment a
 * package gained or lost a dev server, and claiming a port no server of this
 * command bound is what lets a live run mask another command's orphan — the
 * orphan resolves to a live claim that never bound it, and no reclaimer may
 * touch it.
 *
 * The second fact cannot be derived from anything: nothing in a manifest says
 * which port a server binds. So it is declared once per package script, below,
 * and the derivation refuses a script it does not cover. A package that gains a
 * dev server therefore fails the command with a sentence naming itself, rather
 * than silently dropping out of what the command claims.
 */

/** One server: the workspace package whose script starts it, and that script. */
export interface ServerSpec {
  readonly workspace: string;
  readonly script: string;
}

/**
 * The host-port services each workspace package's server binds, per the script
 * that starts it. An empty list is the statement that the script binds none,
 * and it is what a server-less `dev` script is entitled to.
 *
 * The services are the port plan's, so a port here is the port that plan
 * allocates and the variable the server itself reads — the two cannot drift
 * into naming different numbers.
 */
const PACKAGE_SERVERS: Readonly<Record<string, Readonly<Record<string, readonly ServiceKey[]>>>> = {
  '@hushbox/admin': { dev: ['admin'] },
  // Wrangler binds the worker's port and, separately, the devtools inspector's.
  '@hushbox/api': { dev: ['api', 'apiInspector'] },
  '@hushbox/crawler-view': { dev: ['crawlerView'] },
  '@hushbox/db': { dev: ['studio'], 'db:studio': ['studio'] },
  '@hushbox/docket-console': { start: ['docket'] },
  '@hushbox/marketing': { dev: ['astro'] },
  '@hushbox/sandbox': { dev: ['sandbox'] },
  '@hushbox/web': { dev: ['vite'], preview: ['preview'] },
};

function manifestScripts(packageDir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

/**
 * Every server a fan-out of `script` across the workspace starts, in workspace
 * discovery order.
 */
export function serversRunningScript(script: string, rootDir: string): ServerSpec[] {
  return discoverWorkspaces(rootDir)
    .filter(
      (workspace) => manifestScripts(path.join(rootDir, workspace.path))[script] !== undefined
    )
    .map((workspace) => ({ workspace: workspace.fullName, script }));
}

/** The services `specs` bind, each named once however many servers bind it. */
function servicesForServers(specs: readonly ServerSpec[]): ServiceKey[] {
  const services = new Set<ServiceKey>();
  for (const spec of specs) {
    const declared = PACKAGE_SERVERS[spec.workspace]?.[spec.script];
    if (declared === undefined) {
      throw new Error(
        `${spec.workspace} declares a \`${spec.script}\` script, but nothing states which host ` +
          `ports the server it starts binds, so this command cannot claim what it starts. Give ` +
          `it an entry in PACKAGE_SERVERS — an empty list is how a script that binds none says so.`
      );
    }
    for (const service of declared) services.add(service);
  }
  return [...services];
}

/**
 * The host ports `specs` bind, for the stack whose env `env` carries.
 *
 * Each port is read from the same generated variable the server reads, so what
 * a command claims and what its servers bind cannot be two different numbers.
 */
export function portsForServers(specs: readonly ServerSpec[], env: NodeJS.ProcessEnv): number[] {
  return servicesForServers(specs).map((service) => {
    const variable = portEnvName(service);
    const raw = env[variable];
    if (raw === undefined || raw === '') {
      throw new Error(missingPortVariable(variable, stackModeFrom(env)));
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`${variable}="${raw}" names no port.`);
    }
    return port;
  });
}

/**
 * The one port a server binds, for a command line that has to name it. A
 * server binding several has no single port to pass, and saying so here is what
 * keeps a caller from silently passing the first of them.
 */
export function portForServer(spec: ServerSpec, env: NodeJS.ProcessEnv): number {
  const ports = portsForServers([spec], env);
  if (ports.length !== 1) {
    throw new Error(
      `${spec.workspace} \`${spec.script}\` binds ${String(ports.length)} host ports, so there ` +
        `is no single port to name on its command line.`
    );
  }
  const [port] = ports;
  /* v8 ignore next -- the length is one, so the element is always present */
  if (port === undefined) throw new Error(`${spec.workspace} named no port.`);
  return port;
}
