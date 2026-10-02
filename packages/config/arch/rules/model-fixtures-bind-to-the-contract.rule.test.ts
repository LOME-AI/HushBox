import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './model-fixtures-bind-to-the-contract.rule.js';

const CONTRACT = '/packages/shared/src/schemas/api/models.ts';

/** A stand-in for the wire contract carrying the members the rule reads off it. */
const CONTRACT_SOURCE = `export type Model = {
  id: string;
  name: string;
  provider: string;
  modality: 'text' | 'image' | 'audio' | 'video';
  contextLength: number;
  description: string;
  supportedParameters: string[];
  pricing: { inputPerToken?: string; perImage?: string };
  maxOutputTokens?: number;
  created?: number;
  isSmartModel?: boolean;
  reasoning?: { mandatory?: boolean };
  popularityRank?: number;
};
`;

/** A catalog row spelled out in full, as a fixture in a checked position would be. */
const ROW = `{
  id: 'vendor/model',
  name: 'Model',
  provider: 'Vendor',
  modality: 'text',
  contextLength: 1,
  description: '',
  supportedParameters: [],
  pricing: { inputPerToken: '1' },
}`;

/**
 * A project shaped like the web package's own program: the `@/` alias resolves,
 * which is what lets the rule read contextual types off it directly.
 */
function projectWith(files: Record<string, string>, contract = CONTRACT_SOURCE): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, paths: { '@/*': ['/apps/web/src/*'] } },
  });
  if (contract.length > 0) project.createSourceFile(CONTRACT, contract);
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const IMPORT_MODEL = `import type { Model } from '${CONTRACT.replace('.ts', '.js')}';\n`;

describe('model-fixtures-bind-to-the-contract', () => {
  it('flags a model-shaped fixture whose position has no contextual type', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `const stub = () => ({ models: [${ROW}] });\n`,
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1 });
    expect(violations[0]?.file).toContain('apps/web/src/thing.test.ts');
    expect(violations[0]?.message).toContain('wire contract');
  });

  it('passes a fixture whose position is the contract itself', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `${IMPORT_MODEL}const stub = (): { models: Model[] } => ({ models: [${ROW}] });\n`,
      })
    );

    expect(violations).toEqual([]);
  });

  it('passes a fixture whose position derives from the contract', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `${IMPORT_MODEL}function make(overrides: Partial<Model>): void { void overrides; }\nmake({ id: 'a', modality: 'text' });\n`,
      })
    );

    expect(violations).toEqual([]);
  });

  it('passes a fixture reached through the web alias', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/hooks/models/models.ts': `${IMPORT_MODEL}export interface ModelsData { models: Model[] }\n`,
        '/apps/web/src/thing.test.ts':
          "import type { ModelsData } from '@/hooks/models/models';\n" +
          `const stub = (): { data: ModelsData } => ({ data: { models: [${ROW}] } });\n`,
      })
    );

    expect(violations).toEqual([]);
  });

  it('passes a model-shaped object handed to an assertion matcher', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts':
          'declare const expect: (actual: unknown) => { toMatchObject: (expected: unknown) => void };\n' +
          "expect(1).toMatchObject({ id: 'a', provider: 'Vendor', contextLength: 1 });\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('passes a literal carrying no property only the catalog declares', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': "const row = { id: 'a', label: 'b' };\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('passes a literal whose only contract property is one other domain types carry', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts':
          "const message = { id: 'm', isSmartModel: true, reasoning: {} };\n",
      })
    );

    expect(violations).toEqual([]);
  });

  it('flags a fixture whose position is typed as unknown', () => {
    const violations = rule.check(
      projectWith({ '/apps/web/src/thing.test.ts': `const row: unknown = ${ROW};\n` })
    );

    expect(violations).toHaveLength(1);
  });

  it('flags a fixture whose position is typed as any', () => {
    const violations = rule.check(
      projectWith({ '/apps/web/src/thing.test.ts': `const row: any = ${ROW};\n` })
    );

    expect(violations).toHaveLength(1);
  });

  it('flags a fixture whose position is typed as never', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `declare function take(row: never): void;\ntake(${ROW});\n`,
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('passes a fixture whose position is the contract or nothing', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `${IMPORT_MODEL}const row: Model | undefined = ${ROW};\n`,
      })
    );

    expect(violations).toEqual([]);
  });

  it('flags a fixture whose position is an index signature over unknown', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `const row: Record<string, unknown> = ${ROW};\n`,
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('flags a fixture whose position is typed as object', () => {
    const violations = rule.check(
      projectWith({ '/apps/web/src/thing.test.ts': `const row: object = ${ROW};\n` })
    );

    expect(violations).toHaveLength(1);
  });

  it('flags a fixture whose position is the empty object type', () => {
    const violations = rule.check(
      projectWith({ '/apps/web/src/thing.test.ts': `const row: {} = ${ROW};\n` })
    );

    expect(violations).toHaveLength(1);
  });

  it('reads the property names of a fixture that also spreads another row', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts': `const base = { name: 'Model' };\nconst row = { ...base, id: 'a', provider: 'Vendor' };\n`,
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2 });
  });

  it("judges a model-shaped literal that is a call's own callee rather than its argument", () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.test.ts':
          "const label = ({ id: 'a', provider: 'Vendor' }).toString();\nvoid label;\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('leaves production web files and other workspaces alone', () => {
    const violations = rule.check(
      projectWith({
        '/apps/web/src/thing.ts': `const stub = () => ({ models: [${ROW}] });\n`,
        '/apps/api/src/thing.test.ts': `const stub = () => ({ models: [${ROW}] });\n`,
      })
    );

    expect(violations).toEqual([]);
  });

  it('throws when the contract module names no file', () => {
    expect(() =>
      rule.check(projectWith({ '/apps/web/src/thing.test.ts': 'export const a = 1;\n' }, ''))
    ).toThrow(/names no file/);
  });

  it('throws when the contract module declares no contract type', () => {
    expect(() =>
      rule.check(
        projectWith(
          { '/apps/web/src/thing.test.ts': 'export const a = 1;\n' },
          'export type NotTheContract = { id: string };\n'
        )
      )
    ).toThrow(/no longer declared/);
  });

  it('throws when a name held back as weak evidence is no longer a contract property', () => {
    expect(() =>
      rule.check(
        projectWith(
          { '/apps/web/src/thing.test.ts': 'export const a = 1;\n' },
          'export type Model = { id: string; pricing: { perImage?: string } };\n'
        )
      )
    ).toThrow(/no longer a property/);
  });
});
