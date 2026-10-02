#!/usr/bin/env tsx
/**
 * Resolve `run-script:<name>` labels on the merged PR for the current commit
 * against `ops/manifest.yml`, validate them, and emit pre-deploy / post-deploy
 * partitions to `$GITHUB_OUTPUT`.
 *
 * Designed to replace an inline `actions/github-script` step so the
 * workflow has access to ops's workspace deps (js-yaml in particular —
 * pnpm doesn't hoist to the repo root, so `require('js-yaml')` inside
 * github-script can't resolve).
 *
 * Inputs (env):
 *   GITHUB_TOKEN      — bearer for the GitHub REST API (provided by Actions)
 *   GITHUB_REPOSITORY — "owner/repo" (provided by Actions)
 *   GITHUB_SHA        — merge commit SHA (provided by Actions)
 *   GITHUB_OUTPUT     — path to write workflow outputs (provided by Actions)
 *   <secrets...>      — every value listed in any script's requires_secrets
 *
 * Outputs (`$GITHUB_OUTPUT`):
 *   pre  — JSON array of `{ name, file }` for pre-deploy scripts
 *   post — JSON array of `{ name, file }` for post-deploy scripts
 *
 * Hard-fails (exit 1) on:
 *   - a `run-script:<name>` label naming a `dispatch_only` script
 *   - unknown `run-script:<name>` label (name not in ops/manifest.yml)
 *   - script whose `requires_secrets` is missing or empty in env
 */
import { fetchAssociatedPrLabels } from './associated-pull-requests.js';
import { loadManifest, type OpsManifest, type OpsScript } from './generate-labels.js';
import { requireEnv, writeGithubOutput } from './run-cli.js';

export const LABEL_PREFIX = 'run-script:';

/**
 * Which of the two triggers is asking. Required, and the compiler is the whole
 * point: a `dispatch_only` script is refused on the pull-request value and
 * admitted on the manual-dispatch one, so a caller that could reach for a
 * permissive default would get admission to a control whose failure mode is a
 * production outage. There is no default to reach for.
 */
export type ResolveTrigger = 'pull-request' | 'manual-dispatch';

interface ResolveInput {
  labels: readonly string[];
  manifest: OpsManifest;
  env: Readonly<Record<string, string | undefined>>;
  trigger: ResolveTrigger;
}

export interface ScriptRef {
  name: OpsScript['name'];
  file: OpsScript['file'];
}

export type ResolveOutput =
  | { ok: true; pre: readonly ScriptRef[]; post: readonly ScriptRef[] }
  | { ok: false; error: string };

function unknownLabelError(name: string): string {
  return (
    `Label run-script:${name} is not in ops/manifest.yml. ` +
    `Either remove the label, or add the script to the manifest ` +
    `(requires CODEOWNERS approval).`
  );
}

function dispatchOnlyLabelError(scriptName: string): string {
  return (
    `Label run-script:${scriptName} names a dispatch_only script in ` +
    `ops/manifest.yml: the deploy phases are the wrong moment to run it, so ` +
    `no such label is minted and applying one by hand fails the deploy. ` +
    `Remove the label and run ${scriptName} from the manual workflow ` +
    `.github/workflows/run-ops-script.yml, which resolves the same manifest ` +
    `entry under the same production approval.`
  );
}

function missingSecretError(scriptName: string, secret: string): string {
  return (
    `Script ${scriptName} requires secret ${secret}, but it's missing ` +
    `(or empty) in the runner env. Did someone forget to run ` +
    `'pnpm generate:env' after editing packages/shared/src/env/env.config.ts?`
  );
}

/**
 * Resolve every requested name against the manifest in one pass, so the
 * secret check below receives scripts rather than names it would have to look
 * up again — a second lookup can only fail in a way this one has already ruled
 * out, and an unreachable guard is a branch nothing can cover.
 */
function resolveRequestedScripts(
  requested: readonly string[],
  allowed: ReadonlyMap<string, OpsScript>
): { ok: true; scripts: readonly OpsScript[] } | { ok: false; unknown: string } {
  const scripts: OpsScript[] = [];
  for (const name of requested) {
    const script = allowed.get(name);
    if (script === undefined) return { ok: false, unknown: name };
    scripts.push(script);
  }
  return { ok: true, scripts };
}

