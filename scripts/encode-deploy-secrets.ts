/**
 * Encodes the Worker secret set as the one JSON object the API's
 * `wrangler deploy --secrets-file` reads from stdin, so the secrets ship in the
 * same upload as the code: every key of the deploy's secret list, each value
 * taken from this process's environment.
 *
 * A script rather than a shell pipeline because the shell's parser and a
 * helper's argv are both places a value is corrupted or exposed: an expression
 * substituted into a command is re-parsed before it runs (the `\n` escapes
 * inside a service-account private key collapse), and a value handed to a
 * helper as an argument is readable on that process's command line for as
 * long as it runs. Here a value leaves the environment only as bytes of this
 * process's stdout, and `JSON.stringify` does the escaping.
 *
 * A key missing or empty in the environment refuses the whole batch with no
 * output at all, so a binding gone missing from the generated env block fails
 * the deploy rather than overwriting a live secret with an empty value. Actions
 * renders an unset secret or step output as the empty string, so empty is the
 * only form "missing" takes on the runner.
 */
import { deploySecretKeys } from './generate-env.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLineOrRefuse, type CommandSpec } from './lib/cli/command-line.js';

/** The environment as read: a value, or nothing, per name. */
type EnvironmentValues = Readonly<Record<string, string | undefined>>;

/** Something that accepts a chunk of text, as `process.stdout` does. */
interface TextSink {
  write(chunk: string): unknown;
}

type DeploySecretEncoding =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * The object for the whole key list, or the names whose value is absent.
 * Names, never values: the failure branch is what reaches a log.
 */
export function encodeDeploySecrets(env: EnvironmentValues): DeploySecretEncoding {
  const keys = deploySecretKeys();
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) return { ok: false, missing };

  return { ok: true, json: JSON.stringify(Object.fromEntries(keys.map((key) => [key, env[key]]))) };
}

/** Exit status: 0 with the object on stdout, 1 with the missing names on stderr. */
export function main(env: EnvironmentValues, stdout: TextSink, stderr: TextSink): number {
  const result = encodeDeploySecrets(env);
  if (!result.ok) {
    stderr.write(
      `deploy secrets: missing or empty in the environment: ${result.missing.join(', ')}\n`
    );
    return 1;
  }
  stdout.write(`${result.json}\n`);
  return 0;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/encode-deploy-secrets.ts',
  summary: 'Prints the Worker secret set as the JSON secrets file `wrangler deploy` uploads.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
if (
  isMainModule(import.meta.url) &&
  readCommandLineOrRefuse(COMMAND_LINE, process.argv.slice(2)) !== null
) {
  process.exitCode = main(process.env, process.stdout, process.stderr);
}
/* v8 ignore stop */
