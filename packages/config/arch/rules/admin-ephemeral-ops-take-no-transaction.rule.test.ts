import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './admin-ephemeral-ops-take-no-transaction.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const SHARED_MAP = 'packages/shared/src/admin/ops.ts';
const OPS_FILE = 'apps/api/src/slices/admin/domain/operations/thing.ts';

/** The shared contract map, with one entry per `name: effectClass` pair given. */
function sharedMap(entries: Record<string, string>): string {
  const properties = Object.entries(entries)
    .map(
      ([name, effectClass]) =>
        `  '${name}': defineAdminOpContract({\n` +
        `    name: '${name}',\n` +
        `    kind: 'mutation',\n` +
        `    effectClass: '${effectClass}',\n` +
        `  }),\n`
    )
    .join('');
  return `export const ADMIN_OP_CONTRACTS = {\n${properties}} as const;\n`;
}

/** An op body binding its contract the way every operations module does. */
function opModule(opName: string, body: string): string {
  return (
    `const thingContract = ADMIN_OP_CONTRACTS['${opName}'];\n` +
    `export const thing = defineAdminOp<Deps, (typeof thingContract)['input'], PostDeps>(\n` +
    `  thingContract,\n` +
    `  {\n` +
    `    execute: async (ctx, input) => {\n` +
    body +
    `    },\n` +
    `  }\n` +
    `);\n`
  );
}

