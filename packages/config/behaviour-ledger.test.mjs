import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyDecompositions,
  censusProblems,
  expandEnumeration,
  layerOfProofFile,
  parseBehaviourIds,
  proofProblems,
  symbolAppearsIn,
  shapeProblems,
  testTitlesIn,
} from './behaviour-ledger.mjs';

// WHAT THE FIXTURE BLOCKS BELOW PROVE: that each check fires. They feed the
// checker rows that are broken in one way each and assert the specific
// complaint, so a check that silently stopped resolving anything is itself a
// failure rather than a green run.
//
// WHAT THE LEDGER BLOCK PROVES: every enumerated behaviour has a row — over an
// id set parsed from the enumeration the ledger names as its source, never a
// count typed here — every proof names a file that exists today, every proof
// resolves inside that file (a test by its title, a compiler-enforced
// declaration by its symbol), and every row's declared layer is the layer its
// own proof paths derive to.
//
// WHAT NOTHING HERE PROVES: that a proof actually proves its behaviour. A test
// whose title survived while its body was gutted resolves green. The ledger is
// a map from behaviour to gate, kept honest down to the named test — read that
// test to learn what it asserts.

const repoRoot = path.resolve(import.meta.dirname, '../..');

describe('layerOfProofFile', () => {
  it('reads a Playwright spec as the e2e layer', () => {
    expect(layerOfProofFile('e2e/chat/multi-model.spec.ts')).toBe('e2e');
  });

  it('reads an integration test as the integration layer', () => {
    expect(layerOfProofFile('apps/api/src/slices/billing/domain/charge.integration.test.ts')).toBe(
      'integration'
    );
  });

  it('reads a ts-morph rule as the arch layer', () => {
    expect(layerOfProofFile('packages/config/arch/rules/single-writer-per-table.rule.ts')).toBe(
      'arch'
    );
  });

  it('reads a vendored ESLint rule as the arch layer', () => {
    expect(layerOfProofFile('packages/config/eslint-extensions/rules/matrix-declaration.mjs')).toBe(
      'arch'
    );
  });

  it('reads a plain colocated test as the unit layer', () => {
    expect(layerOfProofFile('packages/shared/src/affordability/turn-arithmetic.test.ts')).toBe(
      'unit'
    );
  });

  it('reads a non-test source file as the type layer', () => {
    expect(layerOfProofFile('packages/shared/src/affordability/turn-types.ts')).toBe('type');
  });
});

describe('expandEnumeration', () => {
  it('expands a count into hyphenated ids under its prefix', () => {
    expect(expandEnumeration({ 'COST-': 3 })).toEqual(['COST-1', 'COST-2', 'COST-3']);
  });

  it('expands an explicit suffix list, which is how sub-lettered ids are declared', () => {
    expect(expandEnumeration({ 'WCL-': ['1', '5a', '5b'] })).toEqual(['WCL-1', 'WCL-5a', 'WCL-5b']);
  });

  it('joins prefix and suffix verbatim, so a prefix carrying no separator yields none', () => {
    expect(expandEnumeration({ B: ['01', '02'] })).toEqual(['B01', 'B02']);
  });

  it('refuses a census that declares the same id twice', () => {
    expect(() => expandEnumeration({ 'COST-': ['1', '1'] })).toThrow('COST-1');
  });
});

describe('censusProblems', () => {
  const census = { 'COST-': 2 };

  it('names an enumerated id the ledger has no row for', () => {
    expect(censusProblems(census, [{ id: 'COST-1' }])).toEqual({
      missing: ['COST-2'],
      unexpected: [],
    });
  });

  it('names a ledger row the census does not enumerate', () => {
    expect(censusProblems(census, [{ id: 'COST-1' }, { id: 'COST-2' }, { id: 'COST-3' }])).toEqual({
      missing: [],
      unexpected: ['COST-3'],
    });
  });

  it('is silent when the row set and the census agree', () => {
    expect(censusProblems(census, [{ id: 'COST-2' }, { id: 'COST-1' }])).toEqual({
      missing: [],
      unexpected: [],
    });
  });
});

const unitRow = (over) => ({
  id: 'X-1',
  layer: ['unit'],
  proof: [
    { file: 'packages/shared/src/affordability/turn-arithmetic.test.ts', title: 'prices a turn' },
  ],
  ...over,
});

