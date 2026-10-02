import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, { TOOL_LOOP_HOME } from './tool-loop-has-one-home.rule.js';

/** Every fixture writes a real path under the repo root, where the rule's scope is anchored. */
function projectWith(files: Readonly<Record<string, string>>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [relative, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), source);
  }
  return project;
}

/** The home as it declares the cap, its bounds and the step relation. */
const HOME_SOURCE = `
const TOOL_CALL_CAP_FLOOR = 2;
const TOOL_CALL_CAP_CEILING = 10;
export function toolCallCapFor(effort?: string): number {
  return effort === undefined ? TOOL_CALL_CAP_CEILING : TOOL_CALL_CAP_FLOOR;
}
export const TOOL_CALL_CAP_MAX: number = toolCallCapFor();
export function toolLoopStepsFor(calls: number): number {
  return calls + 1;
}
export function carveToolLoopSteps(declared: number, effort?: string): number {
  return Math.min(declared, toolLoopStepsFor(toolCallCapFor(effort)));
}
`;

/** The node schema's own field declaration, which the first clause excepts. */
const SCHEMA_SOURCE = `
export const Node = z.object({
  maxSteps: z.number().int().min(1).default(1),
});
`;

/** The affordability barrel, which re-exports the home the way the real one does. */
const BARREL = 'packages/shared/src/affordability/index.ts';

const BARREL_SOURCE = `export {
  carveToolLoopSteps,
  TOOL_CALL_CAP_MAX,
  toolCallCapFor,
  toolLoopStepsFor,
} from './tool-loop.ts';
`;

/** An import of `names` from the barrel, spelled relative to `file` as a source file writes it. */
function importFromHome(file: string, names: string): string {
  const relative = path.posix.relative(path.posix.dirname(file), BARREL);
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  return `import { ${names} } from '${specifier}';\n`;
}

const CONSUMER = 'apps/api/src/slices/chat/domain/turn/definition.ts';

/** Every shape the repository carries today: a call into the home, and reads of another maxSteps. */
const CONSUMER_SOURCE = `${importFromHome(CONSUMER, 'TOOL_CALL_CAP_MAX, toolLoopStepsFor')}
declare const node: { maxSteps: number };
declare const options: { maxSteps?: number };
const WEB_SEARCH_TOOLING = { tools: ['webSearch'], maxSteps: toolLoopStepsFor(TOOL_CALL_CAP_MAX) };
const wired = { maxSteps: node.maxSteps };
const built = { ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }) };
function carry(maxSteps: number): { maxSteps: number } {
  return { maxSteps };
}
const { maxSteps } = node;
const destructured = { maxSteps };
const local = toolLoopStepsFor(TOOL_CALL_CAP_MAX);
`;

/** A consumer file at `file` that imports `names` from the home and then runs `body`. */
function consumer(file: string, names: string, body: string): Readonly<Record<string, string>> {
  return { [file]: `${importFromHome(file, names)}${body}` };
}

function baseline(extra: Readonly<Record<string, string>> = {}): Project {
  return projectWith({
    [TOOL_LOOP_HOME]: HOME_SOURCE,
    [BARREL]: BARREL_SOURCE,
    'packages/shared/src/workflow/workflow.ts': SCHEMA_SOURCE,
    [CONSUMER]: CONSUMER_SOURCE,
    ...extra,
  });
}

