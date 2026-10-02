/**
 * Reads which version of a Worker is live, off the control plane: the
 * deployment's traffic, then the version carrying it and the release tag
 * `wrangler deploy --tag` annotated it with. The deploy's order guard and its
 * post-deploy probe both judge a Worker by this one reading, and read it
 * differently: a Worker with no deployment lets the guard proceed and fails the
 * probe.
 */
import { z } from 'zod';

/** What one wrangler command answered. The exit code is absent when the command never started. */
export interface WranglerAnswer {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one wrangler command and answers what it printed and how it exited. */
export type WranglerRunner = (args: readonly string[]) => Promise<WranglerAnswer>;

/** What the control plane says is live. */
export type LiveVersion =
  | { readonly kind: 'live'; readonly versionId: string; readonly tag: string | undefined }
  /** The Worker exists and was never deployed. */
  | { readonly kind: 'none' }
  /** Traffic is not carried wholly by one version. */
  | { readonly kind: 'split' }
  | {
      readonly kind: 'unreadable';
      readonly read: 'deployment' | 'version';
      readonly failure: string;
    };

/** The annotation `wrangler deploy --tag` writes. */
const TAG_ANNOTATION = 'workers/tag';

const DeploymentSchema = z.object({
  versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })),
});

const VersionSchema = z.object({
  annotations: z.record(z.string(), z.string()).optional(),
});

/**
 * wrangler's own refusal when the Worker exists but was never deployed: it
 * exits non-zero with this sentence rather than printing an empty deployment,
 * so the sentence is the only thing that tells absence apart from any other
 * failure. Every other non-zero exit is read as unreadable.
 */
const NO_DEPLOYMENT = /The Worker \S+ has no deployments\./;

type Reading<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'failure'; readonly failure: string; readonly stderr: string };

/** Reads one wrangler answer as JSON of the given shape, or names why it cannot. */
async function read<T>(
  wrangler: WranglerRunner,
  args: readonly string[],
  extraArgs: readonly string[],
  schema: z.ZodType<T>
): Promise<Reading<T>> {
  const command = `wrangler ${args.join(' ')}`;
  try {
    const answer = await wrangler([...args, ...extraArgs]);
    if (answer.exitCode !== 0) {
      const failure = `${command} exited ${String(answer.exitCode)}: ${answer.stderr.trim()}`;
      return { kind: 'failure', failure, stderr: answer.stderr };
    }
    const parsed = schema.safeParse(JSON.parse(answer.stdout));
    if (!parsed.success) {
      return { kind: 'failure', failure: `${command} answered an unexpected shape`, stderr: '' };
    }
    return { kind: 'value', value: parsed.data };
  } catch (error: unknown) {
    return { kind: 'failure', failure: `${command} failed: ${String(error)}`, stderr: '' };
  }
}

/**
 * The Worker's live version as the control plane reports it. `extraArgs` are
 * appended to each read, such as `--cwd` naming the directory whose
 * configuration names the Worker.
 */
export async function readLiveVersion(
  wrangler: WranglerRunner,
  extraArgs: readonly string[]
): Promise<LiveVersion> {
  const status = await read(
    wrangler,
    ['deployments', 'status', '--json'],
    extraArgs,
    DeploymentSchema
  );
  if (status.kind === 'failure') {
    if (NO_DEPLOYMENT.test(status.stderr)) return { kind: 'none' };
    return { kind: 'unreadable', read: 'deployment', failure: status.failure };
  }
  const [live, ...others] = status.value.versions;
  if (live === undefined || others.length > 0 || live.percentage !== 100) {
    return { kind: 'split' };
  }
  const view = await read(
    wrangler,
    ['versions', 'view', live.version_id, '--json'],
    extraArgs,
    VersionSchema
  );
  if (view.kind === 'failure') {
    return { kind: 'unreadable', read: 'version', failure: view.failure };
  }
  return {
    kind: 'live',
    versionId: live.version_id,
    tag: view.value.annotations?.[TAG_ANNOTATION],
  };
}