// The shape a behaviour takes when its core is unprovable for good and the half
// carrying the risk is proven anyway. `docs/CACHING.md` is the repository's
// exemplar of it, and this row is that exemplar written as the ledger carries it.
const partialRow = (over) => ({
  id: 'X-2',
  layer: ['partial'],
  proof: [
    {
      file: 'apps/api/src/whole-app/app-cache-storability.integration.test.ts',
      title: 'stores nothing beyond what the route serving it declared',
    },
  ],
  gap: 'No local runtime consults the platform cache setting, so whether caching happens is unobservable off production for good rather than for now.',
  degradable: 'performance',
  ...over,
});

describe('shapeProblems', () => {
  it('passes a well-formed row', () => {
    expect(shapeProblems([unitRow()])).toEqual([]);
  });

  it('names a duplicated id', () => {
    expect(shapeProblems([unitRow(), unitRow()])).toEqual(['X-1: declared twice']);
  });

  it('names a layer outside the closed set', () => {
    expect(shapeProblems([unitRow({ layer: ['smoke'] })])[0]).toContain('smoke');
  });

  it('names a declared layer its own proof paths do not derive to', () => {
    expect(shapeProblems([unitRow({ layer: ['integration'] })])[0]).toContain('declares');
  });

  it('names a proven row that cites no proof at all', () => {
    expect(shapeProblems([unitRow({ layer: ['unit'], proof: [] })])[0]).toContain('no proof');
  });

  it('names an unproven row that cites a proof anyway', () => {
    expect(shapeProblems([unitRow({ layer: ['none'], gap: 'x' })])[0]).toContain('none');
  });

  it('names a row that calls itself both unproven and proven', () => {
    expect(shapeProblems([unitRow({ layer: ['none', 'unit'], proof: [], gap: 'x' })])[0]).toContain(
      'among several'
    );
  });

  it('names an unproven row that does not say what is unproven', () => {
    expect(shapeProblems([unitRow({ layer: ['none'], proof: [] })])[0]).toContain('gap');
  });

  it('passes a partly-proven row carrying its gap, its degradable class, and its proof', () => {
    expect(shapeProblems([partialRow()])).toEqual([]);
  });

  it('names a partly-proven row that does not say why its core is unprovable', () => {
    expect(shapeProblems([partialRow({ gap: undefined })])[0]).toContain('unprovable');
  });

  it('names a partly-proven row that declares no degradable class', () => {
    expect(shapeProblems([partialRow({ degradable: undefined })])[0]).toContain('degradable class');
  });

  it('names a partly-proven row whose unproven core is one that must never degrade', () => {
    expect(shapeProblems([partialRow({ degradable: 'settlement' })])[0]).toContain(
      'not a degradable class'
    );
  });

  it('names a partly-proven row that cites no proof of the half it claims to prove', () => {
    expect(shapeProblems([partialRow({ proof: [] })])[0]).toContain('cite');
  });

  it('names a row that calls itself both partly proven and proven outright', () => {
    expect(shapeProblems([partialRow({ layer: ['partial', 'integration'] })])[0]).toContain(
      'among several'
    );
  });

  it('names a proof carrying neither a test title nor a symbol', () => {
    expect(
      shapeProblems([
        unitRow({
          proof: [{ file: 'packages/shared/src/affordability/turn-arithmetic.test.ts' }],
        }),
      ])[0]
    ).toContain('title');
  });

  it('names a proof carrying both, since only one of them is resolved', () => {
    expect(
      shapeProblems([
        unitRow({
          proof: [
            {
              file: 'packages/shared/src/affordability/turn-arithmetic.test.ts',
              title: 'prices a turn',
              symbol: 'priceTurn',
            },
          ],
        }),
      ])[0]
    ).toContain('title');
  });

  it('names a test file anchored on a symbol, where the test it means is nameable', () => {
    expect(
      shapeProblems([
        unitRow({
          proof: [
            {
              file: 'packages/shared/src/affordability/turn-arithmetic.test.ts',
              symbol: 'priceTurn',
            },
          ],
        }),
      ])[0]
    ).toContain('symbol');
  });

  it('names a source file anchored on a test title, which it cannot be running', () => {
    expect(
      shapeProblems([
        unitRow({
          layer: ['type'],
          proof: [
            { file: 'packages/shared/src/affordability/turn-types.ts', title: 'prices a turn' },
          ],
        }),
      ])[0]
    ).toContain('declares no test');
  });

  it('passes a source-file proof anchored on the symbol that carries the guarantee', () => {
    expect(
      shapeProblems([
        unitRow({
          layer: ['type'],
          proof: [
            { file: 'packages/shared/src/affordability/turn-types.ts', symbol: 'Availability' },
          ],
        }),
      ])
    ).toEqual([]);
  });
});

