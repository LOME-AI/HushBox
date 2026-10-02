import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './dev-driver-config-runs-only-in-development.rule.js';

/**
 * The rule's scope is anchored at {@link REPO_ROOT} — `scripts` and
 * `apps/sandbox/scripts` are both real directories, and a relative reading of
 * the tooling tree would hand the rule a second one — so every fixture writes a
 * real path under the repository root.
 */
function projectOf(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [relative, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), source);
  }
  return project;
}

/**
 * A guarded call in a production tree, present in every fixture that expects the
 * rule to report: the rule refuses to stand over a corpus holding no development
 * configuration at all.
 */
const GUARDED_MODULE = 'apps/api/src/lib/context/factories.ts';

const GUARDED_SOURCE =
  'export function createRequestDb(url: string, envUtilities: { isDev: boolean }): Database {\n' +
  '  return envUtilities.isDev\n' +
  '    ? createDb(url, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
  '    : createDb(url);\n' +
  '}\n';

function projectWith(files: Record<string, string>): Project {
  return projectOf({ [GUARDED_MODULE]: GUARDED_SOURCE, ...files });
}

/** The dispatcher's own shape, the branch this rule exists to hold. */
const DISPATCHER_MODULE = 'apps/api/src/lib/jobs/dispatcher-bindings.ts';

function dispatcher(body: string): Record<string, string> {
  return {
    [DISPATCHER_MODULE]:
      'export function openDispatcherDb(\n' +
      '  databaseUrl: string,\n' +
      '  envUtilities: { readonly isDev: boolean }\n' +
      '): Database {\n' +
      body +
      '}\n',
  };
}

