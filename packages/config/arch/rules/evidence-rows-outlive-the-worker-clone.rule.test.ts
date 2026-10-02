import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './evidence-rows-outlive-the-worker-clone.rule.js';

const REGISTRY_MODULE = 'packages/db/src/evidence.ts';

const REGISTRY_SOURCE = [
  'export const SERVICE_NAMES = {',
  "  LINEAR: 'linear',",
  "  R2_STORAGE: 'r2-storage',",
  '} as const;',
  "export const TABLE = 'service_evidence';",
].join('\n');

const SUITE = 'apps/api/src/slices/roadmap/adapters/linear-real.integration.test.ts';

function projectOf(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

function projectWith(files: Record<string, string>): Project {
  return projectOf({ [REGISTRY_MODULE]: REGISTRY_SOURCE, ...files });
}

describe('evidence-rows-outlive-the-worker-clone', () => {
  it('flags a registry-named evidence write from a handle the worker clone owns', () => {
    const project = projectWith({
      [SUITE]: [
        'let db;',
        'beforeAll(() => {',
        "  db = createDb(process.env['DATABASE_URL'], { neonDev: LOCAL_NEON_DEV_CONFIG });",
        '});',
        "it('records evidence', async () => {",
        '  await recordServiceEvidence(db, isCI, SERVICE_NAMES.LINEAR);',
        '});',
      ].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: SUITE, line: 6 });
    expect(violations[0]?.message).toContain('`db`');
    expect(violations[0]?.message).toContain(SUITE);
    expect(violations[0]?.message).toContain('evidenceDatabaseUrl');
  });

  it('passes the same write once the handle is assigned from the durable accessor', () => {
    const project = projectWith({
      [SUITE]: [
        'let db;',
        'beforeAll(() => {',
        '  db = createDb(evidenceDatabaseUrl(process.env), { neonDev: LOCAL_NEON_DEV_CONFIG });',
        '});',
        "it('records evidence', async () => {",
        '  await recordServiceEvidence(db, isCI, SERVICE_NAMES.LINEAR);',
        '});',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('passes a handle declared from the durable accessor at module scope', () => {
    const project = projectWith({
      [SUITE]: [
        'const evidenceDb = createDb(evidenceDatabaseUrl(process.env), {});',
        'await recordServiceEvidence(evidenceDb, isCI, SERVICE_NAMES.R2_STORAGE);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('passes a handle the durable accessor supplies inline', () => {
    const project = projectWith({
      [SUITE]: [
        'await recordServiceEvidence(createDb(evidenceDatabaseUrl(process.env)), isCI, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a write whose service name is assembled at run time, which no requirement can name', () => {
    const project = projectWith({
      'packages/db/src/evidence.integration.test.ts': [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, `${testRunId}-linear` as ServiceName);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a run-assembled service name bound to a local constant first', () => {
    const project = projectWith({
      'packages/db/src/evidence.integration.test.ts': [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'const testService = `${testRunId}-linear` as ServiceName;',
        'await recordServiceEvidence(db, true, testService);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a service name that reaches the call from outside the file', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'export async function record(service) {',
        '  await recordServiceEvidence(db, true, service);',
        '}',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a string that names no declared service', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        "await recordServiceEvidence(db, true, 'not-a-declared-service');",
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a property read off something other than the registry', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, otherNames.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('flags a declared service name written as a plain string', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        "await recordServiceEvidence(db, true, 'r2-storage');",
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a registry member the call reaches through a local constant', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'const service = SERVICE_NAMES.LINEAR;',
        'await recordServiceEvidence(db, true, service);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a registry member bound in a block after an unresolvable binding of the same name', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        "it('runs first', async () => {",
        '  const service = whateverTheHelperExports;',
        '  await useIt(service);',
        '});',
        "it('records evidence', async () => {",
        '  const service = SERVICE_NAMES.LINEAR;',
        '  await recordServiceEvidence(db, true, service);',
        '});',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a run-assembled name bound in a block after a registry-member binding of the same name', () => {
    const project = projectWith({
      'packages/db/src/evidence.integration.test.ts': [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        "it('names a declared service', async () => {",
        '  const testService = SERVICE_NAMES.LINEAR;',
        '  await useIt(testService);',
        '});',
        "it('records a run-private service', async () => {",
        '  const testService = `${testRunId}-linear` as ServiceName;',
        '  await recordServiceEvidence(db, true, testService);',
        '});',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('flags a declared name read off an aliased import of the registry', () => {
    const project = projectWith({
      [SUITE]: [
        "import { SERVICE_NAMES as NAMES } from '@hushbox/db';",
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a declared name read off the registry by element access', () => {
    const project = projectWith({
      [SUITE]: [
        "import { SERVICE_NAMES } from '@hushbox/db';",
        "const db = createDb(process.env['DATABASE_URL'], {});",
        "await recordServiceEvidence(db, true, SERVICE_NAMES['LINEAR']);",
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a declared name destructured off the registry', () => {
    const project = projectWith({
      [SUITE]: [
        'const { LINEAR } = SERVICE_NAMES;',
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a declared name destructured off the registry under a new binding name', () => {
    const project = projectWith({
      [SUITE]: [
        "import { SERVICE_NAMES as NAMES } from '@hushbox/db';",
        'const { LINEAR: service } = NAMES;',
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, service);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a write from a handle reassigned to the worker clone after the accessor built it', () => {
    const project = projectWith({
      [SUITE]: [
        'let db = createDb(evidenceDatabaseUrl(process.env), { neonDev: LOCAL_NEON_DEV_CONFIG });',
        "db = createDb(process.env['DATABASE_URL'], { neonDev: LOCAL_NEON_DEV_CONFIG });",
        'await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('`db`');
  });

  it('passes a write from a handle the accessor rebuilt after a clone-targeted assignment', () => {
    const project = projectWith({
      [SUITE]: [
        "let db = createDb(process.env['DATABASE_URL'], {});",
        'db = createDb(evidenceDatabaseUrl(process.env), {});',
        'await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('passes over a declared name handed on through a second local name', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'const first = SERVICE_NAMES.LINEAR;',
        'const service = first;',
        'await recordServiceEvidence(db, true, service);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('passes over a declared name bound below the write that uses it', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'export async function record() {',
        '  await recordServiceEvidence(db, true, service);',
        '}',
        'const service = SERVICE_NAMES.LINEAR;',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('refuses a handle bound below the write that uses it', () => {
    const project = projectWith({
      [SUITE]: [
        'export async function record() {',
        '  await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
        '}',
        'const db = createDb(evidenceDatabaseUrl(process.env), {});',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes over a declared name that reaches the call from another module', () => {
    const project = projectWith({
      'apps/api/src/slices/roadmap/adapters/evidence-name.ts':
        'export const EVIDENCE_SERVICE = SERVICE_NAMES.LINEAR;',
      [SUITE]: [
        "import { EVIDENCE_SERVICE } from './evidence-name.js';",
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, EVIDENCE_SERVICE);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('flags a handle reached through a property of something the accessor never built', () => {
    const project = projectWith({
      [SUITE]: ['await recordServiceEvidence(deps.db, true, SERVICE_NAMES.LINEAR);'].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('`deps.db`');
  });

  it('reports every offending call in one file', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
        'await recordServiceEvidence(db, true, SERVICE_NAMES.R2_STORAGE);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('ignores a production adapter writing from the handle its caller passed', () => {
    const project = projectWith({
      'apps/api/src/slices/media/adapters/storage-r2.ts': [
        'export function createR2Storage(config) {',
        '  return { put: async () => recordServiceEvidence(config.db, config.isCI, SERVICE_NAMES.R2_STORAGE) };',
        '}',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a read of the evidence table that writes no row', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await verifyServiceEvidence(db, [SERVICE_NAMES.LINEAR]);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('refuses a handle it cannot name, rather than passing what it cannot trace', () => {
    const project = projectWith({
      [SUITE]: ['await recordServiceEvidence(makeDb(), true, SERVICE_NAMES.LINEAR);'].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('`makeDb()`');
  });

  it('refuses a handle destructured out of an accessor-built expression', () => {
    const project = projectWith({
      [SUITE]: [
        'let db;',
        '[db] = makeHandles(evidenceDatabaseUrl(process.env));',
        'await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a write the file reaches through a qualified name', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await evidence.recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an element access on something other than the registry', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        "await recordServiceEvidence(db, true, otherNames['LINEAR']);",
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('ignores a service name bound to another name it cannot resolve', () => {
    const project = projectWith({
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'const service = whateverTheHelperExports;',
        'await recordServiceEvidence(db, true, service);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('refuses a handle whose accessor call sits one name further back', () => {
    const project = projectWith({
      [SUITE]: [
        'const url = evidenceDatabaseUrl(process.env);',
        'const db = createDb(url, { neonDev: LOCAL_NEON_DEV_CONFIG });',
        'await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads only the registry members that resolve to a name', () => {
    const project = projectOf({
      [REGISTRY_MODULE]: [
        'export const SERVICE_NAMES = {',
        '  ...INHERITED,',
        '  COMPUTED: buildName(),',
        "  LINEAR: 'linear',",
        '} as const;',
      ].join('\n'),
      [SUITE]: [
        "const db = createDb(process.env['DATABASE_URL'], {});",
        'await recordServiceEvidence(db, true, SERVICE_NAMES.COMPUTED);',
        'await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('fails loudly when the registry declaration no longer initializes anything', () => {
    const project = projectOf({
      [REGISTRY_MODULE]: 'export let SERVICE_NAMES;',
      [SUITE]: ['await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);'].join('\n'),
    });

    expect(() => rule.check(project)).toThrow(/SERVICE_NAMES/);
  });

  it('fails loudly when the registry is built somewhere this cannot read', () => {
    const project = projectOf({
      [REGISTRY_MODULE]: 'export const SERVICE_NAMES = buildServiceNames();',
      [SUITE]: ['await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);'].join('\n'),
    });

    expect(() => rule.check(project)).toThrow(/SERVICE_NAMES/);
  });

  it('ignores a write whose arguments are too few to say what it writes', () => {
    const project = projectWith({
      [SUITE]: ['await recordServiceEvidence(db);'].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(0);
  });

  it('fails loudly when the registry module is no longer where the rule looks', () => {
    const project = projectOf({
      [SUITE]: ['await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);'].join('\n'),
    });

    expect(() => rule.check(project)).toThrow(/names no file/);
  });

  it('fails loudly when the registry module declares no service names', () => {
    const project = projectOf({
      [REGISTRY_MODULE]: 'export const OTHER = {} as const;',
      [SUITE]: ['await recordServiceEvidence(db, true, SERVICE_NAMES.LINEAR);'].join('\n'),
    });

    expect(() => rule.check(project)).toThrow(/SERVICE_NAMES/);
  });
});
