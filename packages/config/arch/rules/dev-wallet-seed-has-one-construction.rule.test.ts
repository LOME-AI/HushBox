import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, { SEED_MODULE } from './dev-wallet-seed-has-one-construction.rule.js';

/**
 * The rule's scope is anchored at {@link REPO_ROOT} — a relative reading of the
 * E2E tree would also take a directory named `e2e` inside another workspace —
 * so every fixture writes a real path under the repo root.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [relative, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), source);
  }
  return project;
}

/** The seed module, present in every fixture that expects the rule to report. */
const SEED_MODULE_SOURCE =
  'export function post(request: APIRequestContext): Promise<APIResponse> {\n' +
  '  return request.post(`${API_BASE}/dev/wallet-balance`, { data: {} });\n' +
  '}\n';

function projectWithSeedModule(files: Record<string, string>): Project {
  return projectWith({ [SEED_MODULE]: SEED_MODULE_SOURCE, ...files });
}

describe('dev-wallet-seed-has-one-construction', () => {
  it('flags a spec that builds the seed request itself', () => {
    const project = projectWithSeedModule({
      'e2e/billing/wallet-lifecycle.spec.ts':
        'const response = await request.post(`${apiUrl}/dev/wallet-balance`, {\n' +
        "  data: { email, walletType: 'purchased', balance: '0' },\n" +
        '});\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1 });
    expect(violations[0]?.file).toContain('e2e/billing/wallet-lifecycle.spec.ts');
    expect(violations[0]?.message).toContain(SEED_MODULE);
  });

  it('flags the path written as a plain quoted string', () => {
    const project = projectWithSeedModule({
      'e2e/helpers/budget.ts': "await request.post('/dev/wallet-balance', { data: {} });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the path written in a backtick string with nothing interpolated', () => {
    const project = projectWithSeedModule({
      'e2e/fixtures.ts': 'await request.post(`/dev/wallet-balance`, { data: {} });\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the path written ahead of an interpolation', () => {
    const project = projectWithSeedModule({
      'e2e/helpers/zeroing.ts': 'await request.post(`/dev/wallet-balance?email=${email}`);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not flag a request to a different dev route', () => {
    const project = projectWithSeedModule({
      'e2e/helpers/budget.ts':
        'await request.delete(`${apiUrl}/dev/trial-usage`);\n' +
        'await request.get(`${apiUrl}/dev/conversation-cost`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a dev route whose path merely starts with this one', () => {
    const project = projectWithSeedModule({
      'e2e/helpers/budget.ts':
        'await request.get(`${apiUrl}/dev/wallet-balance-history`);\n' +
        'await request.get(`${apiUrl}/dev/wallet-balances`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("does not flag apps/api's own route tests, which are the route's contract authority", () => {
    const project = projectWithSeedModule({
      'apps/api/src/platform/dev/routes.integration.test.ts':
        "const res = await request('/dev/wallet-balance', { method: 'POST', body });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag another workspace directory that happens to be named e2e', () => {
    const project = projectWithSeedModule({
      'scripts/e2e/prepare.ts':
        "await fetch(`${apiUrl}/dev/wallet-balance`, { method: 'POST' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws rather than reporting the callers when the seed module names no file', () => {
    const project = projectWith({
      'e2e/helpers/budget.ts': "await request.post('/dev/wallet-balance', { data: {} });\n",
    });

    expect(() => rule.check(project)).toThrow(/names no file in the scanned tree/);
  });

  it('throws rather than passing green when the seed module builds a different route', () => {
    const project = projectWith({
      [SEED_MODULE]:
        'export function post(request: APIRequestContext): Promise<APIResponse> {\n' +
        '  return request.post(`${API_BASE}/dev/wallet-credit`, { data: {} });\n' +
        '}\n',
      'e2e/helpers/budget.ts': 'await postWalletCreditSeed(request, email, balance);\n',
    });

    expect(() => rule.check(project)).toThrow(/no longer builds/);
  });

  it('calls a renamed route a liveness failure rather than reporting the caller left behind', () => {
    const project = projectWith({
      [SEED_MODULE]:
        'export function post(request: APIRequestContext): Promise<APIResponse> {\n' +
        '  return request.post(`${API_BASE}/dev/wallet-credit`, { data: {} });\n' +
        '}\n',
      'e2e/helpers/budget.ts': "await request.post('/dev/wallet-balance', { data: {} });\n",
    });

    expect(() => rule.check(project)).toThrow(/LIVENESS failure/);
  });

  it('throws when the seed module only names the route in a comment', () => {
    const project = projectWith({
      [SEED_MODULE]:
        '/** Renamed from /dev/wallet-balance. */\n' +
        'export function post(request: APIRequestContext): Promise<APIResponse> {\n' +
        '  return request.post(`${API_BASE}/dev/wallet-credit`, { data: {} });\n' +
        '}\n',
    });

    expect(() => rule.check(project)).toThrow(/no longer builds/);
  });

  it('does not flag a comment that names the route', () => {
    const project = projectWithSeedModule({
      'e2e/helpers/budget.ts':
        '// The wallet is seeded through POST /dev/wallet-balance before the run.\n' +
        'const seeded = true;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });
});
