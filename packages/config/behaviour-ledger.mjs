/**
 * The checks behind `behaviour-ledger.json` — the map from each enumerated
 * billing behaviour to the gate that would catch its break.
 *
 * The ledger is a claim about the tree, so every part of it that the tree can
 * falsify is resolved here on every run: the file a row cites, the anchor
 * inside it (a test by its title, a compiler-enforced declaration by its
 * symbol), the id set itself (parsed from the enumeration the ledger names as
 * its source, so a behaviour with no row cannot pass), and the layer a row
 * declares (derived back out of its own proof paths, so a proof that migrates
 * layers reddens its row). What no check can reach is whether a named test
 * still asserts the behaviour — a gutted body under a surviving title resolves
 * green, which is why rows cite a test a reader can open, not a grade.
 */

const LAYER_BY_PATH = [
  [/^e2e\/.*\.spec\.[cm]?tsx?$/, 'e2e'],
  [/\.integration\.test\.[cm]?tsx?$/, 'integration'],
  [/^packages\/config\/(?:arch\/rules|eslint-extensions\/rules)\//, 'arch'],
  [/\.(?:test|spec)\.[cm]?[jt]sx?$/, 'unit'],
];

/** The layer a proof file belongs to, read off its path alone. */
export function layerOfProofFile(file) {
  for (const [pattern, layer] of LAYER_BY_PATH) if (pattern.test(file)) return layer;
  // A cited source file rather than a test: the guarantee is the declaration
  // itself, and the gate that catches its break is the compiler.
  return 'type';
}

const KNOWN_LAYERS = new Set(['unit', 'integration', 'e2e', 'arch', 'type', 'none', 'partial']);

// The failure classes a behaviour is allowed to leave permanently unproven: the
// best-effort ones `docs/CODE-RULES.md` §Error Handling says may degrade — a
// response that is slow, a message that does not arrive, an observation that is
// not retained. Money, auth and persistence are absent because they fail fast
// and never degrade, so a core of theirs is unproven rather than unprovable and
// the row that carries it states a gap instead.
const DEGRADABLE_CLASSES = new Set(['performance', 'delivery', 'telemetry']);

/** Every id a census declares, as `prefix + suffix`. */
export function expandEnumeration(census) {
  const ids = [];
  for (const [prefix, declared] of Object.entries(census)) {
    const suffixes =
      typeof declared === 'number'
        ? Array.from({ length: declared }, (_, index) => String(index + 1))
        : declared;
    for (const suffix of suffixes) {
      const id = `${prefix}${suffix}`;
      if (ids.includes(id)) throw new Error(`behaviour census declares ${id} twice`);
      ids.push(id);
    }
  }
  return ids;
}

// An id is declared by a bold line opening the entry that defines it, or by a
// heading for the code-derived entries — never by a cross-reference in prose,
// which is why the pattern is anchored at the start of the line.
const DECLARATION = /^(?:\*\*|### )([A-Z]+-\d+[a-z]?|B\d{2})(?=[\s—])(.*)/;
const RANGE = /^\s+through\s+[A-Z]+-(\d+)/;

/** Every behaviour id an enumeration document declares, ranges expanded. */
export function parseBehaviourIds(text) {
  const ids = [];
  for (const line of text.split('\n')) {
    const declaration = line.match(DECLARATION);
    if (declaration === null) continue;
    const range = declaration[2].match(RANGE);
    if (range === null) {
      ids.push(declaration[1]);
      continue;
    }
    const [prefix, first] = declaration[1].split('-');
    for (let n = Number(first); n <= Number(range[1]); n += 1) ids.push(`${prefix}-${n}`);
  }
  return ids;
}

/**
 * Some enumerated behaviours state several independently-provable clauses, and
 * are carried as one row per clause. The split is declared, not guessed, and
 * the id it splits must be one the source actually declares.
 */
export function applyDecompositions(ids, decompositions) {
  for (const id of Object.keys(decompositions))
    if (!ids.includes(id))
      throw new Error(`behaviour census decomposes ${id}, which is not declared`);
  return ids.flatMap((id) => decompositions[id] ?? [id]);
}

/** The two directions of "every enumerated behaviour has exactly one row". */
export function censusProblems(census, rows) {
  const enumerated = expandEnumeration(census);
  const carried = new Set(rows.map((row) => row.id));
  return {
    missing: enumerated.filter((id) => !carried.has(id)),
    unexpected: [...carried].filter((id) => !enumerated.includes(id)),
  };
}

function unprovenRowProblems(row, declared) {
  const problems = [];
  if (declared.length > 1) problems.push(`${row.id}: none cannot be one layer among several`);
  if (row.proof.length > 0) problems.push(`${row.id}: layer none cannot cite a proof`);
  if (row.gap === undefined || row.gap === '')
    problems.push(`${row.id}: layer none must state its gap`);
  return problems;
}

/**
 * A behaviour whose core no test can ever reach, whose risk-carrying half is
 * proven anyway. The three parts are one claim and are required together: drop
 * the gap and "unprovable" is an assertion nobody has to defend, drop the class
 * and the unreachable half could be one that must never fail, drop the proof
 * and the row is simply unproven and belongs at layer none.
 */
function partlyProvenRowProblems(row, declared) {
  const problems = [];
  if (declared.length > 1) problems.push(`${row.id}: partial cannot be one layer among several`);
  if (row.gap === undefined || row.gap === '')
    problems.push(`${row.id}: layer partial must state why its core is permanently unprovable`);
  if (row.degradable === undefined)
    problems.push(
      `${row.id}: layer partial must declare the degradable class of its unproven core`
    );
  else if (!DEGRADABLE_CLASSES.has(row.degradable))
    problems.push(`${row.id}: ${row.degradable} is not a degradable class`);
  if (row.proof.length === 0)
    problems.push(`${row.id}: layer partial must cite the proof of the half it does prove`);
  for (const proof of row.proof) problems.push(...anchorProblems(row.id, proof));
  return problems;
}

function provenRowProblems(row, declared) {
  if (row.proof.length === 0)
    return [`${row.id}: proven at ${declared.join('+')} but cites no proof`];
  const problems = [];
  const derived = [...new Set(row.proof.map((proof) => layerOfProofFile(proof.file)))].toSorted();
  if (derived.join('+') !== declared.join('+'))
    problems.push(
      `${row.id}: declares ${declared.join('+')} but its proofs are ${derived.join('+')}`
    );
  for (const proof of row.proof) problems.push(...anchorProblems(row.id, proof));
  return problems;
}

// A proof resolves inside its file or it resolves nothing: a test by the title
// that runs it, a compiler-enforced declaration by the symbol that carries it.
// Naming a file alone certifies a file that has been cut down to a no-op.
function anchorProblems(id, proof) {
  const isTest = layerOfProofFile(proof.file) !== 'type';
  if ((proof.title === undefined) === (proof.symbol === undefined))
    return [`${id}: ${proof.file} needs exactly one of the test title or the symbol it proves by`];
  if (isTest && proof.title === undefined)
    return [`${id}: ${proof.file} is a test file, so name the test title, not a symbol`];
  if (!isTest && proof.symbol === undefined)
    return [`${id}: ${proof.file} declares no test, so name the symbol that carries the guarantee`];
  return [];
}

function layerShapeProblems(row, declared) {
  if (declared.includes('none')) return unprovenRowProblems(row, declared);
  if (declared.includes('partial')) return partlyProvenRowProblems(row, declared);
  return provenRowProblems(row, declared);
}

function rowShapeProblems(row) {
  const declared = row.layer.toSorted();
  const unknown = declared
    .filter((layer) => !KNOWN_LAYERS.has(layer))
    .map((layer) => `${row.id}: layer ${layer} is not a known layer`);
  return [...unknown, ...layerShapeProblems(row, declared)];
}

/** Everything wrong with the rows that reading the rows alone can establish. */
export function shapeProblems(rows) {
  const problems = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`${row.id}: declared twice`);
    seen.add(row.id);
    problems.push(...rowShapeProblems(row));
  }
  return problems;
}

