// Programmatic ESLint tests for the vendored no-forged-money-input rule.
//
// The rule exists because the type system provably cannot express what it
// checks: `Object.assign<T, U>` is declared to return `T & U`, which is
// assignable to `T` by construction, so NO intersection brand — at object level
// or field level — can ever refuse it. Every fixture below is a route that
// type-checks clean today and must not.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../no-forged-money-input.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RULE_ID = 'e2e-money/no-forged-money-input';

/**
 * The rule asks the checker what a value IS, so its fixtures have to be typed.
 * Each one is linted as a file inside a fixture project whose `vocabulary.ts`
 * declares the brands and signatures, with the preamble below supplying the
 * honestly-obtained values a spec would have in scope.
 */
const SAMPLE_DIR = path.join(here, '__test-fixtures-no-forged-money-input__');
const SAMPLE_FILE = path.join(SAMPLE_DIR, 'sample.ts');

const PREAMBLE = `
import {
  catalogPerImageCharge, compareChargeAttribution, compareHoldCoverage, compareMoneyState,
  expectChargeAttribution, expectExactCharge, expectHoldCovers, expectNoMoneyMoved,
  mockGenerationCharge, mockTextTurnCharge, readChargeAttribution, readHold,
  readMockChargeBasis, readMoneyState, readServedModelPricing, readSettledCharge,
  spendOf, storedTextCharge, sumOfCharges,
} from './vocabulary.js';
import type { APIRequestContext, MockTextTurn, MoneyState, ServedChargeBasis } from './vocabulary.js';

declare const request: APIRequestContext;
declare const id: string;
declare const raw: string;
declare const turn: MockTextTurn;
declare const response: Response;
declare const cannedGet: APIRequestContext['get'];
declare const whicheverMinter: string;
declare const helpers: { money: { mockGenerationCharge: typeof mockGenerationCharge } };
declare function use(value: unknown): void;
`;

/** @param {string} code */
async function lint(code) {
  const linter = new ESLint({
    cwd: SAMPLE_DIR,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { project: './tsconfig.json', tsconfigRootDir: SAMPLE_DIR },
        },
      },
      ...extensionConfig,
    ],
  });
  const [result] = await linter.lintText(PREAMBLE + code, { filePath: SAMPLE_FILE });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

// The honest opening line of every fixture below: a value that came from a read.
const READ_BASIS = 'const basis = await readMockChargeBasis(request);\n';
const READ_STATE = 'const before = await readMoneyState(request);\n';

describe('the type information the rule rests on', () => {
  it('refuses to run without it rather than passing everything silently', async () => {
    // Every predicate asks the checker, so a configuration that gives the rule
    // no program would make it a rule that reports nothing while looking green.
    const linter = new ESLint({
      cwd: SAMPLE_DIR,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        ...extensionConfig,
      ],
    });
    await expect(
      linter.lintText('mockGenerationCharge(JSON.parse(raw), 1);\n', { filePath: SAMPLE_FILE })
    ).rejects.toThrow('is type-aware');
  });
});