describe('parseBehaviourIds', () => {
  it('reads an id from its bold declaration', () => {
    expect(parseBehaviourIds('**FUND-1 — Money is a nano-USD bigint.**')).toEqual(['FUND-1']);
  });

  it('expands a declaration that covers a run of ids', () => {
    expect(parseBehaviourIds('**FUND-6 through FUND-9 — the funding vocabulary.**')).toEqual([
      'FUND-6',
      'FUND-7',
      'FUND-8',
      'FUND-9',
    ]);
  });

  it('reads a sub-lettered id', () => {
    expect(parseBehaviourIds('**NR-9b — the second refusal notice.**')).toEqual(['NR-9b']);
  });

  it('reads a code-derived id from its heading', () => {
    expect(parseBehaviourIds('### B01 — Admission is a single atomic Redis script')).toEqual([
      'B01',
    ]);
  });

  it('does not read an id out of a mid-sentence cross-reference', () => {
    expect(parseBehaviourIds('The sharp edge here is the one TIER-4/5 names.')).toEqual([]);
  });
});

describe('applyDecompositions', () => {
  it('replaces a declared id with the rows it decomposes into', () => {
    expect(applyDecompositions(['WCL-4', 'WCL-5'], { 'WCL-5': ['WCL-5a', 'WCL-5b'] })).toEqual([
      'WCL-4',
      'WCL-5a',
      'WCL-5b',
    ]);
  });

  it('refuses a decomposition of an id the source never declared', () => {
    expect(() => applyDecompositions(['WCL-4'], { 'WCL-9': ['WCL-9a'] })).toThrow('WCL-9');
  });
});

describe('testTitlesIn', () => {
  it('reads a single-line test title', () => {
    expect(testTitlesIn("test('sends a message', async () => {})")).toContain('sends a message');
  });

  it('reads a title that sits on its own line under a wrapped call', () => {
    expect(
      testTitlesIn("test(\n  'reserves the owner funds',\n  MATRIX,\n  async () => {}\n)")
    ).toContain('reserves the owner funds');
  });

  it('reads an `it` title, which is what the unit suites use', () => {
    expect(testTitlesIn("it('prices the input leg', () => {})")).toContain('prices the input leg');
  });

  it('reads a modifier that still runs the test', () => {
    expect(testTitlesIn("test.concurrent('settles the turn', () => {})")).toContain(
      'settles the turn'
    );
  });

  it('does not read a skipped title, which runs nothing and so proves nothing', () => {
    expect(testTitlesIn("test.skip('parked', () => {})")).not.toContain('parked');
  });

  it('does not read a todo title, which names a test that has no body yet', () => {
    expect(testTitlesIn("it.todo('not written yet')")).not.toContain('not written yet');
  });

  it('reads the plain titles beside a parameterized call it cannot resolve', () => {
    const titles = testTitlesIn(
      "it.each([1, 2])('prices %i legs', () => {})\nit('prices one leg', () => {})"
    );
    expect([...titles]).toEqual(['prices one leg']);
  });

  it('reads a double-quoted title carrying an apostrophe', () => {
    expect(testTitlesIn('test("the owner\'s funds fall", () => {})')).toContain(
      "the owner's funds fall"
    );
  });

  it('does not read a describe block as a test title', () => {
    expect(testTitlesIn("describe('Multi-Model', () => {})")).not.toContain('Multi-Model');
  });
});

