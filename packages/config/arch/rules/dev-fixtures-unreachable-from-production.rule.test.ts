import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './dev-fixtures-unreachable-from-production.rule.js';

/**
 * The rule's trees are anchored at {@link REPO_ROOT} — `apps/sandbox/scripts`
 * is a real directory a relative reading of the scripts tree would hand it — so
 * fixtures are written at their real paths under the repository root.
 */
function projectWithFiles(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, filePath), source);
  }
  return project;
}

/** A repo-relative fixture path as the rule reports it. */
function reported(filePath: string): string {
  return path.join(REPO_ROOT, filePath).replace(/^\//, '');
}

const DOOR = 'apps/api/src/slices/billing/adapters/dev-fixtures.ts';
const BARREL = 'apps/api/src/slices/billing/index.ts';
const PRODUCTION = 'apps/api/src/slices/chat/routes.ts';

const DOOR_SOURCE =
  'export function seedPaymentsHistory(): void {}\nexport interface SeedSpec {\n  readonly id: string;\n}\nexport function chargeWithinTx(): void {}\n';

/** The published slice: one dev fixture and one real API on the same barrel. */
const PUBLISHING_SLICE: Record<string, string> = {
  [DOOR]: DOOR_SOURCE,
  'apps/api/src/slices/billing/adapters/stores.ts':
    'export function createBillingStores(): void {}\n',
  [BARREL]:
    "export { createBillingStores } from './adapters/stores.js';\nexport { seedPaymentsHistory } from './adapters/dev-fixtures.js';\nexport type { SeedSpec } from './adapters/dev-fixtures.js';\n",
};

describe('dev-fixtures-unreachable-from-production', () => {
  it('flags a production slice file importing a dev fixture through the owning barrel', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "import { seedPaymentsHistory } from '../billing/index.js';\n\nseedPaymentsHistory();\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: reported(PRODUCTION), line: 1 });
    expect(violations[0]?.message).toContain('seedPaymentsHistory');
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('flags a production file importing a dev-fixture module directly', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "import { seedPaymentsHistory } from '../billing/adapters/dev-fixtures.js';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a side-effect import of a dev-fixture module', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "import '../billing/adapters/dev-fixtures.js';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a fixture symbol that travelled through a chain of re-exports', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/lib/seed-surface.ts':
        "export { seedPaymentsHistory } from '../slices/billing/index.js';\n",
      [PRODUCTION]: "import { seedPaymentsHistory } from '../../lib/seed-surface.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('flags a fixture symbol republished under an alias', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/lib/seed-surface.ts':
        "export { seedPaymentsHistory as loadHistory } from '../slices/billing/index.js';\n",
      [PRODUCTION]: "import { loadHistory } from '../../lib/seed-surface.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('loadHistory');
  });

  it('flags a type-only import of a dev-fixture type', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "import type { SeedSpec } from '../billing/index.js';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a fixture republished as a default export', () => {
    const project = projectWithFiles({
      [DOOR]: DOOR_SOURCE,
      [BARREL]: "export { seedPaymentsHistory as default } from './adapters/dev-fixtures.js';\n",
      [PRODUCTION]: "import seedHistory from '../billing/index.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('default');
  });

  it('flags a namespace import of a barrel that publishes a dev fixture', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "import * as billing from '../billing/index.js';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags every import of a module that star-re-exports a dev-fixture module', () => {
    const project = projectWithFiles({
      [DOOR]: DOOR_SOURCE,
      [BARREL]: "export * from './adapters/dev-fixtures.js';\n",
      [PRODUCTION]: "import { chargeWithinTx } from '../billing/index.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('export *');
  });

  it('flags a fixture surface republished under a namespace name', () => {
    const project = projectWithFiles({
      [DOOR]: DOOR_SOURCE,
      [BARREL]: "export * as billingSeed from './adapters/dev-fixtures.js';\n",
      [PRODUCTION]: "import { billingSeed } from '../billing/index.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('billingSeed');
  });

  it('flags a fixture star-re-exported onward from a barrel that named it', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/lib/seed-surface.ts': "export * from '../slices/billing/index.js';\n",
      [PRODUCTION]: "import { seedPaymentsHistory } from '../../lib/seed-surface.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('reports one violation for a barrel that star-re-exports two fixture modules', () => {
    const project = projectWithFiles({
      [DOOR]: DOOR_SOURCE,
      'apps/api/src/slices/billing/adapters/dev-public-usage.ts':
        'export function seedPublicUsage(): void {}\n',
      [BARREL]:
        "export * from './adapters/dev-fixtures.js';\nexport * from './adapters/dev-public-usage.js';\n",
      [PRODUCTION]: "import { seedPublicUsage } from '../billing/index.js';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a production file in another workspace, not only in the api tree', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/web/src/lib/api-client.ts':
        "import { seedPaymentsHistory } from '../../../api/src/slices/billing/index.js';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('covers a newly published door with no edit to the rule', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/media/adapters/dev-transform-fixtures.ts':
        'export function mintTransformArtifact(): void {}\n',
      'apps/api/src/slices/media/index.ts':
        "export { mintTransformArtifact } from './adapters/dev-transform-fixtures.js';\n",
      [PRODUCTION]: "import { mintTransformArtifact } from '../media/index.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('mintTransformArtifact');
  });

  it('flags a fixture reached through a dynamic import of the owning barrel', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "export async function load(): Promise<void> {\n  const billing = await import('../billing/index.js');\n  billing.seedPaymentsHistory();\n}\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: reported(PRODUCTION), line: 2 });
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('flags a dynamic import of a dev-fixture module itself', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "export async function load(): Promise<void> {\n  await import('../billing/adapters/dev-fixtures.js');\n}\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('flags a fixture type named through an import-type node', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "export type Spec = import('../billing/index.js').SeedSpec;\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('SeedSpec');
  });

  it('flags an import-equals reference to a fixture-carrying barrel', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "import billing = require('../billing/index.js');\n\nexport const seed = billing.seedPaymentsHistory;\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('flags a fixture-carrying module taken whole by an import-type node', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "export type Billing = typeof import('../billing/index.js');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('flags a fixture type reached through a qualified import-type name', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "export type Id = import('../billing/index.js').SeedSpec.Id;\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('SeedSpec');
  });

  it('passes an import-type node naming only real API', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "export type Stores = ReturnType<typeof import('../billing/index.js').createBillingStores>;\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an import-equals that names an entity rather than a module', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        'export namespace Billing {\n  export const stores = 1;\n}\nimport Stores = Billing.stores;\nexport const bound = Stores;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a production dynamic import of a package outside the repository', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "export async function load(): Promise<void> {\n  await import('cockatiel');\n}\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a production dynamic import of a module publishing only real API', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/lib/stores-surface.ts':
        "export { createBillingStores } from '../slices/billing/index.js';\n",
      [PRODUCTION]:
        "export async function load(): Promise<void> {\n  await import('../../lib/stores-surface.js');\n}\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a dynamic import of a fixture from the api dev tree', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/platform/dev/seed-billing.ts':
        "export async function load(): Promise<void> {\n  await import('../../slices/billing/index.js');\n}\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes the api dev tree importing a fixture through the barrel', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/platform/dev/seed-billing.ts':
        "import { seedPaymentsHistory } from '../../slices/billing/index.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a test file importing a fixture through the barrel', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/slices/chat/routes.integration.test.ts':
        "import { seedPaymentsHistory } from '../billing/index.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes the seed toolkit consumer in the scripts workspace', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'scripts/seed.ts':
        "import { seedPaymentsHistory } from '../apps/api/src/slices/billing/index.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes one dev-fixture module importing another', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/slices/billing/adapters/dev-public-usage.ts':
        "import type { SeedSpec } from './dev-fixtures.js';\n\nexport type Spec = SeedSpec;\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes production code importing a real API from the same barrel', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "import { createBillingStores } from '../billing/index.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes the barrel that publishes the door — re-export is not consumption', () => {
    expect(rule.check(projectWithFiles(PUBLISHING_SLICE))).toEqual([]);
  });

  it('passes a namespace import of a module that republishes only real API', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/lib/stores-surface.ts':
        "export { createBillingStores } from '../slices/billing/index.js';\n",
      [PRODUCTION]: "import * as stores from '../../lib/stores-surface.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes imports and exports that name no repository module', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "import path from 'node:path';\n\nexport const separator = path.sep;\nexport { separator as sep };\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a dev-named module outside the api tree', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/web/src/hooks/dev-personas.ts': 'export const DEV_PERSONAS: string[] = [];\n',
      'apps/web/src/routes/home.tsx': "import { DEV_PERSONAS } from '../hooks/dev-personas.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when the scanned tree holds no dev-fixture module', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/billing/index.ts': 'export function createBillingStores(): void {}\n',
    });

    expect(() => rule.check(project)).toThrow(/no dev-fixture module/);
  });

  it('throws when an api-tree relative code import does not resolve', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "import { missing } from '../billing/adapters/gone.js';\n",
    });

    expect(() => rule.check(project)).toThrow(/gone\.js/);
  });

  it('throws when an api-tree dynamic import does not resolve', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        "export async function load(): Promise<void> {\n  await import('../billing/adapters/gone.js');\n}\n",
    });

    expect(() => rule.check(project)).toThrow(/gone\.js/);
  });

  it('throws when an api-tree file names a module through require', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: "export const billing = require('../billing/index.js');\n",
    });

    expect(() => rule.check(project)).toThrow(/billing\/index\.js/);
  });

  it('flags a fixture reached through a dynamic import written as a template literal', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        'export async function load(): Promise<void> {\n  const billing = await import(`../billing/index.js`);\n  billing.seedPaymentsHistory();\n}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: reported(PRODUCTION), line: 2 });
    expect(violations[0]?.message).toContain(DOOR);
  });

  it('reports rather than throws when a production api file computes a module specifier', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]:
        'export async function load(name: string): Promise<void> {\n  await import(`../billing/${name}.js`);\n}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: reported(PRODUCTION), line: 2 });
    expect(violations[0]?.message).toContain('write the specifier out');
  });

  it('reports a template specifier in a type position, which TypeScript rejects there', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      [PRODUCTION]: 'export type Billing = typeof import(`../billing/index.js`);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('write the specifier out');
  });

  it('passes a computed module specifier outside the api tree', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/web/src/lib/lazy.ts':
        'export async function load(name: string): Promise<void> {\n  await import(`../routes/${name}.js`);\n}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a computed module specifier in the api dev tree', () => {
    const project = projectWithFiles({
      ...PUBLISHING_SLICE,
      'apps/api/src/platform/dev/seed-billing.ts':
        'export async function load(name: string): Promise<void> {\n  await import(`../../slices/${name}/index.js`);\n}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });
});
