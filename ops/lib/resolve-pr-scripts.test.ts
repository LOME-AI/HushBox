import { describe, it, expect } from 'vitest';
import { resolveDispatchScriptFile } from './resolve-dispatch-script.js';
import { resolveLabels, type ResolveOutput } from './resolve-pr-scripts.js';
import type { OpsManifest, OpsScript } from './generate-labels.js';

const PRE_DEPLOY_SCRIPT: OpsScript = {
  name: 'configure-r2-cors',
  file: 'ops/r2/configure-cors.ts',
  phase: 'pre-deploy',
  description: 'Apply CORS rules.',
  requires_secrets: ['R2_S3_ENDPOINT'],
};

const POST_DEPLOY_SCRIPT: OpsScript = {
  name: 'rotate-keys',
  file: 'ops/keys/rotate.ts',
  phase: 'post-deploy',
  description: 'Rotate epoch keys.',
  requires_secrets: ['ROTATION_KEY'],
};

const DISPATCH_ONLY_SCRIPT: OpsScript = {
  name: 'reseal-identity-server-keys',
  file: 'ops/identity/reseal-server-keys.ts',
  phase: 'pre-deploy',
  description: 'Re-seal every users row.',
  requires_secrets: [],
  dispatch_only: true,
};

const MANIFEST: OpsManifest = {
  scripts: [PRE_DEPLOY_SCRIPT, POST_DEPLOY_SCRIPT],
};

const MANIFEST_WITH_DISPATCH_ONLY: OpsManifest = {
  scripts: [PRE_DEPLOY_SCRIPT, DISPATCH_ONLY_SCRIPT],
};

describe('resolveLabels', () => {
  it('returns empty pre/post arrays when no run-script labels are applied', () => {
    const result = resolveLabels({
      labels: ['enhancement', 'docs'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set', ROTATION_KEY: 'set' },
      trigger: 'pull-request',
    });

    expect(result).toEqual<ResolveOutput>({ ok: true, pre: [], post: [] });
  });

  it('partitions matched labels into pre and post by manifest phase', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors', 'run-script:rotate-keys'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set', ROTATION_KEY: 'set' },
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toEqual([{ name: PRE_DEPLOY_SCRIPT.name, file: PRE_DEPLOY_SCRIPT.file }]);
    expect(result.post).toEqual([{ name: POST_DEPLOY_SCRIPT.name, file: POST_DEPLOY_SCRIPT.file }]);
  });

  it('projects only {name, file} into outputs (no description, no requires_secrets)', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set' },
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.pre[0] ?? {})).toEqual(['name', 'file']);
  });

  it('hard-fails when a run-script label is not in the manifest', () => {
    const result = resolveLabels({
      labels: ['run-script:nonexistent'],
      manifest: MANIFEST,
      env: {},
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('run-script:nonexistent');
    expect(result.error).toContain('ops/manifest.yml');
  });

  it('hard-fails when a script declares a secret that is missing from env', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST,
      env: {}, // R2_S3_ENDPOINT missing
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('R2_S3_ENDPOINT');
    expect(result.error).toContain('configure-r2-cors');
  });

  it('treats empty-string env values as missing (not just undefined)', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: '' },
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('R2_S3_ENDPOINT');
  });

  it('ignores non-run-script labels in the input', () => {
    const result = resolveLabels({
      labels: ['bug', 'run-script:configure-r2-cors', 'priority:high'],
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set' },
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toHaveLength(1);
    expect(result.post).toHaveLength(0);
  });

  it('preserves manifest order, not label-application order, in the output', () => {
    const reversedManifest: OpsManifest = {
      scripts: [POST_DEPLOY_SCRIPT, PRE_DEPLOY_SCRIPT],
    };

    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors', 'run-script:rotate-keys'],
      manifest: reversedManifest,
      env: { R2_S3_ENDPOINT: 'set', ROTATION_KEY: 'set' },
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre[0]?.name).toBe('configure-r2-cors');
    expect(result.post[0]?.name).toBe('rotate-keys');
  });

  it('handles a manifest with no scripts cleanly', () => {
    const result = resolveLabels({
      labels: [],
      manifest: { scripts: [] },
      env: {},
      trigger: 'pull-request',
    });

    expect(result).toEqual<ResolveOutput>({ ok: true, pre: [], post: [] });
  });
});

describe('resolveLabels under the pull-request trigger', () => {
  it('refuses a label naming a dispatch-only script', () => {
    const result = resolveLabels({
      labels: [`run-script:${DISPATCH_ONLY_SCRIPT.name}`],
      manifest: MANIFEST_WITH_DISPATCH_ONLY,
      env: {},
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(false);
  });

  it('names the refused script and the manual workflow in the refusal', () => {
    const result = resolveLabels({
      labels: [`run-script:${DISPATCH_ONLY_SCRIPT.name}`],
      manifest: MANIFEST_WITH_DISPATCH_ONLY,
      env: {},
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(DISPATCH_ONLY_SCRIPT.name);
    expect(result.error).toContain('.github/workflows/run-ops-script.yml');
  });

  it('resolves a label naming a script that is not dispatch-only', () => {
    const result = resolveLabels({
      labels: ['run-script:configure-r2-cors'],
      manifest: MANIFEST_WITH_DISPATCH_ONLY,
      env: { R2_S3_ENDPOINT: 'set' },
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toEqual([{ name: PRE_DEPLOY_SCRIPT.name, file: PRE_DEPLOY_SCRIPT.file }]);
  });

  it('leaves an unknown label refused by the same message as before', () => {
    const result = resolveLabels({
      labels: ['run-script:nonexistent'],
      manifest: MANIFEST_WITH_DISPATCH_ONLY,
      env: {},
      trigger: 'pull-request',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('run-script:nonexistent');
  });
});

describe('resolveLabels under the manual-dispatch trigger', () => {
  it('admits a dispatch-only script the pull-request trigger refuses', () => {
    const result = resolveLabels({
      labels: [`run-script:${DISPATCH_ONLY_SCRIPT.name}`],
      manifest: MANIFEST_WITH_DISPATCH_ONLY,
      env: {},
      trigger: 'manual-dispatch',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toEqual([
      { name: DISPATCH_ONLY_SCRIPT.name, file: DISPATCH_ONLY_SCRIPT.file },
    ]);
  });
});

// Killing the label must not kill the manual path: both read the same
// manifest, so a dispatch-only entry the PR resolver refuses is exactly the
// entry the dispatch resolver must still resolve.
describe('the manual dispatch path over a dispatch-only entry', () => {
  it('resolves the script the pull-request resolver refuses', () => {
    const result = resolveDispatchScriptFile({
      scriptName: DISPATCH_ONLY_SCRIPT.name,
      manifest: MANIFEST_WITH_DISPATCH_ONLY,
      env: {},
    });

    expect(result).toEqual({ ok: true, file: DISPATCH_ONLY_SCRIPT.file });
  });
});
