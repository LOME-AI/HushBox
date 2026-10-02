import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './declared-evidence-names-are-required.rule.js';

/**
 * The rule reads the workflow files off the project's file system rather than
 * its parsed source files — the layer's globs select no YAML — so every fixture
 * writes real paths under {@link REPO_ROOT} into an in-memory one, and the
 * registry module is created there as an ordinary source file.
 */
const REGISTRY_MODULE = 'packages/db/src/evidence.ts';
const WORKFLOWS_DIR = '.github/workflows';

/** The registry as the declaring module writes it: one string-valued member per name. */
function registrySource(names: readonly string[]): string {
  const members = names.map((name, index) => `  SEAM_${String(index)}: '${name}',`).join('\n');
  return `export const SERVICE_NAMES = {\n${members}\n} as const;\n`;
}

interface Fixture {
  readonly names: readonly string[];
  /** The registry module's whole text, where the shape rather than the names is the subject. */
  readonly registry?: string;
  readonly workflows: Readonly<Record<string, string>>;
}

function projectFor({ names, registry, workflows }: Fixture): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    path.join(REPO_ROOT, REGISTRY_MODULE),
    registry ?? registrySource(names)
  );
  const fileSystem = project.getFileSystem();
  for (const [file, text] of Object.entries(workflows)) {
    fileSystem.writeFileSync(path.join(REPO_ROOT, WORKFLOWS_DIR, file), text);
  }
  return project;
}

/** A workflow whose triggers are the ones a commit reaches, carrying the given steps. */
function commitGated(steps: readonly string[]): string {
  return [
    'name: CI',
    '',
    'on:',
    '  # What a commit reaches.',
    '  pull_request:',
    '  merge_group:',
    '  push:',
    '    branches: [main]',
    '',
    'jobs:',
    '  test:',
    '    steps:',
    ...steps,
    '',
  ].join('\n');
}

/** A workflow triggered by the given `on:` block text, carrying one verifying step. */
function triggeredBy(on: readonly string[], steps: readonly string[]): string {
  return [...on, 'jobs:', '  test:', '    steps:', ...steps, ''].join('\n');
}

/** One step running the verifier with the given argument text. */
function verifyStep(arguments_: string): string[] {
  return ['      - name: Verify the seam', `        run: pnpm verify:evidence ${arguments_}`];
}

const offendingNames = (project: Project): string =>
  rule
    .check(project)
    .map((violation) => violation.message)
    .join('\n');