describe('admin-ephemeral-ops-take-no-transaction', () => {
  it('flags an ephemeral op whose body reads the settlement transaction handle', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule('thing.do', '      await writeWithinTx(ctx.tx, input.id);\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/thing\.do/);
    expect(violations[0]?.message).toMatch(/settlement transaction/);
  });

  it('flags an ephemeral op that hands its whole context to a call', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule('thing.do', '      await enqueueWithinTx(ctx, input.id);\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/hands its context/);
  });

  it('flags an ephemeral op that aliases its context into a local binding', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule(
        'thing.do',
        '      const alias = ctx;\n      await writeWithinTx(alias.tx, input.id);\n'
      ),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an ephemeral op whose context parameter is destructured', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.do'];\n` +
        `export const thing = defineAdminOp(thingContract, {\n` +
        `  execute: async ({ deps }, input) => deps.send(input.id),\n` +
        `});\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/destructur/);
  });

  it('accepts an ephemeral op that only reads deps and registers a post-commit effect', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule(
        'thing.do',
        '      const to = ctx.deps.actorEmail();\n' +
          "      ctx.registerEphemeral({ name: 'thing.do.email', run: (post) => post.send(to) });\n"
      ),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over a durable op that takes the settlement transaction handle', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'durable' }),
      [OPS_FILE]: opModule('thing.do', '      await writeWithinTx(ctx.tx, input.id);\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over a system-owned op that takes the settlement transaction handle', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'system-owned' }),
      [OPS_FILE]: opModule('thing.do', '      await writeWithinTx(ctx.tx, input.id);\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a contract defined in the op module itself', () => {
    const project = projectWith({
      'apps/api/src/slices/admin/domain/fixture-ops.ts':
        `export const pingContract = defineAdminOpContract({\n` +
        `  name: 'fixture.ping',\n` +
        `  kind: 'mutation',\n` +
        `  effectClass: 'ephemeral',\n` +
        `});\n` +
        `const ping = defineAdminOp(pingContract, {\n` +
        `  execute: async (ctx, input) => writeWithinTx(ctx.tx, input.id),\n` +
        `});\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/fixture\.ping/);
  });

  it('reports an ephemeral contract the scanned tree binds to no body', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/no op body/);
  });

  it('accepts a read bound through the read registration, which takes no context handle', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.look': 'ephemeral' }),
      [OPS_FILE]:
        "const lookContract = ADMIN_OP_CONTRACTS['thing.look'];\n" +
        'export const look = defineAdminReadOp<Deps, (typeof lookContract)["input"], Out>(\n' +
        '  lookContract,\n' +
        '  { read: (ctx, input) => ctx.deps.reads.rows(input) }\n' +
        ');\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over test files', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule('thing.do', '      return ok({ effects: [] });\n'),
      'apps/api/src/slices/admin/routes.test.ts': opModule(
        'thing.do',
        '      await writeWithinTx(ctx.tx, input.id);\n'
      ),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads an execute written as a method rather than a property', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.do'];\n` +
        `const thing = defineAdminOp(thingContract, {\n` +
        `  async execute(ctx, input) {\n` +
        `    return writeWithinTx(ctx.tx, input.id);\n` +
        `  },\n` +
        `});\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads an execute written as a function expression', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.do'];\n` +
        `const thing = defineAdminOp(thingContract, {\n` +
        `  execute: async function (ctx, input) {\n` +
        `    return writeWithinTx(ctx.tx, input.id);\n` +
        `  },\n` +
        `});\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an ephemeral op that hands its context to a constructor', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule('thing.do', '      const writer = new Writer(ctx);\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/hands its context/);
  });

  it('accepts an execute that declares no context parameter at all', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.do'];\n` +
        `const thing = defineAdminOp(thingContract, {\n` +
        `  execute: async () => ok({ effects: [] }),\n` +
        `});\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a contract map written without an as-const assertion', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }).replace(' as const;', ';'),
      [OPS_FILE]: opModule('thing.do', '      await writeWithinTx(ctx.tx, input.id);\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('throws when the shared module declares no contract map', () => {
    const project = projectWith({ [SHARED_MAP]: `export const OTHER = {};\n` });

    expect(() => rule.check(project)).toThrow(/declares no ADMIN_OP_CONTRACTS/);
  });

  it('throws when the contract map is not an object literal', () => {
    const project = projectWith({
      [SHARED_MAP]: `export const ADMIN_OP_CONTRACTS = buildContracts();\n`,
    });

    expect(() => rule.check(project)).toThrow(/not an object literal/);
  });

  it('throws on a contract map entry that is a spread', () => {
    const project = projectWith({
      [SHARED_MAP]: `export const ADMIN_OP_CONTRACTS = {\n  ...moreContracts,\n} as const;\n`,
    });

    expect(() => rule.check(project)).toThrow(/not a plain property/);
  });

  it('throws on a contract map entry that is not a defineAdminOpContract call', () => {
    const project = projectWith({
      [SHARED_MAP]: `export const ADMIN_OP_CONTRACTS = {\n  'thing.do': someContract,\n} as const;\n`,
    });

    expect(() => rule.check(project)).toThrow(/not a defineAdminOpContract call/);
  });

  it('throws on a contract call whose argument is not a literal', () => {
    const project = projectWith({
      [SHARED_MAP]:
        `export const ADMIN_OP_CONTRACTS = {\n` +
        `  'thing.do': defineAdminOpContract(thingSpec),\n` +
        `} as const;\n`,
    });

    expect(() => rule.check(project)).toThrow(/cannot read the contract literal/);
  });

  it('throws on a contract map read through a computed key', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS[OP_NAME];\n` +
        `const thing = defineAdminOp(thingContract, {\n` +
        `  execute: async (ctx) => ok(ctx),\n` +
        `});\n`,
    });

    expect(() => rule.check(project)).toThrow(/cannot resolve the ADMIN_OP_CONTRACTS key/);
  });

  it('throws on a contract map read naming an op the map does not declare', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.gone'];\n` +
        `const thing = defineAdminOp(thingContract, {\n` +
        `  execute: async (ctx) => ok(ctx),\n` +
        `});\n`,
    });

    expect(() => rule.check(project)).toThrow(/declares no op 'thing.gone'/);
  });

  it('throws on an execute property that is not a function', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.do'];\n` +
        `const thing = defineAdminOp(thingContract, { execute: sharedExecute });\n`,
    });

    expect(() => rule.check(project)).toThrow(/cannot read the execute/);
  });

  it('reads a contract map entry held under a bare identifier key', () => {
    const project = projectWith({
      [SHARED_MAP]:
        `export const ADMIN_OP_CONTRACTS = {\n` +
        `  thingDo: defineAdminOpContract({\n` +
        `    name: 'thing.do',\n` +
        `    kind: 'mutation',\n` +
        `    effectClass: 'ephemeral',\n` +
        `  }),\n` +
        `} as const;\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/thing\.do.*no op body/);
  });

  it('passes over a same-named property read off something other than the context', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule('thing.do', '      return ok({ ctx: input.ctx });\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a context passed out under a shorthand property', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]: opModule('thing.do', '      return ok({ ctx });\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('throws on a contract argument it cannot resolve to an effect class', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `export const thing = defineAdminOp(contractFromSomewhereElse, {\n` +
        `  execute: async (ctx, input) => ok(input),\n` +
        `});\n`,
    });

    expect(() => rule.check(project)).toThrow(/cannot resolve/);
  });

  it('throws on an op registration whose execute it cannot read', () => {
    const project = projectWith({
      [SHARED_MAP]: sharedMap({ 'thing.do': 'ephemeral' }),
      [OPS_FILE]:
        `const thingContract = ADMIN_OP_CONTRACTS['thing.do'];\n` +
        `export const thing = defineAdminOp(thingContract, executeBodyFromElsewhere);\n`,
    });

    expect(() => rule.check(project)).toThrow(/cannot read/);
  });

  it('throws on a shared-map entry whose effect class is not a literal', () => {
    const project = projectWith({
      [SHARED_MAP]:
        `export const ADMIN_OP_CONTRACTS = {\n` +
        `  'thing.do': defineAdminOpContract({\n` +
        `    name: 'thing.do',\n` +
        `    kind: 'mutation',\n` +
        `    effectClass: EFFECT_CLASS,\n` +
        `  }),\n` +
        `} as const;\n`,
    });

    expect(() => rule.check(project)).toThrow(/effectClass/);
  });
});