describe('tool-loop-has-one-home', () => {
  it('passes the shapes the repository carries today', () => {
    expect(rule.check(baseline())).toEqual([]);
  });

  describe('the maxSteps clause', () => {
    it('flags a literal maxSteps outside the tool-loop module', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/chat/domain/turn/other.ts': 'const x = { maxSteps: 10 };\n',
        })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toContain('apps/api/src/slices/chat/domain/turn/other.ts');
      expect(violations[0]?.message).toContain('maxSteps');
    });

    it('flags a maxSteps computed by arithmetic of its own', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/elsewhere.ts': 'const x = { maxSteps: calls + 1 };\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps read from a variable of another name', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/elsewhere.ts': 'const x = { maxSteps: steps };\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps from a call the tool-loop module does not declare', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/elsewhere.ts': 'const x = { maxSteps: stepsFor(3) };\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a shorthand maxSteps over a local literal', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'const maxSteps = 16;\nexport const x = { maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps read from a local literal of the same name', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'const maxSteps = 16;\nexport const x = { maxSteps: maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps read from a local computed by arithmetic', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'declare const calls: number;\nconst maxSteps = calls + 1;\nexport const x = { maxSteps: maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given a literal argument', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'export const x = { maxSteps: toolLoopStepsFor(15) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given an arithmetic argument', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'TOOL_CALL_CAP_MAX, toolLoopStepsFor',
            'export const x = { maxSteps: toolLoopStepsFor(TOOL_CALL_CAP_MAX + 5) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call to a local function that shadows a tool-loop function', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'TOOL_CALL_CAP_MAX',
            'function toolLoopStepsFor(calls: number): number {\n  return calls + 2;\n}\nexport const x = { maxSteps: toolLoopStepsFor(TOOL_CALL_CAP_MAX) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a string-keyed maxSteps', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/elsewhere.ts': "export const x = { 'maxSteps': 16 };\n" })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps under a computed string key', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/elsewhere.ts': "export const x = { ['maxSteps']: 16 };\n" })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps destructured from a field of another name', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'declare const node: { steps: number };\nconst { steps: maxSteps } = node;\nexport const x = { maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a destructured maxSteps whose default is a literal', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'declare const options: { maxSteps?: number };\nconst { maxSteps = 16 } = options;\nexport const x = { maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps bound to a function of that name', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'function maxSteps(): number {\n  return 3;\n}\nexport const x = { maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a shorthand maxSteps that resolves to nothing', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/elsewhere.ts': 'export const x = { maxSteps };\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a maxSteps local initialized from itself rather than recursing', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            'const maxSteps: number = maxSteps;\nexport const x = { maxSteps };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given a local literal', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'const calls = 15;\nexport const x = { maxSteps: toolLoopStepsFor(calls) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given a negative literal', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'export const x = { maxSteps: toolLoopStepsFor(-1) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('accepts a parenthesized call into the tool-loop module', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      expect(
        rule.check(
          baseline(
            consumer(
              file,
              'TOOL_CALL_CAP_MAX, toolLoopStepsFor',
              'export const x = { maxSteps: (toolLoopStepsFor(TOOL_CALL_CAP_MAX)) };\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('accepts a self-initialized argument without recursing', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      expect(
        rule.check(
          baseline(
            consumer(
              file,
              'toolLoopStepsFor',
              'const calls: number = calls;\nexport const x = { maxSteps: toolLoopStepsFor(calls) };\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('flags a maxSteps parameter whose default is a literal', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/elsewhere.ts':
            "export function tooling(maxSteps = 16): { tools: string[]; maxSteps: number } {\n  return { tools: ['webSearch'], maxSteps };\n}\n",
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given a literal asserted to a type', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'export const x = { maxSteps: toolLoopStepsFor(15 as number) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given a local held as a const literal', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'const EXTRA = 15 as const;\nexport const x = { maxSteps: toolLoopStepsFor(EXTRA) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given a literal that satisfies a type', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'export const x = { maxSteps: toolLoopStepsFor(15 satisfies number) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a call into the tool-loop module given an angle-bracket-asserted literal', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      const violations = rule.check(
        baseline(
          consumer(
            file,
            'toolLoopStepsFor',
            'export const x = { maxSteps: toolLoopStepsFor(<number>15) };\n'
          )
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('accepts a maxSteps parameter whose default is a call into the tool-loop module', () => {
      const file = 'apps/api/src/slices/workflows/steps.ts';
      expect(
        rule.check(
          baseline(
            consumer(
              file,
              'TOOL_CALL_CAP_MAX, toolLoopStepsFor',
              'export function tooling(maxSteps = toolLoopStepsFor(TOOL_CALL_CAP_MAX)): { maxSteps: number } {\n  return { maxSteps };\n}\n'
            )
          )
        )
      ).toEqual([]);
    });

    it('leaves a maxSteps in a test file alone', () => {
      expect(
        rule.check(baseline({ 'apps/api/src/x.test.ts': 'const x = { maxSteps: 3 };\n' }))
      ).toEqual([]);
    });

    it('leaves a maxSteps outside apps and packages alone', () => {
      expect(rule.check(baseline({ 'scripts/x.ts': 'const x = { maxSteps: 3 };\n' }))).toEqual([]);
    });
  });

  describe('the cap clause', () => {
    it('flags a second declaration of the tool-call cap', () => {
      const violations = rule.check(
        baseline({ 'apps/api/src/slices/models/cap.ts': 'export const TOOL_CALL_CAP_MAX = 10;\n' })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('TOOL_CALL_CAP_MAX');
    });

    it('flags a second declaration of the cap’s floor', () => {
      const violations = rule.check(
        baseline({ 'packages/shared/src/floor.ts': 'const TOOL_CALL_CAP_FLOOR = 2;\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a second function deriving the cap', () => {
      const violations = rule.check(
        baseline({
          'apps/web/src/lib/cap.ts': 'export function toolCallCapFor(): number { return 10; }\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap spelled the other way round', () => {
      const violations = rule.check(
        baseline({ 'apps/api/src/lib/limits.ts': 'export const MAX_TOOL_CALLS = 10;\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('leaves an anonymous function alone', () => {
      expect(
        rule.check(
          baseline({ 'apps/api/src/lib/anon.ts': 'export default function () { return 10; }\n' })
        )
      ).toEqual([]);
    });

    it('flags a cap initialized by a call outside the tool-loop module', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/models/cap.ts': 'export const TOOL_CALL_CAP_MAX = Number(12);\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap initialized by arithmetic dressed as a call', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/models/cap.ts':
            'export const TOOL_CALL_CAP_MAX = Math.min(12, 20);\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap read from somewhere other than the tool-loop module', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/models/cap.ts':
            'declare const config: { limit: number };\nexport const maxToolCalls = config.limit;\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap held in an object property', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/models/cap.ts': 'export const limits = { toolCallCap: 10 };\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap held in a class static', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/models/cap.ts':
            'export class Limits {\n  static readonly MAX_TOOL_CALLS = 10;\n}\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap held in a private class field', () => {
      const violations = rule.check(
        baseline({
          'apps/api/src/slices/models/cap.ts': 'export class Limits {\n  #toolCallCap = 10;\n}\n',
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a cap declared with no value', () => {
      const violations = rule.check(
        baseline({ 'apps/api/src/slices/models/cap.ts': 'export let toolCallCap: number;\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('leaves a cap read through a namespace import of the home alone', () => {
      const file = 'apps/api/src/slices/workflows/x.ts';
      const relative = path.posix.relative(path.posix.dirname(file), BARREL);
      expect(
        rule.check(
          baseline({
            [file]: `import * as loop from '${relative}';\nexport const maxToolCalls = loop.TOOL_CALL_CAP_MAX;\n`,
          })
        )
      ).toEqual([]);
    });

    it('leaves a local that reads the cap through the home alone', () => {
      const file = 'apps/api/src/slices/workflows/x.ts';
      expect(
        rule.check(
          baseline(
            consumer(
              file,
              'TOOL_CALL_CAP_MAX, toolCallCapFor',
              'declare const effort: string;\nexport const toolCallCap = toolCallCapFor(effort);\nexport const maxToolCalls = TOOL_CALL_CAP_MAX;\n'
            )
          )
        )
      ).toEqual([]);
    });
  });

  describe('the retired-name clause', () => {
    it('flags the retired search cap in code', () => {
      const violations = rule.check(
        baseline({
          'packages/shared/src/affordability/constants.ts':
            'export const MAX_SEARCH_TOOL_CALLS = 10;\n',
        })
      );
      expect(
        violations.some((violation) => violation.message.includes('MAX_SEARCH_TOOL_CALLS'))
      ).toBe(true);
    });

    it('flags the retired search cap in a comment of a test file', () => {
      const violations = rule.check(
        baseline({ 'apps/api/src/x.test.ts': '// capped at MAX_SEARCH_TOOL_CALLS\n' })
      );
      expect(violations).toHaveLength(1);
    });

    it('leaves the rule’s own file and its test alone', () => {
      expect(
        rule.check(
          baseline({
            'packages/config/arch/rules/tool-loop-has-one-home.rule.ts':
              "const RETIRED = 'MAX_SEARCH_TOOL_CALLS';\n",
            'packages/config/arch/rules/tool-loop-has-one-home.rule.test.ts':
              "const RETIRED = 'MAX_SEARCH_TOOL_CALLS';\n",
          })
        )
      ).toEqual([]);
    });
  });

  it('refuses to run when the tool-loop module is not in the scanned tree', () => {
    const project = projectWith({ 'apps/api/src/x.ts': 'const x = 1;\n' });
    expect(() => rule.check(project)).toThrow(/tool-loop-has-one-home/);
  });
});
