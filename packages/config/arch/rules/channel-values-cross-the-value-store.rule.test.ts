import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './channel-values-cross-the-value-store.rule.js';

const INTERPRETER = 'apps/api/src/slices/workflows/domain/engine/interpreter.ts';
const SCOPE_MODULE = 'apps/api/src/slices/workflows/domain/engine/run-steps.ts';

/**
 * The module that declares the run scope type and holds the seam's one write
 * and one read. Every fixture carries it, because the rule's decay guards
 * require the file that declares the type to exist and to still name a
 * channel map.
 */
const SCOPE_SEAM = `
export interface Scope {
  readonly channels: Map<string, unknown>;
  readonly virtual: ReadonlyMap<string, unknown>;
  readonly parent?: Scope;
}

export function storeInChannel(store, scope, nodeId, value) {
  const stored = store.store(value);
  if (stored.isErr()) return false;
  scope.channels.set(nodeId, stored.value);
  return true;
}

export function readChannel(store, scope, nodeId) {
  return store.resolve(scope.channels.get(nodeId));
}
`;

/**
 * A clean interpreter: one metered write, one resolved read, one empty scope
 * literal. It names the scope type, which is what puts it in the rule's scope.
 */
const CLEAN_SEAM = `
import type { Scope } from './run-steps.js';

class RunExecution {
  private readonly store = createValueStore(1);
  private readonly rootScope: Scope = { channels: new Map(), virtual: new Map() };
  private storeInChannel(scope, nodeId, value) {
    const stored = this.store.store(value);
    if (stored.isErr()) return false;
    scope.channels.set(nodeId, stored.value);
    return true;
  }
  private readChannel(scope, nodeId) {
    return this.store.resolve(scope.channels.get(nodeId));
  }
}
`;