describe('declared-evidence-names-are-required', () => {
  it('passes a registry whose every name a commit-reached step requires', () => {
    const project = projectFor({
      names: ['helcim', 'linear'],
      workflows: {
        'ci.yml': commitGated([
          ...verifyStep('--require=helcim'),
          ...verifyStep('--require=linear'),
        ]),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('refuses a declared name no invocation requires, naming it', () => {
    const project = projectFor({
      names: ['helcim', 'webpush'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require=helcim')) },
    });

    const violations = rule.check(project);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(REGISTRY_MODULE);
    expect(violations[0]?.message).toContain('`webpush`');
  });

  it('reads a comma-separated requirement as every name it carries', () => {
    const project = projectFor({
      names: ['helcim', 'linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require=helcim,linear')) },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a requirement whose value sits in the following argument', () => {
    const project = projectFor({
      names: ['helcim', 'linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require helcim,linear')) },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a requirement whose step sits behind a condition', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      - name: Verify the seam',
          "        if: github.event_name != 'pull_request'",
          '        run: pnpm verify:evidence --require=linear',
        ]),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a requirement written in a block-scalar command body', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      - name: Verify the seam',
          '        run: |',
          '          pnpm install',
          '',
          '          pnpm verify:evidence --require=linear',
          '      - name: Next step',
          '        uses: actions/checkout@v5',
        ]),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("reads a requirement written as a step's first key", () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated(['      - run: pnpm verify:evidence --require=linear']),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("reads a block-scalar body under a step's first key as far as that key's own column", () => {
    const project = projectFor({
      names: ['linear', 'helcim'],
      workflows: {
        'ci.yml': commitGated([
          '      - run: |',
          '          pnpm verify:evidence --require=linear',
          '        name: pnpm verify:evidence --require=helcim',
        ]),
      },
    });

    const violations = rule.check(project);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('`helcim`');
  });

  it('reads a block header writing its indentation indicator before its chomping one', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      - name: Verify the seam',
          '        run: |2-',
          '          pnpm verify:evidence --require=linear',
        ]),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a quoted argument on a line that invokes something else', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      - name: Announce',
          '        run: echo "the seam"',
          ...verifyStep('--require=linear'),
        ]),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('counts only the last requirement on one invocation, as the entry point does', () => {
    const project = projectFor({
      names: ['helcim', 'linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require=helcim --require=linear')) },
    });

    expect(offendingNames(project)).toContain('`helcim`');
  });

  it('reads no requirement out of a step name that mentions the command', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      - name: pnpm verify:evidence --require=linear',
          '        uses: actions/checkout@v5',
        ]),
      },
    });

    expect(offendingNames(project)).toContain('`linear`');
  });

  it('reads no requirement out of a commented-out command', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      # run: pnpm verify:evidence --require=linear',
          '      - name: Checkout',
          '        uses: actions/checkout@v5',
        ]),
      },
    });

    expect(offendingNames(project)).toContain('`linear`');
  });

  it('counts no requirement written in a workflow no commit event reaches', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated(verifyStep('--require=helcim')),
        'nightly.yml': triggeredBy(
          ['on:', '  schedule:', "    - cron: '0 2 * * 1'", '  workflow_dispatch: # by hand'],
          verifyStep('--require=linear')
        ),
      },
    });

    expect(offendingNames(project)).toContain('`linear`');
  });

  it('reads only the workflow files the directory holds', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated(verifyStep('--require=linear')),
        'README.md': 'The workflows, described.\n',
        'partials/step.yml': triggeredBy(['on: push'], verifyStep('--require=helcim')),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads the inline sequence spelling of the trigger block', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': triggeredBy(["on: ['push', merge_group]"], verifyStep('--require=linear')),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads the single-event spelling of the trigger block', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': triggeredBy(['on: push'], verifyStep('--require=linear')) },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a trigger block written as a sequence of event names', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': triggeredBy(
          ['on:', '  - push', '  - merge_group'],
          verifyStep('--require=linear')
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads no name off a same-named binding that is not the registry literal', () => {
    const project = projectFor({
      names: [],
      registry: [
        "const assembled = { EXTRA: 'extra' };",
        'function built(): unknown {',
        '  const SERVICE_NAMES = assembled;',
        '  return SERVICE_NAMES;',
        '}',
        'function pending(): unknown {',
        '  let SERVICE_NAMES;',
        '  SERVICE_NAMES = assembled;',
        '  return SERVICE_NAMES;',
        '}',
        'export const SERVICE_NAMES = {',
        "  LINEAR: 'linear',",
        '} as const;',
        'export { built, pending };',
        '',
      ].join('\n'),
      workflows: { 'ci.yml': commitGated(verifyStep('--require=linear')) },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports a registry member whose value is another binding, naming it', () => {
    const project = projectFor({
      names: [],
      registry: [
        "const WEBPUSH_NAME = 'webpush';",
        'export const SERVICE_NAMES = {',
        "  LINEAR: 'linear',",
        '  WEBPUSH: WEBPUSH_NAME,',
        '} as const;',
        '',
      ].join('\n'),
      workflows: { 'ci.yml': commitGated(verifyStep('--require=linear')) },
    });

    expect(() => rule.check(project)).toThrow(/WEBPUSH/);
  });

  it('reports a registry member whose value is a template literal, naming it', () => {
    const project = projectFor({
      names: [],
      registry: [
        'export const SERVICE_NAMES = {',
        "  LINEAR: 'linear',",
        '  WEBPUSH: `webpush`,',
        '} as const;',
        '',
      ].join('\n'),
      workflows: { 'ci.yml': commitGated(verifyStep('--require=linear')) },
    });

    expect(() => rule.check(project)).toThrow(/WEBPUSH/);
  });

  it('reports a registry member carrying no name of its own, naming it as written', () => {
    const project = projectFor({
      names: [],
      registry: [
        "const MORE = { WEBPUSH: 'webpush' } as const;",
        'export const SERVICE_NAMES = {',
        "  LINEAR: 'linear',",
        '  ...MORE,',
        '} as const;',
        '',
      ].join('\n'),
      workflows: { 'ci.yml': commitGated(verifyStep('--require=linear')) },
    });

    expect(() => rule.check(project)).toThrow(/\.\.\.MORE/);
  });

  it('reports a requirement flag whose value slot holds another flag', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require --verbose')) },
    });

    expect(() => rule.check(project)).toThrow(/--require/);
  });

  it('reports a requirement flag ending the invocation', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require')) },
    });

    expect(() => rule.check(project)).toThrow(/--require/);
  });

  it('reports an argument spelling it cannot read rather than passing over it', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--requires=linear')) },
    });

    expect(() => rule.check(project)).toThrow(/--requires=linear/);
  });

  it('reports an invocation carrying no requirement at all', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('')) },
    });

    expect(() => rule.check(project)).toThrow(/verify:evidence/);
  });

  it('reports an empty name inside a requirement value', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require=linear,')) },
    });

    expect(() => rule.check(project)).toThrow(/--require=linear,/);
  });

  it('reports a requirement whose value carries a shell quote', () => {
    const project = projectFor({
      names: ['helcim', 'linear'],
      workflows: { 'ci.yml': commitGated(verifyStep('--require="helcim,linear"')) },
    });

    expect(() => rule.check(project)).toThrow(/--require="helcim,linear"/);
  });

  it('reports an invocation written as a quoted scalar', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated([
          '      - name: Verify the seam',
          '        run: "pnpm verify:evidence --require=linear"',
        ]),
      },
    });

    expect(() => rule.check(project)).toThrow(/quote/);
  });

  it('reports a trigger written below the key that it cannot read', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': triggeredBy(['on:', '  ? push'], verifyStep('--require=linear')) },
    });

    expect(() => rule.check(project)).toThrow(/\? push/);
  });

  it('reports a trigger written beside the key that it cannot read', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': triggeredBy(["on: [push, 'pull request']"], verifyStep('--require=linear')),
      },
    });

    expect(() => rule.check(project)).toThrow(/pull request/);
  });

  it('reports a trigger block holding no trigger', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'ci.yml': triggeredBy(['on:'], verifyStep('--require=linear')) },
    });

    expect(() => rule.check(project)).toThrow(/no trigger/);
  });

  it('reports a workflow declaring no trigger block', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: {
        'ci.yml': commitGated(verifyStep('--require=linear')),
        'broken.yml': ['name: Broken', 'jobs:', '  test:', '    steps: []', ''].join('\n'),
      },
    });

    expect(() => rule.check(project)).toThrow(/broken\.yml/);
  });

  it('reports the workflow directory going missing rather than passing every name', () => {
    const project = projectFor({ names: ['linear'], workflows: {} });

    expect(() => rule.check(project)).toThrow(/\.github\/workflows/);
  });

  it('reports a workflow set no commit event reaches rather than passing every name', () => {
    const project = projectFor({
      names: ['linear'],
      workflows: { 'nightly.yml': triggeredBy(['on:', '  workflow_dispatch:'], []) },
    });

    expect(() => rule.check(project)).toThrow(/reached by a commit/);
  });

  it('reports the registry module going missing rather than passing every name', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project
      .getFileSystem()
      .writeFileSync(
        path.join(REPO_ROOT, WORKFLOWS_DIR, 'ci.yml'),
        commitGated(verifyStep('--require=linear'))
      );

    expect(() => rule.check(project)).toThrow(/packages\/db\/src\/evidence\.ts/);
  });

  it('reports a registry it can read no name out of', () => {
    const project = projectFor({ names: [], workflows: {} });

    expect(() => rule.check(project)).toThrow(/SERVICE_NAMES/);
  });
});
