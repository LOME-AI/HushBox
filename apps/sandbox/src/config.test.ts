import { describe, it, expect } from 'vitest';
import { buildSandboxConfigScript, SANDBOX_CONFIG_GLOBAL } from './config.js';

/** The sandbox origin in the test modes, which the policy names and serves the stub from. */
const STUB_ORIGIN = 'http://localhost:7400';

describe('buildSandboxConfigScript', () => {
  it('assigns the resolved config to the agreed global', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'https://esm.sh' });
    expect(script.startsWith(`globalThis[${JSON.stringify(SANDBOX_CONFIG_GLOBAL)}] = `)).toBe(true);
  });

  it('carries the esm CDN base URL through', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'https://esm.sh' });
    const json = script.slice(script.indexOf('= ') + 2, script.lastIndexOf(';'));
    expect(JSON.parse(json)).toEqual({ esmCdnUrl: 'https://esm.sh' });
  });

  it('preserves a stub CDN URL pointing back at the sandbox origin', () => {
    const script = buildSandboxConfigScript({
      ESM_CDN_URL: `${STUB_ORIGIN}/esm-stub`,
      SANDBOX_ORIGIN_URL: STUB_ORIGIN,
    });
    const json = script.slice(script.indexOf('= ') + 2, script.lastIndexOf(';'));
    expect(JSON.parse(json)).toEqual({ esmCdnUrl: `${STUB_ORIGIN}/esm-stub` });
  });

  it('JSON-encodes the value so a hostile URL cannot break out of the script', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'https://esm.sh/x</script>y' });
    expect(script).not.toContain('</script>');
  });

  it('fails fast when ESM_CDN_URL is absent (no silent fallback)', () => {
    expect(() => buildSandboxConfigScript({})).toThrow(/ESM_CDN_URL/);
  });

  it('fails fast when ESM_CDN_URL is an empty string', () => {
    expect(() => buildSandboxConfigScript({ ESM_CDN_URL: '' })).toThrow(/ESM_CDN_URL/);
  });

  it('fails fast when ESM_CDN_URL is not an absolute URL', () => {
    expect(() => buildSandboxConfigScript({ ESM_CDN_URL: 'esm.sh' })).toThrow(/absolute URL/);
  });
});

describe('buildSandboxConfigScript CSP cross-check', () => {
  /**
   * Repointing the CDN without widening the policy used to surface only as every
   * document import failing at run time with `import_failed`, naming nothing
   * that led back to the configuration. The CSP is a static string, so the
   * mismatch is knowable the moment the config is built.
   */
  it('refuses a CDN origin the sandbox CSP script-src does not permit', () => {
    expect(() =>
      buildSandboxConfigScript({ ESM_CDN_URL: 'https://cdn.example.test/modules' })
    ).toThrow(/https:\/\/cdn\.example\.test/);
  });

  it('names the permitted script-src sources in the refusal', () => {
    expect(() =>
      buildSandboxConfigScript({ ESM_CDN_URL: 'https://cdn.example.test/modules' })
    ).toThrow(/https:\/\/esm\.sh/);
  });

  it('refuses an off-policy CDN when the declared sandbox origin cannot vouch for it', () => {
    expect(() =>
      buildSandboxConfigScript({
        ESM_CDN_URL: 'https://cdn.example.test/modules',
        SANDBOX_ORIGIN_URL: 'not-an-origin',
      })
    ).toThrow(/cdn\.example\.test/);
  });

  it('refuses a same-host CDN on a different port than the sandbox origin', () => {
    // The policy names one exact origin: a stub on another port is as
    // unreachable as a third-party host, and this is the shape a stale port
    // rewrite would take.
    expect(() =>
      buildSandboxConfigScript({
        ESM_CDN_URL: 'http://localhost:7999/esm-stub',
        SANDBOX_ORIGIN_URL: STUB_ORIGIN,
      })
    ).toThrow(/localhost:7999/);
  });
});