function projectWithFiles(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/** The seam's two modules, clean — the fixture every case but the decay guards starts from. */
const SEAM_FILES: Record<string, string> = {
  [SCOPE_MODULE]: SCOPE_SEAM,
  [INTERPRETER]: CLEAN_SEAM,
};

/** The clean seam plus one extra scanned file carrying the shape under test. */
function projectWithBesideSeam(filePath: string, source: string): Project {
  return projectWithFiles({ ...SEAM_FILES, [filePath]: source });
}

/** A method body spliced into the clean interpreter's class. */
function projectWithMethod(body: string): Project {
  return projectWithFiles({
    ...SEAM_FILES,
    [INTERPRETER]: CLEAN_SEAM.replace('class RunExecution {', `class RunExecution {\n${body}\n`),
  });
}

describe('channel-values-cross-the-value-store', () => {
  it('passes an interpreter whose only channel writes and reads cross the store', () => {
    expect(rule.check(projectWithFiles(SEAM_FILES))).toEqual([]);
  });

  it('flags a raw channel write in the module that declares the scope type', () => {
    const project = projectWithFiles({
      ...SEAM_FILES,
      [SCOPE_MODULE]: `${SCOPE_SEAM}
export function carryState(scope, nodeId, state) {
  scope.channels.set(nodeId, state);
}
`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: SCOPE_MODULE });
  });

  it('flags a raw channel write in a file outside the engine that names the scope type', () => {
    const project = projectWithBesideSeam(
      'apps/api/src/slices/workflows/domain/nodes/loop-execution.ts',
      `import type { Scope } from '../engine/run-steps.js';

export function carryState(scope: Scope, nodeId: string, state: unknown): void {
  scope.channels.set(nodeId, state);
}
`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('store()');
  });

  it('flags a channel write of a value the store never admitted', () => {
    const project = projectWithMethod(`
      runBranch(node, scope, resolved) {
        scope.channels.set(node.id, resolved[0]);
      }
    `);

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: INTERPRETER });
    expect(violations[0]?.message).toContain('store()');
  });

  it('flags a channel write whose value came from a binding no store() call produced', () => {
    const project = projectWithMethod(`
      runLoop(node, scope, state) {
        const carried = { value: state };
        scope.channels.set(node.id, carried.value);
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a channel read that skips resolve()', () => {
    const project = projectWithMethod(`
      sinkOutputs(nodeId) {
        return contentValueOf(this.rootScope.channels.get(nodeId));
      }
    `);

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('resolve()');
  });

  it('flags a scope literal seeding a virtual port with a raw value', () => {
    const project = projectWithMethod(`
      runFanBranch(node, scope, element) {
        const branchScope = {
          channels: new Map(),
          virtual: new Map([[virtualKey(node.id, PORT), element]]),
          parent: scope,
        };
        return branchScope;
      }
    `);

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('store()');
  });

  it('passes a scope literal seeding a virtual port with an admitted value', () => {
    const project = projectWithMethod(`
      runFanBranch(node, scope, element) {
        const seeded = this.store.store(element);
        if (seeded.isErr()) return undefined;
        return {
          channels: new Map(),
          virtual: new Map([[virtualKey(node.id, PORT), seeded.value]]),
          parent: scope,
        };
      }
    `);

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a scope map bound to something other than a fresh Map', () => {
    const project = projectWithMethod(`
      childScope(scope, carried) {
        return { channels: new Map(), virtual: carried, parent: scope };
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a scope map handed in by shorthand', () => {
    const project = projectWithMethod(`
      childScope(scope, virtual) {
        return { channels: new Map(), virtual, parent: scope };
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a channel write carrying a property other than the store() result', () => {
    const project = projectWithMethod(`
      write(node, scope, value) {
        const stored = this.store.store(value);
        scope.channels.set(node.id, stored.original);
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a channel write whose admitted value is reached through a field', () => {
    const project = projectWithMethod(`
      write(node, scope, value) {
        this.held = this.store.store(value);
        scope.channels.set(node.id, this.held.value);
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a channel read bound to a local instead of handed to resolve()', () => {
    const project = projectWithMethod(`
      read(scope, nodeId) {
        const value = scope.channels.get(nodeId);
        return value;
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a scope map named without a call on it at all', () => {
    const project = projectWithMethod(`
      size(scope) {
        return scope.channels.size;
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a virtual map seeded from entries assembled elsewhere', () => {
    const project = projectWithMethod(`
      childScope(scope, entries) {
        return { channels: new Map(), virtual: new Map(entries), parent: scope };
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a virtual map seeded with an entry that is not a key/value pair', () => {
    const project = projectWithMethod(`
      childScope(scope, entry) {
        return { channels: new Map(), virtual: new Map([entry]), parent: scope };
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a virtual map seeded with a pair carrying no value', () => {
    const project = projectWithMethod(`
      childScope(scope, node) {
        return { channels: new Map(), virtual: new Map([[virtualKey(node.id, PORT)]]), parent: scope };
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes a membership test, which answers a boolean and fetches no value', () => {
    const project = projectWithMethod(`
      hasProducer(scope, nodeId) {
        return scope.channels.has(nodeId);
      }
    `);

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a channel map that escapes the seam by reference', () => {
    const project = projectWithMethod(`
      leak(scope) {
        return snapshot(scope.channels);
      }
    `);

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('escapes');
  });

  it('flags a channel map read through a member other than get/set/has', () => {
    const project = projectWithMethod(`
      allValues(scope) {
        return [...scope.channels.values()];
      }
    `);

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a raw channel write in a file that takes the declaring module in whole', () => {
    const project = projectWithBesideSeam(
      'apps/api/src/slices/workflows/domain/nodes/fan-out-execution.ts',
      `import * as runSteps from '../engine/run-steps.js';

export function seed(scope: runSteps.Scope, nodeId: string, element: unknown): void {
  scope.channels.set(nodeId, element);
}
`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a raw channel write in a file that imports the scope type under another name', () => {
    const project = projectWithBesideSeam(
      'apps/api/src/slices/workflows/domain/nodes/sub-workflow-execution.ts',
      `import type { Scope as RunScope } from '../engine/run-steps.js';

export function carryState(scope: RunScope, nodeId: string, state: unknown): void {
  scope.channels.set(nodeId, state);
}
`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('leaves a file alone whose import of the scope type resolves to nothing', () => {
    const project = projectWithBesideSeam(
      'apps/api/src/slices/workflows/domain/nodes/transform-execution.ts',
      `import type { Scope } from '@/slices/workflows/domain/engine/run-steps.js';

export function carryState(scope: Scope, nodeId: string, state: unknown): void {
  scope.channels.set(nodeId, state);
}
`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves a test file alone though it names the scope type', () => {
    const project = projectWithBesideSeam(
      'apps/api/src/slices/workflows/domain/engine/interpreter.test.ts',
      `import type { Scope } from './run-steps.js';

const scope: Scope = { channels: new Map([["a", 1]]), virtual: new Map() };
scope.channels.set("b", 2);
`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves a file that names no scope type alone', () => {
    const project = projectWithBesideSeam(
      'packages/realtime/src/room-core.ts',
      'const scope = { channels: new Map([["a", 1]]) };\nscope.channels.set("b", 2);\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves a file alone that imports a scope type some other module declares', () => {
    const project = projectWithFiles({
      ...SEAM_FILES,
      'apps/api/src/slices/workflows/domain/nodes/node-scope.ts':
        'export interface Scope {\n  readonly channels: Map<string, unknown>;\n}\n',
      'apps/api/src/slices/workflows/domain/nodes/classifier-context.ts': `import type { Scope } from './node-scope.js';

export function carryState(scope: Scope, nodeId: string, state: unknown): void {
  scope.channels.set(nodeId, state);
}
`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves a file alone that imports something other than the scope type from that module', () => {
    const project = projectWithBesideSeam(
      'apps/api/src/slices/workflows/domain/nodes/turn-decision.ts',
      `import { storeInChannel } from '../engine/run-steps.js';

export function carryState(scope, nodeId, state) {
  storeInChannel(scope, nodeId, state);
  scope.channels.set(nodeId, state);
}
`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when the module declaring the scope type is no longer in the scanned tree', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/workflows/domain/engine/hooks.ts': '',
    });

    expect(() => rule.check(project)).toThrow(/names no file/);
  });

  it('throws when that module no longer exports the scope type', () => {
    const project = projectWithFiles({
      [SCOPE_MODULE]:
        'export function readChannel(store, scope, nodeId) {\n  return store.resolve(scope.channels.get(nodeId));\n}\n',
    });

    expect(() => rule.check(project)).toThrow(/declares no/);
  });

  it('throws when that module only re-exports a scope type declared elsewhere', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/workflows/domain/engine/scope.ts':
        'export interface Scope {\n  readonly channels: Map<string, unknown>;\n}\n',
      [SCOPE_MODULE]: `export type { Scope } from './scope.js';

export function readChannel(store, scope, nodeId) {
  return store.resolve(scope.channels.get(nodeId));
}
`,
    });

    expect(() => rule.check(project)).toThrow(/declares no/);
  });

  it('throws when a value in that module takes the scope type name', () => {
    const project = projectWithFiles({
      [SCOPE_MODULE]: `export const Scope = 1;

export function readChannel(store, scope, nodeId) {
  return store.resolve(scope.channels.get(nodeId));
}
`,
    });

    expect(() => rule.check(project)).toThrow(/declares no/);
  });

  it('throws when that module no longer touches a channel map', () => {
    const project = projectWithFiles({
      [SCOPE_MODULE]: 'export interface Scope {\n  readonly parent?: Scope;\n}\n',
    });

    expect(() => rule.check(project)).toThrow(/renamed/);
  });
});