function findMissingSecret(
  scripts: readonly OpsScript[],
  env: Readonly<Record<string, string | undefined>>
): { script: string; secret: string } | null {
  for (const script of scripts) {
    for (const secret of script.requires_secrets) {
      const value = env[secret];
      if (value === undefined || value === '') {
        return { script: script.name, secret };
      }
    }
  }
  return null;
}

function projectRef(script: OpsScript): ScriptRef {
  return { name: script.name, file: script.file };
}

/**
 * Manifest existence + required-secret validation shared by both trigger
 * paths: the pull-request flow below and the manual dispatch runner
 * (`ops/lib/resolve-dispatch-script.ts`), which synthesises a label from the
 * chosen name so the two reject unknown names and missing secrets
 * identically. They part on `dispatch_only`, which the manual path admits
 * because it is that script's supported trigger, and the pull-request path
 * refuses: the label generator mints no label for such a script, so a label
 * reaching here was created and applied by hand, and failing the deploy loudly
 * beats a silent skip that would read as the script having run.
 */
export function resolveLabels(input: ResolveInput): ResolveOutput {
  const allowed = new Map(input.manifest.scripts.map((s) => [s.name, s]));

  if (input.trigger === 'pull-request') {
    const dispatchOnly = input.manifest.scripts.find(
      (script) =>
        script.dispatch_only === true && input.labels.includes(`${LABEL_PREFIX}${script.name}`)
    );
    if (dispatchOnly !== undefined) {
      return { ok: false, error: dispatchOnlyLabelError(dispatchOnly.name) };
    }
  }

  const requested = input.labels
    .filter((l) => l.startsWith(LABEL_PREFIX))
    .map((l) => l.slice(LABEL_PREFIX.length));

  const resolved = resolveRequestedScripts(requested, allowed);
  if (!resolved.ok) {
    return { ok: false, error: unknownLabelError(resolved.unknown) };
  }

  const missing = findMissingSecret(resolved.scripts, input.env);
  if (missing !== null) {
    return { ok: false, error: missingSecretError(missing.script, missing.secret) };
  }

  const requestedSet = new Set(requested);
  const pre = input.manifest.scripts
    .filter((s) => s.phase === 'pre-deploy' && requestedSet.has(s.name))
    .map((s) => projectRef(s));
  const post = input.manifest.scripts
    .filter((s) => s.phase === 'post-deploy' && requestedSet.has(s.name))
    .map((s) => projectRef(s));

  return { ok: true, pre, post };
}

/* v8 ignore start -- CLI entry: real I/O, hits GitHub API, writes to $GITHUB_OUTPUT */

async function main(): Promise<void> {
  const token = requireEnv('GITHUB_TOKEN');
  const repository = requireEnv('GITHUB_REPOSITORY');
  const sha = requireEnv('GITHUB_SHA');
  const githubOutput = requireEnv('GITHUB_OUTPUT');

  const prLabels = await fetchAssociatedPrLabels({ repository, sha, token });
  if (!prLabels.ok) {
    console.error(prLabels.error);
    process.exit(1);
  }

  const labels = prLabels.labels;
  if (labels.length === 0) {
    console.log('No PR associated with this commit; no ops scripts to run.');
    writeGithubOutput(githubOutput, 'pre', '[]');
    writeGithubOutput(githubOutput, 'post', '[]');
    return;
  }

  const manifest = loadManifest(process.cwd());
  const result = resolveLabels({
    labels,
    manifest,
    env: process.env,
    trigger: 'pull-request',
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  const preNames = result.pre.map((s) => s.name).join(', ') || '(none)';
  const postNames = result.post.map((s) => s.name).join(', ') || '(none)';
  console.log(`Pre-deploy ops scripts: ${preNames}`);
  console.log(`Post-deploy ops scripts: ${postNames}`);

  writeGithubOutput(githubOutput, 'pre', JSON.stringify(result.pre));
  writeGithubOutput(githubOutput, 'post', JSON.stringify(result.post));
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void main();
}
/* v8 ignore stop */
