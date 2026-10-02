/**
 * Writes the escrow copy of one GitHub environment's secrets whose loss class
 * says a copy must exist: encrypted to recipients whose identities live only
 * offline, then uploaded once to the escrow bucket. One run writes one
 * environment's set, because a job declares one environment, and a value held
 * on any other resolves to the empty string.
 *
 * A script rather than a shell step for the reason `encode-deploy-secrets.ts`
 * carries: a value substituted into a command is re-parsed before it runs, and a
 * value handed to a helper as an argument is readable on that process's command
 * line. Here every value leaves the environment only as ciphertext.
 */
import { escrowEnvironments } from './generate-env.js';
import { escrowSecrets } from './lib/escrow/escrow.js';
import { ESCROW_RECIPIENTS } from './lib/escrow/recipients.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { signedFetch } from './lib/escrow/upload.js';
import type { EnvironmentValues } from './lib/escrow/payload.js';
import type { SignedFetch } from './lib/escrow/upload.js';

/** Something that accepts a chunk of text, as `process.stdout` does. */
interface TextSink {
  write(chunk: string): unknown;
}

/**
 * The whole run. Names the object it wrote, which is what a drill is given; a
 * refusal of any kind throws, and the entry point below turns that into a
 * non-zero exit with the cause chain on stderr.
 */
export async function runEscrowSecrets(
  env: EnvironmentValues,
  argv: readonly string[],
  fetchImpl: SignedFetch,
  stdout: TextSink
): Promise<void> {
  const invocation = readCommandLine(COMMAND_LINE, argv, (text) => {
    stdout.write(text);
  });
  if (invocation === null) return;
  const environment = readEnvironmentArgument(invocation.positionals);
  const objectKey = await escrowSecrets({
    env,
    environment,
    recipients: ESCROW_RECIPIENTS,
    fetchImpl,
  });
  stdout.write(`escrow: wrote ${objectKey}\n`);
}

/**
 * Which set the run writes. Named on the command line rather than read off the
 * environment: the runner holds no variable that says which GitHub environment
 * a job is running under, and a set inferred wrongly would encrypt whatever
 * bindings happened to resolve and call it a copy of a different set.
 */
function readEnvironmentArgument(positionals: readonly string[]): string {
  const environments = escrowEnvironments();
  const [environment, ...extra] = positionals;
  if (environment === undefined || extra.length > 0) {
    throw new Error(
      `escrow: name exactly one environment to write the set of. Environments: ${environments.join(', ')}.`
    );
  }
  if (!environments.includes(environment)) {
    throw new Error(
      `escrow: ${environment} names no environment the escrow runs under. Environments: ${environments.join(', ')}.`
    );
  }
  return environment;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/escrow-secrets.ts',
  summary:
    "Writes the escrow copy of one GitHub environment's secrets whose loss class requires one.",
  flags: [],
  positionals: {
    kind: 'many',
    placeholder: '<environment>',
    summary: 'The GitHub environment whose escrow set this run writes.',
  },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI wiring; runEscrowSecrets is covered via unit tests */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    runEscrowSecrets(process.env, process.argv.slice(2), signedFetch, process.stdout)
  );
}
/* v8 ignore stop */
