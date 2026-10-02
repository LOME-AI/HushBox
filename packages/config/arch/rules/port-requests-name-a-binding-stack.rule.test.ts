import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, {
  BAND_PROOF_MODULE,
  PORT_PLAN_MODULE,
} from './port-requests-name-a-binding-stack.rule.js';

/** The rule reads the declaration off a real repo-relative path, so fixtures write one. */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [relative, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), source);
  }
  return project;
}

/**
 * A port plan carrying one binding stack and one that binds nothing, plus both
 * allocators — the shape the rule reads its forbidden set and its own liveness
 * from.
 */
const PLAN_SOURCE =
  "export const STACK_MODES = ['development', 'quiet'] as const;\n" +
  'export type StackMode = (typeof STACK_MODES)[number];\n' +
  'export const STACK_MODE_DECLARATIONS = {\n' +
  '  development: { bindsHostPorts: true },\n' +
  '  quiet: { bindsHostPorts: false },\n' +
  '};\n' +
  'export function portFor(service: string, request: unknown): number {\n' +
  '  return 1;\n' +
  '}\n' +
  'export function portsFor(request: unknown): number {\n' +
  '  return 1;\n' +
  '}\n';

const IMPORT_LINE = "import { portFor, portsFor } from '../stack/port-plan.js';\n";

function projectWithPlan(files: Record<string, string>): Project {
  return projectWith({ [PORT_PLAN_MODULE]: PLAN_SOURCE, [BAND_PROOF_MODULE]: '', ...files });
}

