// WHICH RULES READ THE SIZE THE DEFAULT STYLESHEET GIVES A `sub`, A `sup` OR A
// `small`.
//
// WHY THIS EXISTS. Two rules were named by two different people looking at this
// question twice, and both lists were reached by reading. A list reached by
// reading is a claim about what somebody noticed; this file is the search that
// closes it, so the answer is a measurement with a stated population instead.
//
// THE STATIC HALF OF THE DERIVATION -- what the search has to cover.
// The modelled value lands in exactly one place: `values['fontSize']` on the
// element's own computed style, inside `computeNode` in the static engine's
// cascade. Everything downstream reaches it through one of three doors, and the
// door list is closed by grep over the detector tree -- no other expression in
// it reads a computed font size:
//
//   door 1  the element's own size, read by `resolveFontSizePx(el, win)` or by
//           `computedFontSizePx(style.fontSize)`;
//   door 2  inheritance -- the cascade hands the element's size to its children
//           as their basis, so any rule reading a DESCENDANT reads it too;
//   door 3  the document-wide walk `collectStaticFontSizes`, which visits every
//           element and feeds the hierarchy rule and the unpriceable-size
//           report.
//
// Each call site of door 1 and door 3 sits behind a gate that decides whether a
// `sub` or a `sup` can occupy the position the size is read from: a selector the
// rule is registered under, an allowlist of tags inside the rule, a skip list,
// or a layout rectangle this engine does not have. The gates are what the shapes
// in `pages.mjs` are built to sit on either side of. Door 2 has no gate at all
// -- anything below the element reads its size -- which is why every shape that
// can be written through a descendant is driven that way too.
//
// THE EMPIRICAL HALF -- this file.
// The population is driven once per arm over the same pages: as the tree stands,
// with the two entries removed from the map, with them set to a ratio far from
// the measured one, and with the `small` entry removed. A rule whose findings
// differ under ANY arm read the size that arm changed. Two arms on the same
// entries rather than one because a rule can read a size and still give the same
// answer at two nearby values, and a removal arm alone would score that as "does
// not read".
//
// `small` rides along because its readers were accounted for by reading too, as
// two, and the same search can say whether that account held.
//
// The `span` column is the control: no arm names it, so a `span` row that moves
// means an arm reached something it did not name. Each arm declares the subjects
// it may move and the sweep refuses a take where one moved any other.
//
// COVERAGE IS DERIVED, NOT COUNTED, and this is what changed after the population
// above was declared closed twice and was twice incomplete. `derivation.mjs`
// computes from the engine's own source which registered ids a modelled size can
// reach; `pages.mjs` answers each of those with a disposition; and this file
// enforces both directions:
//
//   - an id the derivation admits and the population does not answer STOPS the
//     sweep. "Reached thirteen of forty-five" cannot be stated as a result here,
//     because the thirteen was never the number that mattered — the number that
//     mattered was how many of the admitted ids went unexercised, and nothing
//     computed it;
//   - an id the derivation says cannot move, that moves, STOPS the sweep. The
//     derivation is then wrong and the measurement is what says so.
//
// So the two halves check each other, and the failure that hid four movers —
// a population silently missing a shape — is now a thrown error rather than a
// smaller number in a summary line.
//
// `size-exposure.test.mjs` beside this file is what runs both halves on every
// gate run; the entry point below is for reading the tables by hand.
//
// Usage:
//   node <this file> [--out <tsv path>] [--findings <json path>]
//   node <this file> --emit            # one take's findings, as JSON, on stdout

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ANTIPATTERNS } from '../registry/antipatterns.mjs';

import { admittedIds } from './derivation.mjs';
import { SHAPES, SUBJECTS, DISPOSITIONS, pageHtml } from './pages.mjs';
import { SOURCE_MUTATION } from './source-mutation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
/** The map under test, addressed absolutely so no arm depends on a working directory. */
const CASCADE = path.join(HERE, '..', 'engines', 'static-html', 'css-cascade.mjs');

/** @param {string} name @param {string | null} fallback */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/**
 * One take: every finding the static engine emits on every page, keyed by page.
 *
 * @returns {Promise<Record<string, string[]>>}
 */