describe('dev-driver-config-runs-only-in-development', () => {
  it('accepts the dispatcher branch as written', () => {
    const project = projectWith(
      dispatcher(
        '  return envUtilities.isDev\n' +
          '    ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
          '    : createDb(databaseUrl);\n'
      )
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags the dispatcher branch with its guard deleted', () => {
    const project = projectWith(
      dispatcher('  return createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });\n')
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain(DISPATCHER_MODULE);
    expect(violations[0]?.message).toContain('createDb');
  });

  it('flags the dispatcher branch inverted', () => {
    const project = projectWith(
      dispatcher(
        '  return envUtilities.isDev\n' +
          '    ? createDb(databaseUrl)\n' +
          '    : createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });\n'
      )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain(DISPATCHER_MODULE);
  });

  it('accepts the development configuration in the else arm of a production branch', () => {
    const project = projectWith({
      'ops/identity/reseal-server-keys.ts':
        'const isProduction = createEnvUtilities(process.env).isProduction;\n' +
        'const db = isProduction\n' +
        '  ? createDb(databaseUrl)\n' +
        '  : createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a negated production branch', () => {
    const project = projectWith({
      'packages/db/src/verify-schema-drift.ts':
        'const db = !createEnvUtilities(process.env).isProduction\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an if statement whose then branch holds the development configuration', () => {
    const project = projectWith({
      'apps/api/src/slices/admin/adapters/sql-panel.ts':
        'export function open(options: { isDev: boolean; url: string }): Database {\n' +
        '  if (options.isDev) {\n' +
        '    return createDb(options.url, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  }\n' +
        '  return createDb(options.url);\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the development configuration in the else branch of a production if statement', () => {
    const project = projectWith({
      'apps/api/src/slices/admin/adapters/sql-panel.ts':
        'export function open(options: { isProduction: boolean; url: string }): Database {\n' +
        '  if (options.isProduction) {\n' +
        '    return createDb(options.url);\n' +
        '  } else {\n' +
        '    return createDb(options.url, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  }\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a call that follows a refusal of a non-local connection string', () => {
    const project = projectWith({
      'packages/db/src/migration-rehearsal.ts':
        'export async function withRehearsalDatabase(connectionString: string): Promise<void> {\n' +
        '  if (!isLocalHostUrl(connectionString)) {\n' +
        '    throw new Error(REMOTE_REFUSAL_MESSAGE);\n' +
        '  }\n' +
        '  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  await db.$client.end();\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a call whose preceding refusal is inverted', () => {
    const project = projectWith({
      'packages/db/src/migration-rehearsal.ts':
        'export async function withRehearsalDatabase(connectionString: string): Promise<void> {\n' +
        '  if (isLocalHostUrl(connectionString)) {\n' +
        '    throw new Error(REMOTE_REFUSAL_MESSAGE);\n' +
        '  }\n' +
        '  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  await db.$client.end();\n' +
        '}\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a guard that refuses a non-local host without throwing', () => {
    const project = projectWith({
      'packages/db/src/migration-rehearsal.ts':
        'export async function withRehearsalDatabase(connectionString: string): Promise<void> {\n' +
        '  if (!isLocalHostUrl(connectionString)) {\n' +
        '    logged = true;\n' +
        '  }\n' +
        '  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  await db.$client.end();\n' +
        '}\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a branch on a flag that is not a development-versus-production axis', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const { isCI } = createEnvUtilities(env);\n' +
        'const db = isCI\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a parenthesised development branch', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const db = (envUtilities.isDev)\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a negation of a flag that is not a development-versus-production axis', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const { isCI } = createEnvUtilities(env);\n' +
        'const db = !isCI\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a prefix operator that is not a negation', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const db = ~LOCAL_HOSTS.indexOf(host)\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a branch on a call that is not the locality predicate', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const db = isReady(databaseUrl)\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a refusal that throws without a block', () => {
    const project = projectWith({
      'packages/db/src/migration-rehearsal.ts':
        'export async function withRehearsalDatabase(connectionString: string): Promise<void> {\n' +
        '  if (!isLocalHostUrl(connectionString)) throw new Error(REMOTE_REFUSAL_MESSAGE);\n' +
        '  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  await db.$client.end();\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads the locality predicate reached through a namespace', () => {
    const project = projectWith({
      'packages/db/src/migration-rehearsal.ts':
        'export async function withRehearsalDatabase(connectionString: string): Promise<void> {\n' +
        '  if (!urls.isLocalHostUrl(connectionString)) {\n' +
        '    throw new Error(REMOTE_REFUSAL_MESSAGE);\n' +
        '  }\n' +
        '  const db = createDb(connectionString, { neonDev: LOCAL_NEON_DEV_CONFIG });\n' +
        '  await db.$client.end();\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads the shared constant passed as the whole options argument', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts': 'const db = createDb(databaseUrl, LOCAL_NEON_DEV_CONFIG);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a call whose only guard is a conjunction', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const { isDev, ready } = createEnvUtilities(env);\n' +
        'const db = isDev && ready\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a call whose only guard is a disjunction', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const { isDev, isLocalDev } = createEnvUtilities(env);\n' +
        'const db = isDev || isLocalDev\n' +
        '  ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  : createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not read a branch whose condition holds the call as a guard for it', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const reachable = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })\n' +
        '  ? yes\n' +
        '  : no;\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads the development configuration written as an inline object', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        "const db = createDb(databaseUrl, { neonDev: { wsProxy, pipelineConnect: 'password' } });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not flag a call that carries no development configuration', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts': 'const db = createDb(databaseUrl);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a method of the same name on an injected runtime', () => {
    const project = projectWith({
      'apps/api/src/scheduled.ts':
        'const db = runtime.createDb(env, { neonDev: LOCAL_NEON_DEV_CONFIG });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a test file', () => {
    const project = projectWith({
      'apps/api/src/lib/jobs/dispatcher-bindings.integration.test.ts':
        'const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag the tooling workspace', () => {
    const project = projectWith({
      'scripts/seed.ts': 'const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a module under a test-support directory', () => {
    const project = projectWith({
      'apps/api/src/test-support/caller-invariance.ts':
        'const db = createDb(proof.databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a module under a workers-validation directory', () => {
    const project = projectWith({
      'packages/db/src/workers-validation/test-worker.ts':
        'const db = createDb(this.env.DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when no production call carries the development configuration', () => {
    const project = projectOf({
      'apps/api/src/lib/context/factories.ts': 'const db = openDb(url, LOCAL_PROXY);\n',
    });

    expect(() => rule.check(project)).toThrow(/stands over nothing/);
  });
});