describe('port-requests-name-a-binding-stack', () => {
  it('flags a single-service request naming a stack that binds nothing', () => {
    const project = projectWithPlan({
      'scripts/lib/stack/holder.ts':
        IMPORT_LINE + "const port = portFor('vite', { slot: 3, mode: 'quiet' });\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2 });
    expect(violations[0]?.file).toContain('scripts/lib/stack/holder.ts');
    expect(violations[0]?.message).toContain('quiet');
  });

  it('flags a whole-stack request naming a stack that binds nothing', () => {
    const project = projectWithPlan({
      'scripts/holder.ts': IMPORT_LINE + "const ports = portsFor({ slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a request hoisted into a const the call is handed', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "const STACK = { slot: 0, mode: 'quiet' } as const;\n" +
        "const port = portFor('api', STACK);\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 3 });
  });

  it('flags a mode written as a const the request names in shorthand', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "const mode = 'quiet';\n" +
        "const port = portFor('api', { slot: 0, mode });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the allocator taken under a local alias', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "import { portFor as allocate } from '../stack/port-plan.js';\n" +
        "const port = allocate('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not flag a request naming a stack that binds its allocation', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE + "const port = portFor('api', { slot: 0, mode: 'development' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a mode the call site derives rather than writes', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "import { STACK_MODES } from '../stack/port-plan.js';\n" +
        "const ports = STACK_MODES.map((mode) => portFor('api', { slot: 0, mode }));\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a mode-shaped property outside a port request', () => {
    const project = projectWithPlan({
      'scripts/holder.ts': "const env = { command: 'serve', mode: 'quiet' } as const;\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a same-named function that comes from somewhere else', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "import { portFor } from './other-plan.js';\n" +
        "const port = portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag the module that declares the plan', () => {
    const project = projectWithPlan({
      [PORT_PLAN_MODULE]:
        PLAN_SOURCE + "const band = portFor('vite', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag the suite that proves the bands are disjoint', () => {
    const project = projectWithPlan({
      [BAND_PROOF_MODULE]:
        IMPORT_LINE + "const band = portFor('vite', { slot: 3, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag an ambiguous name two declarations in one file could supply', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "function first() { const mode = 'quiet'; return mode; }\n" +
        "function second() { const mode = 'development'; return portFor('api', { slot: 0, mode }); }\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('refuses to run when the plan names no file', () => {
    const project = projectWith({ 'scripts/holder.ts': IMPORT_LINE });

    expect(() => rule.check(project)).toThrow(PORT_PLAN_MODULE);
  });

  it('refuses to run when the declaration no longer reads as stack declarations', () => {
    const project = projectWith({
      [PORT_PLAN_MODULE]: PLAN_SOURCE.replace('STACK_MODE_DECLARATIONS', 'STACK_MODE_FACTS'),
      [BAND_PROOF_MODULE]: '',
    });

    expect(() => rule.check(project)).toThrow(/STACK_MODE_DECLARATIONS/);
  });

  it('flags a mode written as a named const the request points at', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "const stack = 'quiet' as const;\n" +
        "portFor('api', { slot: 0, mode: stack });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not flag a mode the request computes in place', () => {
    const project = projectWithPlan({
      'scripts/holder.ts': IMPORT_LINE + "portFor('api', { slot: 0, mode: chooseStack() });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag an ambiguous request name two declarations could supply', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "function first() { const request = { slot: 0, mode: 'quiet' }; return request; }\n" +
        "function second() { const request = { slot: 0, mode: 'development' }; return portsFor(request); }\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('refuses to run when the declaration carries no flag to read', () => {
    const project = projectWith({
      [PORT_PLAN_MODULE]: PLAN_SOURCE.replaceAll(/\{ bindsHostPorts: (?:true|false) \}/g, '{}'),
      [BAND_PROOF_MODULE]: '',
    });

    expect(() => rule.check(project)).toThrow(/bindsHostPorts/);
  });

  it('reads a stack whose declaration key is quoted', () => {
    const project = projectWith({
      [PORT_PLAN_MODULE]: PLAN_SOURCE.replace('  quiet:', "  'quiet':").replace(
        'STACK_MODE_DECLARATIONS = {',
        'STACK_MODE_DECLARATIONS = {\n  ...INHERITED,'
      ),
      [BAND_PROOF_MODULE]: '',
      'scripts/holder.ts': IMPORT_LINE + "portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not flag a file that takes the plan for its types alone', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "import type { portFor } from '../stack/port-plan.js';\n" +
        "import { portsFor as portFor } from './other-plan.js';\n" +
        "portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag an allocator name taken off the plan as a type', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "import { type portFor, portsFor } from '../stack/port-plan.js';\n" +
        'portsFor(buildRequest());\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a request whose mode arrives by spread alone', () => {
    const project = projectWithPlan({
      'scripts/holder.ts': IMPORT_LINE + 'portsFor({ ...BASE, slot: 0 });\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a name the call hands over that stands for no object', () => {
    const project = projectWithPlan({
      'scripts/holder.ts': IMPORT_LINE + 'const request = buildRequest();\nportsFor(request);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('refuses to run when the plan no longer exports an allocator it guards', () => {
    const project = projectWith({
      [PORT_PLAN_MODULE]: PLAN_SOURCE.replace('export function portsFor', 'function portsFor'),
      [BAND_PROOF_MODULE]: '',
    });

    expect(() => rule.check(project)).toThrow(/portsFor/);
  });

  it('flags the allocator reached through the plan taken as a whole module', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "import * as plan from '../stack/port-plan.js';\n" +
        "plan.portFor('vite', { slot: 1, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the allocator reached through a plan the file imports dynamically', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "const plan = await import('../stack/port-plan.js');\n" +
        "plan.portsFor({ slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an allocator destructured off a plan the file imports dynamically', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "const { portFor } = (await import('../stack/port-plan.js')) as typeof Plan;\n" +
        "portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an allocator renamed as it is destructured off the plan', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "const { portsFor: allocate, STACK_MODES } = await import('../stack/port-plan.js');\n" +
        "allocate({ slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a mode a satisfies clause narrows where it is written', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        IMPORT_LINE +
        "const stack = 'quiet' satisfies StackMode;\n" +
        "portFor('api', { slot: 0, mode: stack });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a mode written out between backticks', () => {
    const project = projectWithPlan({
      'scripts/holder.ts': IMPORT_LINE + "portFor('api', { slot: 0, mode: `quiet` });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a dynamic import whose specifier is written out between backticks', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        'const { portFor } = await import(`../stack/port-plan.js`);\n' +
        "portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not flag an allocator name reached through another module taken whole', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "import * as other from './other-plan.js';\n" +
        "other.portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag an allocator-shaped name destructured off another module', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "const { portFor } = await import('./other-plan.js');\n" +
        "portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a dynamic import whose specifier is not written out', () => {
    const project = projectWithPlan({
      'scripts/holder.ts':
        "const { portFor } = await import(new URL('port-plan.ts', import.meta.url).href);\n" +
        "portFor('api', { slot: 0, mode: 'quiet' });\n",
    });

    expect(rule.check(project)).toEqual([]);
  });
});