describe('symbolAppearsIn', () => {
  it('finds the declaration it names', () => {
    expect(symbolAppearsIn('export type Availability = { available: true }', 'Availability')).toBe(
      true
    );
  });

  it('does not find it inside a longer identifier that merely ends the same way', () => {
    expect(symbolAppearsIn('readonly rows: DimensionAvailability[]', 'Availability')).toBe(false);
  });

  it('does not find it inside a longer identifier that merely starts the same way', () => {
    expect(symbolAppearsIn('const payerTierLabel = 1', 'payerTier')).toBe(false);
  });

  it('finds a phrase anchor whose edges are punctuation', () => {
    expect(
      symbolAppearsIn(
        '  readonly runnable: NonEmpty<ModelEntry>;',
        'runnable: NonEmpty<ModelEntry>'
      )
    ).toBe(true);
  });
});

describe('proofProblems', () => {
  const io = {
    exists: (file) => file !== 'e2e/gone.spec.ts' && file !== 'packages/gone.test.ts',
    read: () => "export type Spendable = number;\ntest('a title that exists', () => {})",
  };

  it('names a proof file that no longer exists', () => {
    expect(
      proofProblems([{ id: 'X-1', proof: [{ file: 'packages/gone.test.ts' }] }], io)[0]
    ).toContain('packages/gone.test.ts');
  });

  it('names an e2e title that no longer exists in its spec', () => {
    const problems = proofProblems(
      [{ id: 'X-2', proof: [{ file: 'e2e/live.spec.ts', title: 'a title that was renamed' }] }],
      io
    );
    expect(problems[0]).toContain('a title that was renamed');
  });

  it('names the running requirement when the cited title is present but parked', () => {
    const parkedIo = {
      exists: () => true,
      read: () => "test.skip('a parked title', () => {})",
    };
    expect(
      proofProblems(
        [{ id: 'X-7', proof: [{ file: 'e2e/live.spec.ts', title: 'a parked title' }] }],
        parkedIo
      )[0]
    ).toBe('X-7: e2e/live.spec.ts has no running test titled "a parked title"');
  });

  it('is silent when the file exists and carries the cited title', () => {
    expect(
      proofProblems(
        [{ id: 'X-3', proof: [{ file: 'e2e/live.spec.ts', title: 'a title that exists' }] }],
        io
      )
    ).toEqual([]);
  });

  it('does not read a file it has already reported as missing', () => {
    expect(
      proofProblems([{ id: 'X-4', proof: [{ file: 'e2e/gone.spec.ts', title: 'anything' }] }], io)
    ).toHaveLength(1);
  });

  it('names a symbol the file no longer declares', () => {
    const problems = proofProblems(
      [
        {
          id: 'X-5',
          proof: [{ file: 'packages/live.ts', symbol: 'export type Availability' }],
        },
      ],
      io
    );
    expect(problems[0]).toContain('export type Availability');
  });

  it('is silent when the file still declares the cited symbol', () => {
    expect(
      proofProblems(
        [{ id: 'X-6', proof: [{ file: 'packages/live.ts', symbol: 'export type Spendable' }] }],
        io
      )
    ).toEqual([]);
  });
});

describe('the behaviour ledger', () => {
  const ledger = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'behaviour-ledger.json'), 'utf8')
  );
  const io = {
    exists: (file) => fs.existsSync(path.join(repoRoot, file)),
    read: (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'),
  };

  // The id set is parsed out of the enumeration the ledger names as its
  // source, never counted by hand: a hand-typed census is a second copy of that
  // document, and a second copy is free to drift from it silently — which is
  // exactly how this check first shipped passing over a behaviour with no row.
  const enumerated = applyDecompositions(
    parseBehaviourIds(io.read(ledger.census.source)),
    ledger.census.decompositions
  );

  it('parses an enumeration far larger than any single block, so a silent empty parse cannot pass', () => {
    expect(enumerated.length).toBeGreaterThan(250);
  });

  it('carries a row for every enumerated behaviour, and none it does not enumerate', () => {
    expect(censusProblems({ '': enumerated }, ledger.rows)).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it('holds rows whose shape and declared layer agree with their own proofs', () => {
    expect(shapeProblems(ledger.rows)).toEqual([]);
  });

  it('names, in every row, files that exist and proofs that resolve inside them', () => {
    expect(proofProblems(ledger.rows, io)).toEqual([]);
  });
});
