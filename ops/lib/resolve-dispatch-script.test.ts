import { describe, it, expect } from 'vitest';
import { resolveDispatchScriptFile } from './resolve-dispatch-script.js';
import type { OpsManifest, OpsScript } from './generate-labels.js';

const PRE: OpsScript = {
  name: 'configure-r2-cors',
  file: 'ops/r2/configure-cors.ts',
  phase: 'pre-deploy',
  description: 'Apply CORS rules.',
  requires_secrets: ['R2_S3_ENDPOINT'],
};

const POST: OpsScript = {
  name: 'rotate-keys',
  file: 'ops/keys/rotate.ts',
  phase: 'post-deploy',
  description: 'Rotate epoch keys.',
  requires_secrets: ['ROTATION_KEY'],
};

const MANIFEST: OpsManifest = { scripts: [PRE, POST] };

describe('resolveDispatchScriptFile', () => {
  it('resolves a pre-deploy script name to its file when its secret is present', () => {
    const result = resolveDispatchScriptFile({
      scriptName: 'configure-r2-cors',
      manifest: MANIFEST,
      env: { R2_S3_ENDPOINT: 'set' },
    });

    expect(result).toEqual({ ok: true, file: 'ops/r2/configure-cors.ts' });
  });

  it('resolves a post-deploy script name to its file', () => {
    const result = resolveDispatchScriptFile({
      scriptName: 'rotate-keys',
      manifest: MANIFEST,
      env: { ROTATION_KEY: 'set' },
    });

    expect(result).toEqual({ ok: true, file: 'ops/keys/rotate.ts' });
  });

  it('hard-fails when the script name is not in the manifest', () => {
    const result = resolveDispatchScriptFile({
      scriptName: 'nonexistent',
      manifest: MANIFEST,
      env: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('nonexistent');
    expect(result.error).toContain('ops/manifest.yml');
  });

  it('hard-fails when a required secret is missing from env', () => {
    const result = resolveDispatchScriptFile({
      scriptName: 'configure-r2-cors',
      manifest: MANIFEST,
      env: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('R2_S3_ENDPOINT');
  });

  it('hard-fails on a manifest entry whose phase is neither pre- nor post-deploy', () => {
    const malformed: OpsManifest = {
      scripts: [{ ...PRE, phase: 'mid-deploy' as OpsScript['phase'], requires_secrets: [] }],
    };

    const result = resolveDispatchScriptFile({
      scriptName: 'configure-r2-cors',
      manifest: malformed,
      env: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('configure-r2-cors');
  });
});