// Playwright and vitest titles alike, including a title that sits on its own
// line under a wrapped call. The modifier chain is captured rather than
// discarded so that a parked test can be refused below. A parameterized title
// is unresolvable either way, because `.each` puts its cases where this pattern
// requires the title. `describe` is deliberately absent: a ledger row names the
// test that fails, not the block it sits in.
const TITLE_CALL = /(?:^|[\s;{(])(?:test|it)((?:\.\w+)*)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/gs;

const PARKED_MODIFIER = /\.(?:skip|todo)\b/;

/**
 * Every test title a spec or test file spells out as a quoted literal in its
 * call's first argument position, less those whose own call carries a
 * {@link PARKED_MODIFIER}: such a call runs nothing, so a row citing one
 * reddens rather than resolving. A call parked by the block enclosing it still
 * resolves — {@link TITLE_CALL} reads the call, never the block.
 */
export function testTitlesIn(source) {
  return new Set(
    [...source.matchAll(TITLE_CALL)]
      .filter((match) => !PARKED_MODIFIER.test(match[1]))
      .map((match) => match[3])
  );
}

const escape = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Whole-symbol, never substring: `Availability` must not resolve against
 * `DimensionAvailability`, or renaming the declaration away leaves the row
 * green on a neighbour that happens to end the same way.
 */
export function symbolAppearsIn(text, symbol) {
  const before = /^[\w$]/.test(symbol) ? String.raw`(?<![\w$])` : '';
  const after = /[\w$]$/.test(symbol) ? String.raw`(?![\w$])` : '';
  return new RegExp(`${before}${escape(symbol)}${after}`).test(text);
}

function proofProblem(id, proof, io, titles) {
  if (!io.exists(proof.file)) return `${id}: ${proof.file} does not exist`;
  if (proof.symbol !== undefined)
    return symbolAppearsIn(io.read(proof.file), proof.symbol)
      ? undefined
      : `${id}: ${proof.file} no longer declares ${proof.symbol}`;
  if (!titles.has(proof.file)) titles.set(proof.file, testTitlesIn(io.read(proof.file)));
  return titles.get(proof.file).has(proof.title)
    ? undefined
    : `${id}: ${proof.file} has no running test titled "${proof.title}"`;
}

/** Everything wrong with the rows that only the tree can establish. */
export function proofProblems(rows, io) {
  const titles = new Map();
  return rows.flatMap((row) =>
    row.proof
      .map((proof) => proofProblem(row.id, proof, io, titles))
      .filter((problem) => problem !== undefined)
  );
}
