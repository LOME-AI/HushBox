#!/usr/bin/env tsx
/**
 * Resolve a single `workflow_dispatch`-selected ops script name to its file
 * path, applying the *same* manifest + secret validation as the PR-label flow.
 *
 * The manual runner (`.github/workflows/run-ops-script.yml`) passes the chosen
 * script name via `OPS_SCRIPT`; this writes the resolved `file` to
 * `$GITHUB_OUTPUT` for the run step. Validation is delegated to
 * {@link resolveLabels} so the dispatch path and the label path reject unknown
 * names / missing secrets identically.
 *
 * Inputs (env): `OPS_SCRIPT` (selected name), `GITHUB_OUTPUT` (Actions output
 * file). Hard-fails (exit 1) on an unknown name or a missing required secret.
 */
import { appendFileSync } from 'node:fs';
import { loadManifest, type OpsManifest } from './generate-labels.js';
import { resolveLabels, LABEL_PREFIX } from './resolve-pr-scripts.js';

export type ResolveDispatchOutput = { ok: true; file: string } | { ok: false; error: string };

export interface ResolveDispatchInput {
  scriptName: string;
  manifest: OpsManifest;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Validate `scriptName` against the manifest (existence + required secrets via
 * {@link resolveLabels}) and return its file path. The empty-ref guard catches
 * a manifest entry whose phase is neither pre- nor post-deploy — `loadManifest`
 * rejects that, so it only fires on a hand-built malformed manifest, but the
 * function stays total over its inputs rather than emitting an empty path.
 */
export function resolveDispatchScriptFile(input: ResolveDispatchInput): ResolveDispatchOutput {
  const result = resolveLabels({
    labels: [`${LABEL_PREFIX}${input.scriptName}`],
    manifest: input.manifest,
    env: input.env,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const ref = result.pre[0] ?? result.post[0];
  if (ref === undefined) {
    return {
      ok: false,
      error: `Script ${input.scriptName} is in ops/manifest.yml but has no runnable phase (pre-deploy/post-deploy).`,
    };
  }
  return { ok: true, file: ref.file };
}

/* v8 ignore start -- CLI entry: real env reads, writes to $GITHUB_OUTPUT, exits process */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function main(): void {
  const scriptName = requireEnv('OPS_SCRIPT');
  const githubOutput = requireEnv('GITHUB_OUTPUT');

  const result = resolveDispatchScriptFile({
    scriptName,
    manifest: loadManifest(process.cwd()),
    env: process.env,
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(`Resolved ops script "${scriptName}" -> ${result.file}`);
  appendFileSync(githubOutput, `file=${result.file}\n`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main();
}
/* v8 ignore stop */