describe('an argument the compiler cannot name', () => {
  it('flags every `any` source alike, because it asks the type and not the name', async () => {
    // Four producers, one property. Naming them was tried for five cycles and
    // the list was falsified each time by the producer nobody had listed.
    const messages = await lint(
      'mockGenerationCharge(await response.json(), 1);\n' +
        'mockGenerationCharge(JSON.parse(raw), 1);\n' +
        'mockGenerationCharge(Object.create(null), 1);\n' +
        "mockGenerationCharge(Reflect.get({}, 'x'), 1);\n"
    );
    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.message)).toEqual(
      Array.from({ length: 4 }, () => expect.stringContaining('`any`'))
    );
  });

  it('flags an `any` an annotation has declared away, because the annotation is the forgery', async () => {
    const messages = await lint(
      'const forged: ServedChargeBasis = await response.json();\n' +
        'mockGenerationCharge(forged, 1);\n'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('`any`');
  });

  it('flags an `any` assigned in after the binding was declared', async () => {
    const messages = await lint(
      'let forged: ServedChargeBasis = await readMockChargeBasis(request);\n' +
        'forged = await response.json();\n' +
        'use(mockTextTurnCharge(forged, turn));\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags a value assembled at the call site out of a read one', async () => {
    const messages = await lint(
      READ_BASIS +
        "mockGenerationCharge(Object.assign({}, basis, { generationChargeNanoUsd: '42' }), 1);\n"
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('an intersection assembled at the call site');
  });

  it('flags an assembled value that reaches a minter through a variable', async () => {
    // Twice: where it was assembled, and where it was handed in. Both are true.
    const messages = await lint(
      READ_BASIS +
        "const forged = Object.assign({}, basis, { generationChargeNanoUsd: '42' });\n" +
        'mockTextTurnCharge(forged, turn);\n'
    );
    expect(messages).toHaveLength(2);
  });

  it('flags a forged request context handed to a read', async () => {
    // The read is where the refusal has to happen: forge the context and the
    // read mints a brand over numbers the running system never served, which
    // nothing downstream of it can tell from an honest reading.
    const messages = await lint(
      'const canned = Object.assign({}, request, { get: cannedGet });\n' +
        'const state = await readMoneyState(canned);\n' +
        'await expectNoMoneyMoved(request, id, state);\n'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('an intersection assembled at the call site');
  });

  it('flags a forged hold, the one member where a forgery passed silently', async () => {
    // `compareHoldCoverage` orders with `>=`, which COERCES a wrapper object
    // where its siblings' `===` reports a divergence. It now refuses a
    // non-bigint at runtime too; this keeps the value from arriving at all.
    const messages = await lint(
      'const hold = Object.assign(Object(999999999n), {});\n' +
        'await expectHoldCovers(request, id, hold);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags each forged argument once, not once per later use', async () => {
    const messages = await lint(
      'const forged = JSON.parse(raw);\n' +
        'mockGenerationCharge(forged, 1);\n' +
        'mockGenerationCharge(forged, 2);\n'
    );
    expect(messages).toHaveLength(2);
  });

  it('allows a value that came from a read', async () => {
    const messages = await lint(READ_BASIS + 'mockGenerationCharge(basis, 1);\n');
    expect(messages).toEqual([]);
  });

  it('allows the readings and derivations a spec composes honestly', async () => {
    const messages = await lint(
      READ_BASIS +
        READ_STATE +
        'const rows = await readChargeAttribution(request, id);\n' +
        'const hold = await readHold(request, id);\n' +
        "use(compareChargeAttribution(rows, { payerId: 'someone' }));\n" +
        'use(compareHoldCoverage(hold, await readSettledCharge(request, id)));\n' +
        'use(compareMoneyState(before, { purchased: spendOf(mockGenerationCharge(basis, 1)) }));\n' +
        'await expectExactCharge(request, id, sumOfCharges(storedTextCharge(4), mockTextTurnCharge(basis, turn)));\n' +
        'await expectChargeAttribution(request, id, { payerId: id });\n'
    );
    expect(messages).toEqual([]);
  });

  it('allows JSON.parse away from the money vocabulary', async () => {
    // The suite parses request bodies and the storage-state file this way.
    // Asking about the vocabulary's own arguments, rather than banning the
    // global, is what keeps this rule allowlist-free.
    const messages = await lint(
      'use(storedTextCharge(4));\n' + 'const body = JSON.parse(raw);\nuse(body.model);\n'
    );
    expect(messages).toEqual([]);
  });
});

describe('a write through a widened alias', () => {
  it('flags a rewritten reading, which the compiler accepts through a plain-typed binding', async () => {
    // `readonly` is ignored in assignability and a branded field is assignable
    // to its plain base, so this compiles with no cast and nothing to grep for,
    // and every later assertion over that state passes over a number it holds.
    const messages = await lint(
      READ_STATE +
        'const widened: { purchasedNanoUsd: bigint } = before;\n' +
        'widened.purchasedNanoUsd = 9999999999n;\n' +
        'await expectNoMoneyMoved(request, id, before);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags a rewritten row, where the forgery is who paid rather than how much', async () => {
    const messages = await lint(
      'const rows = await readChargeAttribution(request, id);\n' +
        'const widened: { payerId: string }[] = rows;\n' +
        "widened[0].payerId = 'attacker';\n" +
        "use(compareChargeAttribution(rows, { payerId: 'attacker' }));\n"
    );
    expect(messages).toHaveLength(1);
  });

  it('flags an increment through the same alias, which is the same rewrite', async () => {
    const messages = await lint(
      READ_STATE +
        'const widened: { purchasedNanoUsd: bigint } = before;\n' +
        'widened.purchasedNanoUsd++;\n' +
        'await expectNoMoneyMoved(request, id, before);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags a rewrite through a binding the reading was assigned into afterwards', async () => {
    // The annotation is the forgery, and a declaration does not have to carry
    // it: declare the binding wide, assign the reading a statement later, and
    // the write is the same one.
    const messages = await lint(
      READ_STATE +
        'let widened: { purchasedNanoUsd: bigint } = { purchasedNanoUsd: 0n };\n' +
        'widened = before;\n' +
        'widened.purchasedNanoUsd = 9999999999n;\n' +
        'await expectNoMoneyMoved(request, id, before);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('keeps reporting over a type the checker answers no type arguments for', async () => {
    // `typeof f<T>` is a type whose type node is an instantiation type query,
    // and TypeScript answers `undefined` — not an empty array — when asked for
    // its type arguments. @types/node and vitest both declare members of that
    // shape, so a walk that spreads the answer aborts the whole ESLint run on
    // ordinary code that merely has one in scope.
    const messages = await lint(
      'declare function widen<T>(value: T): T;\n' +
        'declare const carrier: { readonly api: typeof widen<string>; purchasedNanoUsd: bigint };\n' +
        READ_STATE +
        'const unrelated = carrier;\n' +
        'unrelated.purchasedNanoUsd = 1n;\n' +
        'const widened: { purchasedNanoUsd: bigint } = before;\n' +
        'widened.purchasedNanoUsd = 9999999999n;\n' +
        'await expectNoMoneyMoved(request, id, before);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('does not chase a write through a name no binding declares', async () => {
    const messages = await lint(
      READ_STATE +
        'undeclared.purchasedNanoUsd = 1n;\n' +
        'await expectNoMoneyMoved(request, id, before);\n'
    );
    expect(messages).toEqual([]);
  });

  it('allows a write to a binding that never held a reading', async () => {
    const messages = await lint(
      'use(storedTextCharge(4));\n' +
        'const counts = { turns: 0 };\n' +
        'let plain = 0;\n' +
        'counts.turns = 2;\n' +
        'counts.turns++;\n' +
        'plain++;\n'
    );
    expect(messages).toEqual([]);
  });

  it('allows a write whose target is not reached through a binding at all', async () => {
    const messages = await lint(
      'use(storedTextCharge(4));\n' +
        'function box(): { turns: number } { return { turns: 0 }; }\n' +
        'box().turns = 2;\n'
    );
    expect(messages).toEqual([]);
  });
});

describe('a brand laundered through a declaration we do not own', () => {
  it('flags the mutating form, which forges every later derivation from that basis', async () => {
    const messages = await lint(
      READ_BASIS +
        "Object.assign(basis, { generationChargeNanoUsd: '42' });\n" +
        'mockGenerationCharge(basis, 1);\n'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Object.assign');
  });

  it('flags a rewrite through a property definition, which no forger list named', async () => {
    const messages = await lint(
      READ_BASIS +
        "Object.defineProperty(basis, 'generationChargeNanoUsd', { value: '42' });\n" +
        'mockGenerationCharge(basis, 1);\n'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Object.defineProperty');
  });

  it('flags a reassignment that forges an already-read basis', async () => {
    const messages = await lint(
      'let basis = await readMockChargeBasis(request);\n' +
        "basis = Object.assign({}, basis, { echoSuffix: '' });\n" +
        'mockGenerationCharge(basis, 1);\n'
    );
    // Two reports, one forgery: the laundering call, and the argument that was
    // assigned its result. Each names the rewrite from its own end.
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.messageId)).size).toBe(2);
  });

  it('flags a forger laundered into a property, which the previous rule could not chase', async () => {
    // Two predicates answer this one: the value is assembled by a declaration
    // we do not own, and it is written into a binding that holds a reading.
    const messages = await lint(
      READ_BASIS +
        'const box: { basis: ServedChargeBasis } = { basis };\n' +
        'box.basis = Object.assign({}, basis);\n' +
        'mockGenerationCharge(box.basis, 1);\n'
    );
    expect(messages).toHaveLength(2);
  });

  it('does not report a mutating call that hands back no brand', async () => {
    // Predicate 3 asks what the call RETURNS, and `Reflect.set` is declared
    // `boolean`, so it is out of the predicate's reach by construction rather
    // than by oversight. On a frozen reading it returns `false` and mutates
    // nothing — but it does not throw, which is why the runtime refusal is
    // exact only for assignment spellings.
    const messages = await lint(
      READ_BASIS +
        "Object.assign(basis, { generationChargeNanoUsd: '42' });\n" +
        "Reflect.set(basis, 'generationChargeNanoUsd', '42');\n" +
        'mockGenerationCharge(basis, 1);\n'
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Object.assign');
  });

  it('allows a reading handed to a function this codebase declares', async () => {
    // The predicate is about declarations we do not own. A first-party helper
    // taking a reading is the vocabulary's own composition, and laundering
    // across a function boundary stays the open limit it has always been.
    const messages = await lint(
      READ_BASIS +
        'function widen(value: ServedChargeBasis): ServedChargeBasis { return value; }\n' +
        'mockGenerationCharge(widen(basis), 1);\n'
    );
    expect(messages).toEqual([]);
  });

  it('allows a reading handed to a call that gives the brand back stripped', async () => {
    const messages = await lint(
      READ_BASIS +
        'use(String(await readSettledCharge(request, id)));\n' +
        'use(BigInt(basis.generationChargeNanoUsd));\n'
    );
    expect(messages).toEqual([]);
  });

  it('allows a call that returns readings it was never handed', async () => {
    // `filter` is declared outside this codebase and gives back branded rows,
    // but it was handed a predicate, not a reading — nothing was laundered.
    const messages = await lint(
      'const rows = await readChargeAttribution(request, id);\n' +
        'use(rows.filter((row) => row.payerId === id));\n' +
        'use(compareChargeAttribution(rows, { payerId: id }));\n'
    );
    expect(messages).toEqual([]);
  });

  it('does not evaluate a file that never calls the vocabulary', async () => {
    // The stated bound: a value forged in one file and asserted in another is
    // the cross-boundary laundering this design already leaves open, and this
    // is what keeps the type queries off every file in the repo.
    const messages = await lint(
      'declare const basis: ServedChargeBasis;\n' + 'Object.assign(basis, {});\n'
    );
    expect(messages).toEqual([]);
  });
});

describe('the callee a forged value reaches', () => {
  it('flags a forger reaching a minter imported under another name', async () => {
    const messages = await lint(
      "import { mockGenerationCharge as mint } from './vocabulary.js';\n" +
        'mint(JSON.parse(raw), 1);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags a forger reaching the vocabulary through a namespace import', async () => {
    const messages = await lint(
      "import * as money from './vocabulary.js';\n" +
        'money.mockGenerationCharge(JSON.parse(raw), 1);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags a forger reaching a member destructured off the vocabulary', async () => {
    const messages = await lint(
      "import * as money from './vocabulary.js';\n" +
        'const { mockGenerationCharge: mint } = money;\n' +
        'mint(JSON.parse(raw), 1);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('flags a forger reaching a member named by a string, in either spelling', async () => {
    const messages = await lint(
      "import { 'mockGenerationCharge' as mint } from './vocabulary.js';\n" +
        "import * as money from './vocabulary.js';\n" +
        'mint(JSON.parse(raw), 1);\n' +
        "money['mockTextTurnCharge'](JSON.parse(raw), turn);\n"
    );
    expect(messages).toHaveLength(2);
  });

  it('does not chase a namespace rebound through a rest element', async () => {
    // A documented limit, matching what the vocabulary headers claim: a binding
    // that is not the import itself is laundering, and laundering is as
    // deliberate to write as the cast this design leaves open.
    const messages = await lint(
      "import * as money from './vocabulary.js';\n" +
        'const { compareMoneyState, ...rest } = money;\n' +
        'rest.mockGenerationCharge(JSON.parse(raw), 1);\n'
    );
    expect(messages).toEqual([]);
  });

  it('does not chase a vocabulary name reached through a property path', async () => {
    const messages = await lint('helpers.money.mockGenerationCharge(JSON.parse(raw), 1);\n');
    expect(messages).toEqual([]);
  });

  it('reads a nested destructure by the name it binds, having no key to resolve', async () => {
    const messages = await lint(
      'const { money: { mockGenerationCharge } } = helpers;\n' +
        'mockGenerationCharge(JSON.parse(raw), 1);\n'
    );
    expect(messages).toHaveLength(1);
  });

  it('does not trip over a callee that is not a name at all', async () => {
    const messages = await lint(
      'use(storedTextCharge(4));\n' + '(function immediately() { return 1; })();\n'
    );
    expect(messages).toEqual([]);
  });

  it('does not chase a member whose name is only known at runtime', async () => {
    const messages = await lint(
      "import * as money from './vocabulary.js';\n" +
        'money[whicheverMinter](JSON.parse(raw), 1);\n'
    );
    expect(messages).toEqual([]);
  });
});
