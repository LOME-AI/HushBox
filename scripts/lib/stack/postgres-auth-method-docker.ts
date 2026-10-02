/**
 * Docker-backed deps for the repair in `scripts/lib/stack/postgres-auth-method.ts`.
 *
 * The repair cannot go through the connection it exists to fix: the app's
 * driver is the thing a wrong authentication method breaks, so a bring-up that
 * reached for it would find the cluster unreachable exactly when there is
 * something to repair. It goes through the container's own Unix socket
 * instead, which the image leaves on `trust` whatever method it selects for TCP
 * clients — a channel that stays open on the broken volume and the repaired
 * one alike.
 *
 * Nothing here can destroy anything: every command is an `exec` into the
 * already-running service, the edit replaces one token per rule, and making the
 * new rules current is a configuration reload rather than a restart.
 *
 * The docker command is injected as a runner so the commands and their
 * exit-code handling are unit-testable without a live docker daemon.
 */
import { CHECKOUT_DIRECTORY, composeArguments } from '../../compose.js';
import type { HostAuthRule, PostgresAuthMethodDeps } from './postgres-auth-method.js';

export interface ComposeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ComposeRunner = (args: readonly string[]) => Promise<ComposeCommandResult>;

/** The compose service holding the cluster, and the one every command here enters. */
const SERVICE = 'postgres';

/** The database `initdb` always creates, so a maintenance query has one to name. */
const MAINTENANCE_DATABASE = 'postgres';

/**
 * `hostssl`, `hostnossl` and `hostgssenc` authenticate a TCP client the same
 * way `host` does, so the prefix is what selects the rules a remote driver can
 * land on.
 */
const HOST_RULES_QUERY =
  "SELECT line_number || '|' || coalesce(auth_method, '') FROM pg_hba_file_rules " +
  "WHERE type LIKE 'host%' ORDER BY line_number";

const HBA_FILE_QUERY = "SELECT current_setting('hba_file')";

/**
 * Written beside the file it rewrites rather than in a publicly writable
 * directory, where the path could already have been created as something else.
 * The same script removes it.
 */
const SCRATCH_SUFFIX = '.hushbox-rewrite';

/** Every method Postgres names is a word of these characters; anything else is not one. */
const METHOD_SHAPE = /^[a-z0-9-]+$/;

const REPAIRED_METHOD = 'password';

function psqlArgs(role: string, statement: string): readonly string[] {
  return composeArguments(CHECKOUT_DIRECTORY, [
    'exec',
    '-T',
    SERVICE,
    'psql',
    '-U',
    role,
    '-d',
    MAINTENANCE_DATABASE,
    '-tAXc',
    statement,
  ]);
}

async function runOrThrow(
  run: ComposeRunner,
  args: readonly string[],
  what: string
): Promise<string> {
  const result = await run(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `ensure-stack: ${what} exited ${String(result.exitCode)} — ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

function parseRule(row: string): HostAuthRule {
  const separator = row.indexOf('|');
  const lineNumber = Number(row.slice(0, separator));
  if (separator === -1 || !Number.isInteger(lineNumber)) {
    throw new Error(
      `ensure-stack: pg_hba_file_rules answered a row this cannot read — "${row}". ` +
        'The local Postgres authentication method cannot be checked.'
    );
  }
  return { lineNumber, authMethod: row.slice(separator + 1) };
}

function rewriteScript(hbaFile: string, rules: readonly HostAuthRule[]): string {
  const substitutions = rules
    .map((rule) => `-e '${String(rule.lineNumber)}s/${rule.authMethod}/${REPAIRED_METHOD}/'`)
    .join(' ');
  // `cat` through the existing file rather than moving one over it: the server
  // reads this path by name and the image gives it an owner and a mode that a
  // freshly created replacement would not carry.
  const scratch = `'${hbaFile}${SCRATCH_SUFFIX}'`;
  return [
    'set -e',
    `sed ${substitutions} '${hbaFile}' > ${scratch}`,
    `cat ${scratch} > '${hbaFile}'`,
    `rm -f ${scratch}`,
  ].join('\n');
}

async function readHbaFile(run: ComposeRunner, role: string): Promise<string> {
  const answer = await runOrThrow(
    run,
    psqlArgs(role, HBA_FILE_QUERY),
    'reading the authentication file path'
  );
  const hbaFile = answer.trim();
  if (hbaFile === '') {
    throw new Error(
      'ensure-stack: the local Postgres names no client authentication file, so nothing here ' +
        'can repair the method it asks for.'
    );
  }
  if (hbaFile.includes("'")) {
    throw new Error(
      `ensure-stack: the client authentication file is at "${hbaFile}", a path this cannot ` +
        'quote into a shell command. Repair the authentication method by hand, or run `pnpm db:reset`.'
    );
  }
  return hbaFile;
}

export function createDockerPostgresAuthDeps(
  run: ComposeRunner,
  options: { readonly role: string; readonly report: (message: string) => void }
): PostgresAuthMethodDeps {
  return {
    readHostRules: async () => {
      const stdout = await runOrThrow(
        run,
        psqlArgs(options.role, HOST_RULES_QUERY),
        'reading the client authentication rules'
      );
      return stdout
        .split('\n')
        .map((row) => row.trim())
        .filter((row) => row !== '')
        .map((row) => parseRule(row));
    },

    acceptPasswordOn: async (rules) => {
      for (const rule of rules) {
        if (!METHOD_SHAPE.test(rule.authMethod)) {
          throw new Error(
            `ensure-stack: the client authentication rule on line ${String(rule.lineNumber)} ` +
              `asks for "${rule.authMethod}", which this cannot rewrite. Repair it by hand, or ` +
              'run `pnpm db:reset`.'
          );
        }
      }
      const hbaFile = await readHbaFile(run, options.role);
      await runOrThrow(
        run,
        composeArguments(CHECKOUT_DIRECTORY, [
          'exec',
          '-T',
          SERVICE,
          'sh',
          '-c',
          rewriteScript(hbaFile, rules),
        ]),
        'rewriting the client authentication rules'
      );
      await runOrThrow(
        run,
        psqlArgs(options.role, 'SELECT pg_reload_conf()'),
        'reloading the client authentication rules'
      );
    },

    report: options.report,
  };
}
