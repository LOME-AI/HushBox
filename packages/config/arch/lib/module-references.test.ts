import { ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { moduleReferences } from './module-references.js';
import type { ModuleReference } from './module-references.js';

function referencesIn(source: string): ModuleReference[] {
  return moduleReferences(
    ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  );
}

function only(source: string): ModuleReference {
  const references = referencesIn(source);
  expect(references).toHaveLength(1);
  return references[0]!;
}

describe('the declaration forms', () => {
  it('reads a default import', () => {
    expect(only("import x from 'm';\n")).toMatchObject({
      form: 'import-declaration',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('reads a side-effect import, which binds no name', () => {
    expect(only("import 'm';\n")).toMatchObject({ form: 'import-declaration', specifier: 'm' });
  });

  it('reads a namespace import', () => {
    expect(only("import * as ns from 'm';\n")).toMatchObject({
      form: 'import-declaration',
      specifier: 'm',
    });
  });

  it('marks a type-only import declaration type-only', () => {
    expect(only("import type { T } from 'm';\n")).toMatchObject({
      form: 'import-declaration',
      specifier: 'm',
      typeOnly: true,
    });
  });

  it('leaves a deferred import declaration a value edge, its phase not being `type`', () => {
    expect(only("import defer * as ns from 'm';\n")).toMatchObject({
      form: 'import-declaration',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('reads an import carrying attributes', () => {
    expect(only("import x from 'm' with { type: 'json' };\n")).toMatchObject({
      form: 'import-declaration',
      specifier: 'm',
    });
  });

  it('reads a named re-export', () => {
    expect(only("export { a } from 'm';\n")).toMatchObject({
      form: 'export-declaration',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('reads a star re-export', () => {
    expect(only("export * from 'm';\n")).toMatchObject({
      form: 'export-declaration',
      specifier: 'm',
    });
  });

  it('marks a type-only re-export type-only', () => {
    expect(only("export type { T } from 'm';\n")).toMatchObject({
      form: 'export-declaration',
      typeOnly: true,
    });
  });

  it('counts an export clause with no source module as naming no module', () => {
    expect(referencesIn('const a = 1;\nexport { a };\n')).toEqual([]);
  });
});

describe('the import-equals form', () => {
  it('reads an import assignment', () => {
    expect(only("import m = require('m');\n")).toMatchObject({
      form: 'import-equals',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('marks a type-only import assignment type-only', () => {
    expect(only("import type m = require('m');\n")).toMatchObject({
      form: 'import-equals',
      specifier: 'm',
      typeOnly: true,
    });
  });

  it('counts an alias of an entity as naming no module', () => {
    expect(referencesIn('namespace A { export const b = 1; }\nimport c = A.b;\n')).toEqual([]);
  });
});

describe('the type-position import form', () => {
  it('reads a module taken whole in a type position', () => {
    expect(only("export type B = typeof import('m');\n")).toMatchObject({
      form: 'import-type',
      specifier: 'm',
      typeOnly: true,
      member: undefined,
    });
  });

  it('reports the single name a qualified type-position import takes off the module', () => {
    expect(only("export type B = import('m').T;\n")).toMatchObject({
      form: 'import-type',
      specifier: 'm',
      member: 'T',
    });
  });

  it('reports the leftmost name of a dotted qualifier, that being what the module published', () => {
    expect(only("export type B = import('m').A.B;\n")).toMatchObject({
      form: 'import-type',
      member: 'A',
    });
  });
});

describe('the call forms', () => {
  it('reads a dynamic import', () => {
    expect(only("export const l = () => import('m');\n")).toMatchObject({
      form: 'dynamic-import',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('reads a phase-modified dynamic import, the same link under another spelling', () => {
    expect(only("export const l = () => import.defer('m');\n")).toMatchObject({
      form: 'dynamic-import',
      specifier: 'm',
    });
  });

  it('reads a require call', () => {
    expect(only("export const m = require('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('counts a call that is neither an import nor a require as naming no module', () => {
    expect(referencesIn("export const v = describe('m');\n")).toEqual([]);
  });

  it('reads a require call through parentheses', () => {
    expect(only("export const m = (require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through nested parentheses', () => {
    expect(only("export const m = ((require))('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through a comma sequence, whose value is its last operand', () => {
    expect(only("export const m = (0, require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through an `as` assertion', () => {
    expect(only("export const m = (require as unknown as typeof require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through a `satisfies` operator', () => {
    expect(only("export const m = (require satisfies typeof require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through a non-null assertion', () => {
    expect(only("export const m = require!('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through an assertion applied to a parenthesized callee', () => {
    expect(only("export const m = (require)!('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require call through an angle-bracket assertion', () => {
    expect(only("export const m = (<typeof require>require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a call of a `createRequire` result, that call being require itself', () => {
    expect(only("export const m = createRequire(import.meta.url)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  /**
   * Reading the minter off another object turns this spelling into a LINK
   * rather than an escape, so it is the one route the widened mint check opens
   * that carries a written specifier — which is what makes it visible to a
   * caller that skips a reference having none. It shares its branch with the
   * identifier-callee mint call, so coverage cannot tell whether it is pinned;
   * only this case can.
   */
  it('reads a call of a mint result whose callee was taken off another object', () => {
    expect(
      only("export const m = nodeModule.createRequire(import.meta.url)('m');\n")
    ).toMatchObject({ form: 'require', specifier: 'm' });
  });

  it('counts `import.meta.resolve` as naming no module, since it links none', () => {
    expect(referencesIn("export const u = import.meta.resolve('m');\n")).toEqual([]);
  });

  it('counts `require.resolve` as naming no module, since it links none', () => {
    expect(referencesIn("export const p = require.resolve('m');\n")).toEqual([]);
  });

  it('counts a `createRequire` resolve as naming no module, since it too links none', () => {
    expect(referencesIn("const p = createRequire(import.meta.url).resolve('m');\n")).toEqual([]);
  });
});

describe('a require function that escapes into a value', () => {
  it('enumerates a require bound to a name, the binding being where the module goes unwritten', () => {
    expect(only("const req = require;\nexport const m = req('m');\n")).toMatchObject({
      form: 'require-escape',
      specifier: undefined,
      typeOnly: false,
    });
  });

  it('enumerates a require taken by name off another object', () => {
    expect(only("export const m = module.require('m');\n")).toMatchObject({
      form: 'require-escape',
      specifier: undefined,
    });
  });

  it('enumerates a require taken off another object by a written key', () => {
    expect(only("export const m = globalThis['require']('m');\n")).toMatchObject({
      form: 'require-escape',
      specifier: undefined,
    });
  });

  it('enumerates a require reached through another require, which escapes at each step', () => {
    expect(
      referencesIn("export const m = require.main!.require('m');\n").map(({ form }) => form)
    ).toEqual(['require-escape', 'require-escape']);
  });

  it('enumerates a require applied through `call`', () => {
    expect(only("export const m = require.call(null, 'm');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a require indexed out of an array literal', () => {
    expect(only("export const m = [require][0]!('m');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a require taken through a nullish coalesce', () => {
    expect(only("export const m = (require ?? null)!('m');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a `createRequire` result bound rather than invoked', () => {
    expect(only('const req = createRequire(import.meta.url);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates the function that mints a require, bound rather than called', () => {
    expect(referencesIn('const mk = createRequire;\n').map(({ form }) => form)).toEqual([
      'require-escape',
    ]);
  });

  it('enumerates the mint function taken by name off another object', () => {
    expect(referencesIn('const mk = nodeModule.createRequire;\n').map(({ form }) => form)).toEqual([
      'require-escape',
    ]);
  });

  it('enumerates a mint call whose callee is taken off another object', () => {
    expect(
      referencesIn('const load = nodeModule.createRequire(import.meta.url);\n').map(
        ({ form }) => form
      )
    ).toEqual(['require-escape']);
  });

  it('carries the escaping expression, which is the site a caller has to print', () => {
    expect(only("export const m = module.require('m');\n").node.getText()).toBe('module.require');
  });
});

/**
 * The same escape written where the source writes a NAME: a property read off a
 * destructured value, the export an import clause takes off another module, a
 * shorthand that is a key and a read at once, a name an export hands on. Each
 * is a value read spelled in a name's position, which is what makes it the
 * route a name-slot rule passes over.
 */
describe('a require read out of a name the source writes', () => {
  it('enumerates a require destructured off another object under a new name', () => {
    expect(only("const { require: load } = module;\nexport const m = load('m');\n")).toMatchObject({
      form: 'require-escape',
      specifier: undefined,
      typeOnly: false,
    });
  });

  it('enumerates that destructure off any object, the key being what it reads', () => {
    expect(only("const { require: load } = bag;\nexport const m = load('m');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructure under an outer binding element, which carries a key of its own', () => {
    expect(only('const { inner: { require: load } } = bag;\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructure written in a parameter', () => {
    expect(only("export const f = ({ require: load }: any) => load('m');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructure carrying a default', () => {
    expect(only('const { require: load = null } = module;\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructured key written as a string, the spelling a bracket read uses', () => {
    expect(only("const { ['require']: load } = module;\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructured key written as a quoted name', () => {
    expect(only("const { 'require': load } = module;\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructure standing as the variable of a `for…of`', () => {
    expect(only('let load: any;\nfor ({ require: load } of xs) { load; }\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructure standing as the variable of a `for…in`', () => {
    expect(only('let load: any;\nfor ({ require: load } in xs) { load; }\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a destructure written as an assignment rather than a declaration', () => {
    expect(only('let load: any;\n({ require: load } = module);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates an assignment destructure nested inside another, which the outer key does not hide', () => {
    expect(only('let load: any;\n({ outer: { require: load } } = bag);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates an assignment destructure written inside a parenthesis', () => {
    expect(only('let load: any;\n(({ require: load }) = bag);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates an assignment destructure standing as an element of an array pattern', () => {
    expect(only('let load: any;\n([{ require: load }] = xs);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates an assignment destructure reached through an object spread', () => {
    expect(only('let rest: any;\n({ ...{ require: rest } } = bag);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates an assignment destructure reached through an array rest element', () => {
    expect(only('let load: any;\n([...{ require: load }] = xs);\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a require handed on as an object shorthand', () => {
    expect(only('declare const send: (x: unknown) => void;\nsend({ require });\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a require imported off another module under a new name', () => {
    expect(referencesIn("import { require as load } from 'm';\n").map(({ form }) => form)).toEqual([
      'import-declaration',
      'require-escape',
    ]);
  });

  it('enumerates a require exported by name, which hands it to whatever imports it', () => {
    expect(only('declare const require: unknown;\nexport { require };\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a require re-exported straight out of another module', () => {
    expect(referencesIn("export { require } from 'm';\n").map(({ form }) => form)).toEqual([
      'export-declaration',
      'require-escape',
    ]);
  });

  it('enumerates a require exported under another name', () => {
    expect(only('declare const require: unknown;\nexport { require as load };\n')).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates the mint function imported off another module under a new name', () => {
    expect(
      referencesIn("import { createRequire as mk } from 'node:module';\n").map(({ form }) => form)
    ).toEqual(['import-declaration', 'require-escape']);
  });

  it('enumerates the mint function destructured off a namespace under a new name', () => {
    expect(
      referencesIn('const { createRequire: mk } = nodeModule;\n').map(({ form }) => form)
    ).toEqual(['require-escape']);
  });

  it('enumerates the mint function re-exported straight out of another module', () => {
    expect(
      referencesIn("export { createRequire } from 'node:module';\n").map(({ form }) => form)
    ).toEqual(['export-declaration', 'require-escape']);
  });

  it('carries the destructured property, which is the site a caller has to print', () => {
    expect(only('const { require: load } = module;\n').node.getText()).toBe('require: load');
  });
});

describe('the word `require` written where it reads as no value', () => {
  it('passes over a type query, which names a type rather than reading the function', () => {
    expect(referencesIn('export type R = typeof require;\n')).toEqual([]);
  });

  it('passes over a qualified type query, whose leftmost name is the same word', () => {
    expect(referencesIn('export type R = typeof require.main;\n')).toEqual([]);
  });

  it('passes over the name slot of a declaration, which binds the word rather than reading it', () => {
    expect(referencesIn('export const require = 1;\n')).toEqual([]);
  });

  it('passes over a property key written with the same word', () => {
    expect(referencesIn('export const o = { require: 1 };\n')).toEqual([]);
  });

  it('passes over a resolve on a require taken off an object, that spelling linking nothing', () => {
    expect(referencesIn("export const p = module.require.resolve('m');\n")).toEqual([]);
  });

  it('passes over a binding renamed TO the word, the name slot beside a key of another name', () => {
    expect(referencesIn('const { load: require } = bag;\n')).toEqual([]);
  });

  it('passes over an import renamed TO the word, which binds it rather than reading it', () => {
    expect(referencesIn("import { foo as require } from 'm';\n").map(({ form }) => form)).toEqual([
      'import-declaration',
    ]);
  });

  it('passes over an export renamed TO the word, that name being one this module hands out', () => {
    expect(referencesIn('declare const foo: unknown;\nexport { foo as require };\n')).toEqual([]);
  });

  it('passes over an import of the word bound under it, which leaves every later use readable', () => {
    expect(
      referencesIn("import { require } from 'm';\nexport const x = require('./a.js');\n").map(
        ({ form, specifier }) => ({ form, specifier })
      )
    ).toEqual([
      { form: 'import-declaration', specifier: 'm' },
      { form: 'require', specifier: './a.js' },
    ]);
  });

  it('passes over a shorthand destructure, which leaves every later use of it readable', () => {
    expect(referencesIn("const { require } = module;\nexport const m = require('m');\n")).toEqual([
      expect.objectContaining({ form: 'require', specifier: 'm' }),
    ]);
  });

  it('passes over a destructured key it cannot read, which is the residue of reading by name', () => {
    expect(referencesIn('declare const k: string;\nconst { [k]: load } = module;\n')).toEqual([]);
  });

  it('passes over a key of a literal a `for…of` iterates, which builds rather than reads', () => {
    expect(referencesIn('for (const x of [{ require: 1 }]) { x; }\n')).toEqual([]);
  });

  it('passes over a type-only import of the word, which binds no value to read', () => {
    expect(
      referencesIn("import type { require as load } from 'm';\n").map(({ form }) => form)
    ).toEqual(['import-declaration']);
  });

  it('passes over a type-only specifier in a value import, the other spelling of that', () => {
    expect(
      referencesIn("import { type require as load } from 'm';\n").map(({ form }) => form)
    ).toEqual(['import-declaration']);
  });

  it('passes over a type-only export of the word, which binds no value to hand out', () => {
    expect(referencesIn('declare const require: unknown;\nexport type { require };\n')).toEqual([]);
  });

  it('passes over a type-only specifier in a value export, the other spelling of that', () => {
    expect(referencesIn('declare const require: unknown;\nexport { type require };\n')).toEqual([]);
  });
});

/**
 * The mint function read where it names no loader to hand on: bound under its
 * own word, which leaves every later call of it readable; written in a name
 * slot, which declares the word rather than reading it; or binding a type,
 * which binds no value at all. The mirror of the `require` block above, and the
 * side that decides the false positives — the walk matches these two words
 * wherever the source writes them.
 */
describe('the word `createRequire` written where it reads as no value', () => {
  it('passes over an import of it bound under its own word, which leaves the call readable', () => {
    expect(
      referencesIn(
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\n"
      ).map(({ form }) => form)
    ).toEqual(['import-declaration', 'require-escape']);
  });

  it('passes over a shorthand destructure of it, which leaves the call readable', () => {
    expect(
      referencesIn(
        'const { createRequire } = nodeModule;\nconst load = createRequire(import.meta.url);\n'
      ).map(({ form }) => form)
    ).toEqual(['require-escape']);
  });

  it('passes over the name slot of a declaration, which binds the word rather than reading it', () => {
    expect(
      referencesIn('export function createRequire(url: string): string {\n  return url;\n}\n')
    ).toEqual([]);
  });

  it('passes over an import renamed TO the word, which binds it rather than reading it', () => {
    expect(
      referencesIn("import { foo as createRequire } from 'm';\n").map(({ form }) => form)
    ).toEqual(['import-declaration']);
  });

  it('passes over a type-only import of the word, which binds no value to read', () => {
    expect(
      referencesIn("import type { createRequire as mk } from 'node:module';\n").map(
        ({ form }) => form
      )
    ).toEqual(['import-declaration']);
  });

  it('passes over a resolve minted off a namespace, that spelling linking no module', () => {
    expect(
      referencesIn("const p = nodeModule.createRequire(import.meta.url).resolve('m');\n")
    ).toEqual([]);
  });
});

describe('a resolve read off a require loader, which links no module', () => {
  it('counts a resolve on an asserted require as naming no module', () => {
    expect(referencesIn("export const p = (require as typeof require).resolve('m');\n")).toEqual(
      []
    );
  });

  it('counts a resolve on a parenthesized require as naming no module', () => {
    expect(referencesIn("export const p = (require).resolve('m');\n")).toEqual([]);
  });

  it('counts a `createRequire` resolve on an argument other than `import.meta.url` as naming no module', () => {
    expect(referencesIn("const p = createRequire(import.meta.filename).resolve('m');\n")).toEqual(
      []
    );
  });
});

describe('the construct spelling of a require invocation', () => {
  it('reads a require construct, `new` over require loading what the call loads', () => {
    expect(only("export const m = new require('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
      typeOnly: false,
    });
  });

  it('reads a construct of a `createRequire` result, that being require under ESM', () => {
    expect(only("export const m = new (createRequire(import.meta.url))('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require construct through a comma sequence, the callee wrappers travelling with it', () => {
    expect(only("export const m = new (0, require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require construct through an `as` assertion', () => {
    expect(only("export const m = new (require as typeof require)('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('reads a require construct through a non-null assertion', () => {
    expect(only("export const m = new require!('m');\n")).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('enumerates a require construct written with no argument list at all', () => {
    expect(only('export const m = new require;\n')).toMatchObject({
      form: 'require',
      specifier: undefined,
    });
  });

  it('enumerates a construct of an aliased require, the alias escaping as it does in a call', () => {
    expect(only("const req = require;\nexport const m = new req('m');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('enumerates a construct of `module.require`', () => {
    expect(only("export const m = new module.require('m');\n")).toMatchObject({
      form: 'require-escape',
    });
  });

  it('counts a construct of `require.resolve` as naming no module, since it links none', () => {
    expect(referencesIn("export const m = new require.resolve('m');\n")).toEqual([]);
  });

  it('counts a construct of anything that is no require as naming no module', () => {
    expect(referencesIn("export const m = new Map('m');\n")).toEqual([]);
  });
});

describe('a form written in a JSDoc comment', () => {
  it('reads an `@import` tag, whose names bind as types', () => {
    expect(only("/** @import { T } from 'm' */\nexport const v = 1;\n")).toMatchObject({
      form: 'jsdoc-import',
      specifier: 'm',
      typeOnly: true,
    });
  });

  it('reads a type-position import inside a `@type` tag', () => {
    expect(only("/** @type {import('m').T} */\nexport const v = 1;\n")).toMatchObject({
      form: 'import-type',
      specifier: 'm',
      typeOnly: true,
      member: 'T',
    });
  });
});

describe('a substitution-free template', () => {
  it('is the specifier a dynamic import names, a bundler reading it as a quoted one', () => {
    expect(only('export const l = () => import(`m`);\n')).toMatchObject({
      form: 'dynamic-import',
      specifier: 'm',
    });
  });

  it('is the specifier a require call names', () => {
    expect(only('export const m = require(`m`);\n')).toMatchObject({
      form: 'require',
      specifier: 'm',
    });
  });

  it('names nothing in an import declaration, where TypeScript rejects the token', () => {
    expect(only('import x from `m`;\n')).toMatchObject({
      form: 'import-declaration',
      specifier: undefined,
    });
  });

  it('names nothing in a re-export, where TypeScript rejects the token', () => {
    expect(only('export * from `m`;\n')).toMatchObject({
      form: 'export-declaration',
      specifier: undefined,
    });
  });

  it('names nothing in an import assignment, where TypeScript rejects the token', () => {
    expect(only('import m = require(`m`);\n')).toMatchObject({
      form: 'import-equals',
      specifier: undefined,
    });
  });

  it('names nothing in a type position, where TypeScript rejects the token', () => {
    expect(only('export type B = typeof import(`m`);\n')).toMatchObject({
      form: 'import-type',
      specifier: undefined,
    });
  });

  it('names nothing in a JSDoc `@import` tag, where the token parses yet resolves to nothing', () => {
    expect(only('/** @import { T } from `m` */\nexport const v = 1;\n')).toMatchObject({
      form: 'jsdoc-import',
      specifier: undefined,
    });
  });
});

describe('a specifier that is not written out', () => {
  it('is still enumerated, so no rule can mistake it for an absent edge', () => {
    expect(only('export const l = (n: string) => import(`./${n}.js`);\n')).toMatchObject({
      form: 'dynamic-import',
      specifier: undefined,
      literal: undefined,
    });
  });

  it('is enumerated for a dynamic import carrying no argument at all', () => {
    expect(only('export const l = () => import();\n')).toMatchObject({
      form: 'dynamic-import',
      specifier: undefined,
    });
  });

  it('is enumerated for a concatenated dynamic specifier', () => {
    expect(only("export const l = (n: string) => import('./' + n);\n")).toMatchObject({
      form: 'dynamic-import',
      specifier: undefined,
    });
  });

  it('is enumerated for a require call on a variable', () => {
    expect(only('export const l = (n: string) => require(n);\n')).toMatchObject({
      form: 'require',
      specifier: undefined,
    });
  });

  it('is enumerated for a require argument asserted `as const`, fixed text making no literal', () => {
    expect(only("export const m = require('m' as const);\n")).toMatchObject({
      form: 'require',
      specifier: undefined,
    });
  });

  it('is enumerated for a require argument written as a comma sequence, fixed text making no literal', () => {
    expect(only("export const m = require((0, 'm'));\n")).toMatchObject({
      form: 'require',
      specifier: undefined,
    });
  });

  it('is enumerated for a require specifier concatenated from two literals, fixed text making no literal', () => {
    expect(only("export const m = require('a' + 'b');\n")).toMatchObject({
      form: 'require',
      specifier: undefined,
    });
  });

  it('is enumerated for a type-position import naming a type', () => {
    expect(only('type N = string;\nexport type B = import(N).T;\n')).toMatchObject({
      form: 'import-type',
      specifier: undefined,
    });
  });
});

describe('what the walk carries back', () => {
  it('gives the one-based line the form starts on', () => {
    expect(only("\n\nimport x from 'm';\n").line).toBe(3);
  });

  it('gives the literal node, so a caller can resolve the specifier its own way', () => {
    const reference = only("import x from 'm';\n");
    expect(reference.literal?.text).toBe('m');
  });

  it('gives the form node, so a caller can render it as written', () => {
    const reference = only("export const l = () => import('m');\n");
    expect(reference.node.getText()).toBe("import('m')");
  });

  it('finds a form nested inside a function body', () => {
    expect(
      only("export async function load(): Promise<void> {\n  await import('m');\n}\n").line
    ).toBe(2);
  });

  it('returns every form in source order', () => {
    expect(
      referencesIn("import a from 'one';\nexport const l = () => import('two');\n").map(
        (reference) => reference.specifier
      )
    ).toEqual(['one', 'two']);
  });
});

describe('forms that name a module without linking one', () => {
  it('counts a triple-slash reference as no edge', () => {
    expect(referencesIn('/// <reference path="./m.ts" />\nexport const v = 1;\n')).toEqual([]);
  });

  it('counts a module augmentation as no edge', () => {
    expect(referencesIn("declare module 'm' {\n  export const v: number;\n}\n")).toEqual([]);
  });

  it('counts a URL built off `import.meta.url` as no edge', () => {
    expect(referencesIn("export const u = new URL('./m.js', import.meta.url);\n")).toEqual([]);
  });
});
