import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './scoped-set-gate-matches-the-scoped-type.rule.js';

/**
 * The rule reads one side off a parsed source file and the other off the
 * project's file system — the layer's globs select no `.mjs` and no file under
 * `packages/config` — so the fixtures write both at their real paths under
 * {@link REPO_ROOT}, one into the project and one into an in-memory disk.
 */
const TYPE_PATH = 'apps/api/src/lib/context/request-scope.ts';
const GATE_PATH = 'packages/config/eslint-extensions/rules/no-bare-scoped-set.mjs';

function projectWith({ type, gate }: { type?: string; gate?: string }): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  if (type !== undefined) project.createSourceFile(path.join(REPO_ROOT, TYPE_PATH), type);
  if (gate !== undefined) {
    project.getFileSystem().writeFileSync(path.join(REPO_ROOT, GATE_PATH), gate);
  }
  return project;
}

/** Names as source spells them, which is how both sides carry them. */
function quoted(names: readonly string[]): string[] {
  return names.map((name) => `'${name}'`);
}

/** The module declaring the ambient scope's variables, as a union of literals. */
function typeModule(members: readonly string[]): string {
  return `type ScopedVariable = ${quoted(members).join(' | ')};\nexport type { ScopedVariable };\n`;
}

/** The lint rule carrying the key list, with the list on the second line. */
function gateModule(keys: readonly string[]): string {
  return gateModuleWith(`new Set([${quoted(keys).join(', ')}])`);
}

/** The same module with an arbitrary initializer, for the shapes that cannot be read. */
function gateModuleWith(initializer: string): string {
  return `/** The variables the ambient request scope carries. */\nconst SCOPED_KEYS = ${initializer};\nexport default { SCOPED_KEYS };\n`;
}

const SCOPED = ['db', 'redis', 'logger', 'principal'];

describe('scoped-set-gate-matches-the-scoped-type', () => {
  it('passes when the gate carries exactly the variables the type declares', () => {
    expect(rule.check(projectWith({ type: typeModule(SCOPED), gate: gateModule(SCOPED) }))).toEqual(
      []
    );
  });

  it('passes when the two lists agree as sets rather than in order', () => {
    expect(
      rule.check(
        projectWith({
          type: typeModule(['db', 'redis', 'logger', 'principal']),
          gate: gateModule(['principal', 'logger', 'redis', 'db']),
        })
      )
    ).toEqual([]);
  });

  it('passes when the scope carries a single variable, which is no union at all', () => {
    expect(rule.check(projectWith({ type: typeModule(['db']), gate: gateModule(['db']) }))).toEqual(
      []
    );
  });

  it('flags a scoped variable the type declares and the gate does not carry', () => {
    expect(
      rule.check(
        projectWith({ type: typeModule([...SCOPED, 'session']), gate: gateModule(SCOPED) })
      )
    ).toEqual([
      {
        file: GATE_PATH,
        line: 2,
        message:
          "`ScopedVariable` (apps/api/src/lib/context/request-scope.ts) declares 'session' and " +
          "`SCOPED_KEYS` does not carry it, so a bare `.set('session', …)` writes `c.var` alone " +
          'and no gate refuses it.',
      },
    ]);
  });

  it('flags a key the gate carries that the type does not declare', () => {
    expect(
      rule.check(
        projectWith({ type: typeModule(SCOPED), gate: gateModule([...SCOPED, 'session']) })
      )
    ).toEqual([
      {
        file: GATE_PATH,
        line: 2,
        message:
          "`SCOPED_KEYS` carries 'session' and `ScopedVariable` " +
          '(apps/api/src/lib/context/request-scope.ts) does not declare it, so the gate stands ' +
          'over a variable the ambient request scope no longer holds.',
      },
    ]);
  });

  it('flags both directions in one run', () => {
    const violations = rule.check(
      projectWith({ type: typeModule(['db', 'session']), gate: gateModule(['db', 'trace']) })
    );

    expect(violations.map((violation) => violation.message)).toEqual([
      expect.stringContaining("declares 'session'"),
      expect.stringContaining("carries 'trace'"),
    ]);
  });

  it('fails loudly when the module declaring the scoped variables is not where it is named', () => {
    expect(() => rule.check(projectWith({ gate: gateModule(SCOPED) }))).toThrow(
      /names no file in the scanned tree/
    );
  });

  it('fails loudly when the type alias it derives the keys from is gone', () => {
    expect(() =>
      rule.check(projectWith({ type: 'export type Other = string;\n', gate: gateModule(SCOPED) }))
    ).toThrow(/declares no `ScopedVariable`/);
  });

  it('fails loudly when a scoped variable is no longer a string literal', () => {
    expect(() =>
      rule.check(
        projectWith({ type: "type ScopedVariable = 'db' | number;\n", gate: gateModule(SCOPED) })
      )
    ).toThrow(/not a union of string literals/);
  });

  it('fails loudly when the lint rule carrying the gate is not where it is named', () => {
    expect(() => rule.check(projectWith({ type: typeModule(SCOPED) }))).toThrow(
      /no-bare-scoped-set\.mjs/
    );
  });

  it('fails loudly when the lint rule declares no key list', () => {
    expect(() =>
      rule.check(
        projectWith({
          type: typeModule(SCOPED),
          gate: "const OTHER_KEYS = new Set(['db']);\nexport default { OTHER_KEYS };\n",
        })
      )
    ).toThrow(/declares no `SCOPED_KEYS`/);
  });

  it('fails loudly when the key list holds no literals to read', () => {
    expect(() =>
      rule.check(projectWith({ type: typeModule(SCOPED), gate: gateModuleWith('new Set()') }))
    ).toThrow(/is not a list of string literals/);
  });

  it('fails loudly when the key list is declared without one', () => {
    expect(() =>
      rule.check(projectWith({ type: typeModule(SCOPED), gate: 'let SCOPED_KEYS;\n' }))
    ).toThrow(/is not a list of string literals/);
  });

  it('fails loudly when a key is written in a form it cannot read', () => {
    expect(() =>
      rule.check(
        projectWith({ type: typeModule(SCOPED), gate: gateModuleWith("new Set([DB, 'redis'])") })
      )
    ).toThrow(/is not a list of string literals/);
  });
});