async function emit() {
  // The arm, if there is one, is installed before the engine is loaded — which
  // is the whole requirement a load hook has.
  if (process.env[SOURCE_MUTATION]) register('./source-mutation.mjs', import.meta.url);
  const { detectHtml } = await import('../engines/static-html/detect-html.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-size-exposure-'));
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const shape of SHAPES) {
    for (const tag of SUBJECTS) {
      const file = path.join(scratch, 'case.html');
      fs.writeFileSync(file, pageHtml(shape, tag), 'utf-8');
      const found = await detectHtml(file, {});
      // A detector whose parsers node cannot resolve falls back to the regex
      // engine silently, and its answer would be graded here as the static
      // engine's. The stamp is asserted on every page for that reason.
      if (!found.some((f) => f.antipattern === 'broken-image' && f.engine === 'static-html')) {
        throw new Error(`the static-HTML engine did not run on ${shape.id}|${tag}`);
      }
      out[`${shape.id}|${tag}`] = found
        .filter((f) => f.antipattern !== 'broken-image')
        .map((f) => `${f.antipattern} ${String(f.snippet ?? '').replace(/\s+/g, ' ')}`)
        .sort();
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  return out;
}

/** The arms. `null` is the tree as it stands. `moves` names the subjects an arm
 *  is allowed to move: an arm edits one map entry, so a row that moves on any
 *  other subject means the mutation reached something the arm did not name. */
const ARMS = [
  { id: 'as-the-tree-stands', spec: null, moves: /** @type {string[]} */ ([]) },
  {
    id: 'the-two-entries-removed',
    moves: ['sub', 'sup'],
    spec: {
      file: CASCADE,
      from: '  sub: SMALLER_KEYWORD,\n  sup: SMALLER_KEYWORD,\n',
      to: '',
    },
  },
  {
    id: 'the-two-entries-at-a-far-ratio',
    moves: ['sub', 'sup'],
    spec: {
      file: CASCADE,
      from: '  sub: SMALLER_KEYWORD,\n  sup: SMALLER_KEYWORD,',
      to: "  sub: '0.4em',\n  sup: '0.4em',",
    },
  },
  {
    id: 'the-small-entry-removed',
    moves: ['small'],
    spec: {
      file: CASCADE,
      from: '  small: SMALLER_KEYWORD,\n',
      to: '',
    },
  },
];

/** The base arm's id: the tree as it stands, which every other arm is read against. */
const BASE = 'as-the-tree-stands';

/**
 * Every arm's take, each from its own child process so the arm's rewritten
 * module never shares an isolate with another arm's.
 *
 * @returns {Promise<Map<string, Record<string, string[]>>>}
 */
async function collectTakes() {
  /** @type {Map<string, Record<string, string[]>>} */
  const takes = new Map();
  for (const armSpec of ARMS) {
    const env = { ...process.env };
    if (armSpec.spec) env[SOURCE_MUTATION] = JSON.stringify(armSpec.spec);
    else delete env[SOURCE_MUTATION];
    // Unpiped: the exit code is the child's own, so a thrown stamp assertion or
    // a non-unique mutation anchor stops the sweep instead of scoring a take
    // that never ran.
    const stdout = execFileSync(process.execPath, [SELF, '--emit'], {
      env,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    takes.set(armSpec.id, JSON.parse(stdout));
  }
  return takes;
}

/**
 * The coverage check, as a function of its inputs so it can be driven on cases
 * other than a real run's. A guard nobody has watched reject anything is a guard
 * by assertion.
 *
 * @param {{ mayMove: Set<string>, dispositions: Record<string, { disposition: string, why: string }>,
 *           moved: Set<string>, ran: Set<string> }} input
 * @returns {string[]}
 */
function coverageFailuresFor({ mayMove, dispositions, moved, ran }) {
  /** @type {string[]} */
  const failures = [];
  for (const id of mayMove) {
    const declared = dispositions[id];
    if (!declared) {
      failures.push(
        `${id}: the derivation says a modelled size can reach this rule and the population does not answer it. ` +
          `Add a shape that straddles its gate, or a disposition saying why it cannot move.`
      );
      continue;
    }
    if (declared.disposition === 'moves' && !moved.has(id)) {
      failures.push(`${id}: declared to move and did not. ${declared.why}`);
    }
    if (declared.disposition === 'runs-declines') {
      if (!ran.has(id)) failures.push(`${id}: declared to run and decline, and no page here ran it.`);
      if (moved.has(id)) failures.push(`${id}: declared to decline and it moved. ${declared.why}`);
    }
    if (declared.disposition === 'cannot-run' && ran.has(id)) {
      failures.push(`${id}: declared unable to run in this engine and it ran. ${declared.why}`);
    }
  }
  for (const id of Object.keys(dispositions)) {
    if (!mayMove.has(id)) {
      failures.push(`${id}: answered here, and the derivation does not admit it. The map is stale.`);
    }
  }
  for (const id of moved) {
    if (!mayMove.has(id)) {
      failures.push(
        `${id}: MOVED, and the derivation says a size cannot reach it. The derivation is wrong, not the page.`
      );
    }
  }
  return failures;
}

/**
 * Grade one set of takes: which verdicts moved, whether any arm reached a
 * subject it does not name, and whether the population answers everything the
 * derivation admits. Throws on each of those three rather than reporting them —
 * a sweep that cannot say what it measured must not print a number.
 *
 * @param {Map<string, Record<string, string[]>>} takes
 * @param {{ dispositions?: Record<string, { disposition: string, why: string }> }} [options]
 */
function grade(takes, options = {}) {
  const dispositions = options.dispositions ?? DISPOSITIONS;
  const base = /** @type {Record<string, string[]>} */ (takes.get(BASE));

  // An arm that changes no page changed nothing at all. It is not a finding
  // about the rules: it is a mutation that did not reach the module, and it
  // would be reported below as every rule declining to read the value.
  for (const armSpec of ARMS) {
    if (armSpec.id === BASE) continue;
    if (JSON.stringify(takes.get(armSpec.id)) === JSON.stringify(base)) {
      throw new Error(`arm ${armSpec.id} produced a take identical to the unmutated one`);
    }
  }

  /** @type {Map<string, { cases: Set<string>, tags: Set<string> }>} */
  const movedBy = new Map();
  /** @type {Set<string>} */
  const reached = new Set();
  /** @type {string[]} */
  const leaks = [];
  const perCaseRows = [['case', 'arm', 'rule', 'asTheTreeStands', 'underTheArm'].join('\t')];

  for (const [key, hereFindings] of Object.entries(base)) {
    const tag = /** @type {string} */ (key.split('|')[1]);
    for (const f of hereFindings) reached.add(/** @type {string} */ (f.split(' ')[0]));
    for (const armSpec of ARMS) {
      if (armSpec.id === BASE) continue;
      const armedTake = takes.get(armSpec.id);
      // Every arm is taken over the same population, so a key present in the
      // base take and missing from an arm's is a take that did not finish.
      if (!armedTake?.[key]) throw new Error(`arm ${armSpec.id} has no take for ${key}`);
      const armed = armedTake[key];
      const rules = new Set([
        ...hereFindings.map((f) => f.split(' ')[0]),
        ...armed.map((f) => f.split(' ')[0]),
      ]);
      for (const rule of rules) {
        if (!rule) continue;
        reached.add(rule);
        const here = hereFindings.filter((f) => f.startsWith(`${rule} `)).join(' | ');
        const there = armed.filter((f) => f.startsWith(`${rule} `)).join(' | ');
        if (here === there) continue;
        const entry = movedBy.get(rule) ?? { cases: new Set(), tags: new Set() };
        entry.cases.add(key);
        entry.tags.add(tag);
        movedBy.set(rule, entry);
        if (!armSpec.moves.includes(tag)) leaks.push(`${armSpec.id} moved ${key} ${rule}`);
        perCaseRows.push([key, armSpec.id, rule, here || '(silent)', there || '(silent)'].join('\t'));
      }
    }
  }

  // A leak means one arm's edit changed a subject that arm does not name, so
  // every verdict below was graded against a mutation whose extent is unknown.
  if (leaks.length) throw new Error(`arms moved subjects they do not name:\n  ${leaks.join('\n  ')}`);

  const mayMove = admittedIds();

  // The engine control fires on every page and is asserted by the stamp check
  // rather than graded, so it is filtered out of every take and cannot appear in
  // `reached`. It is run on all of them by construction.
  const ran = new Set([...reached, 'broken-image']);
  const moved = new Set(movedBy.keys());
  const coverageInput = { mayMove, dispositions, moved, ran };

  const coverageFailures = coverageFailuresFor(coverageInput);
  if (coverageFailures.length) {
    throw new Error(`coverage is not closed:\n  ${coverageFailures.join('\n  ')}`);
  }

  const summaryRows = [
    ['rule', 'verdict', 'sizeCanReach', 'disposition', 'movedOnSubjects', 'movedOnCases'].join('\t'),
  ];
  for (const ap of ANTIPATTERNS) {
    const entry = movedBy.get(ap.id);
    const verdict = entry
      ? 'READS the size'
      : reached.has(ap.id)
        ? 'reached, did not move'
        : 'not reached by this population';
    summaryRows.push(
      [
        ap.id,
        verdict,
        mayMove.has(ap.id) ? 'yes' : 'no',
        dispositions[ap.id]?.disposition ?? '',
        entry ? [...entry.tags].sort().join(',') : '',
        entry ? [...entry.cases].sort().join(' ') : '',
      ].join('\t')
    );
  }

  return { movedBy, reached, ran, mayMove, coverageInput, summaryRows, perCaseRows, pageCount: Object.keys(base).length };
}

export { ARMS, collectTakes, coverageFailuresFor, grade };

/* The entry point below reads the tables by hand; the gate reaches this file
   through the cases beside it, which import the three exports above. */
if (process.argv[1] === SELF) {
  if (process.argv.includes('--emit')) {
    process.stdout.write(JSON.stringify(await emit()));
  } else {
    const takes = await collectTakes();
    const result = grade(takes);
    // A default inside the tree would leave a generated table sitting in a
    // directory the repository governs, for a run nothing but a reader asked for.
    const outPath = path.resolve(/** @type {string} */ (arg('out', path.join(os.tmpdir(), 'detector-size-sweep.tsv'))));
    fs.writeFileSync(outPath, `${result.summaryRows.join('\n')}\n\n${result.perCaseRows.join('\n')}\n`, 'utf-8');
    // Every take, not just the unmutated one: the removal arm's take is this
    // tree's reconstruction of the tree before the two entries were added, and
    // the only way to check that reconstruction is to compare it against a take
    // of the real earlier tree.
    const findingsPath = arg('findings', null);
    if (findingsPath) {
      fs.writeFileSync(path.resolve(findingsPath), JSON.stringify(Object.fromEntries([...takes.entries()])), 'utf-8');
    }
    const readers = [...result.movedBy.keys()].sort();
    /** @param {string} want */
    const bySubject = (want) =>
      [...result.movedBy.entries()]
        .filter(([, v]) => v.tags.has(want))
        .map(([rule]) => rule)
        .sort();
    const counted = (/** @type {string} */ want) =>
      [...result.mayMove].filter((id) => DISPOSITIONS[id]?.disposition === want).length;
    process.stdout.write(
      `pages ${result.pageCount} (${SHAPES.length} shapes x ${SUBJECTS.length} subjects)\n` +
        `registered antipattern ids ${ANTIPATTERNS.length}; a modelled size can reach ${result.mayMove.size} of them, ` +
        `and all ${result.mayMove.size} are answered by the population\n` +
        `  of those: ${counted('moves')} move, ${counted('runs-declines')} run and decline, ` +
        `${counted('cannot-run')} cannot run in this engine\n` +
        `the remaining ${ANTIPATTERNS.length - result.mayMove.size} ids are ones no font size reaches, ` +
        `and none of them moved\n` +
        `rules whose output moves with a modelled size ${readers.length}: ${readers.join(', ')}\n` +
        `  on sub: ${bySubject('sub').join(', ')}\n` +
        `  on sup: ${bySubject('sup').join(', ')}\n` +
        `  on small: ${bySubject('small').join(', ')}\n` +
        `  on span (the control, which must be none): ${bySubject('span').join(', ') || 'none'}\n` +
        `rows written to ${outPath}\n`
    );
  }
}
