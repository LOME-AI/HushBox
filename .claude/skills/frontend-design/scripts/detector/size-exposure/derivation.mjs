// WHICH REGISTERED IDS A MODELLED FONT SIZE CAN REACH — derived from the source,
// not counted from a take.
//
// WHY THIS EXISTS. The empirical sweep beside this file can only ever be evidence
// about the shapes its population contains. Four rules were missed by three
// successive readings and by a population of twenty shapes, and every miss had
// the same form: nobody could say which rules the population still had to cover,
// so a population that covered thirteen ids read as complete. A count cannot
// distinguish "this rule does not read a size" from "no page here made this rule
// run". This file computes the set the population has to cover, so the sweep can
// fail when it does not.
//
// WHAT IS DERIVED. Every module the static-HTML engine can load is found by
// following its relative imports transitively from its entry point. Each module
// is parsed, and every registered antipattern id emitted anywhere in that module
// set is located at its emitting function. Two facts are then computed per id
// from the call graph:
//
//   AT-SITE     a font size is in scope in the emitting function itself, so the
//               size can appear in the verdict or in the condition beside it.
//   FED         the emitting function is handed a size-derived value by one of
//               its callers, so the size can decide whether the emission happens
//               even though no size is in scope where it does. This is the case
//               the readings kept missing: the kicker verdict emits from a
//               function holding no size at all, and the size that gates it is
//               read one call above and travels in the candidate list.
//
// An id with neither fact cannot move when a modelled size changes, and the
// sweep asserts that it does not. An id with either fact MAY move, and the sweep
// requires it to either move or carry a stated reason why it cannot — an
// unexplained member is the gap that hid four movers, and it stops the sweep.
//
// FED IS AN ARGUMENT-LEVEL DATAFLOW, NOT REACHABILITY. Plain reachability from a
// size-handling function was tried first and is useless here: it marks all
// forty-five, because the engine's entry point handles a size and calls every
// rule. What is propagated instead is a value — a call marks its callee only when
// one of that call's own arguments carries a size, where an argument carries a
// size if its text names one, or is a local bound to an expression that does, or
// is a call to a function already marked. The fixpoint over that relation is the
// set below.
//
// IT STILL OVER-APPROXIMATES, IN THE SAFE DIRECTION: a function handed a size
// among several inputs is marked whether or not the branch reaching a given
// emission consults it, so ids that provably cannot move are admitted. Each of
// those costs one stated reason. The opposite error — a mover outside the set —
// is the one that went unnoticed through three successive readings, and the
// sweep throws on it.
//
// WHAT IT DOES NOT SEE, stated rather than left to be discovered:
//   - a size arriving through a value the analysis cannot name: a property read
//     off an object built in another module, or a callee held in a variable. The
//     empirical half is what covers this, and the two halves check each other.
//   - the regex engine's own entry point. The static engine imports that module
//     and runs its text-content analyzers, so those ids are in the module set and
//     are classified like any other.
//
// Usage:
//   node <this file> [--out <tsv path>]   # the table
//   import { admittedIds } from './derivation.mjs'   # the set, for the sweep

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { ANTIPATTERNS } from '../registry/antipatterns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The tree this file parses, one level up: it is a sibling of the engine it reads. */
const DETECTOR = path.dirname(HERE);
const ENTRY = path.join(DETECTOR, 'engines', 'static-html', 'detect-html.mjs');
const REGISTRY_REL = path.relative(DETECTOR, path.join(DETECTOR, 'registry', 'antipatterns.mjs'));

/** An identifier naming a font size, in every spelling the rule modules use. */
const SIZE_NAME = /fontsize/i;

/**
 * Every module the static-HTML engine can load, by following relative imports
 * from its entry point. Derived rather than listed: a module added to the engine
 * joins this set without anyone editing it.
 *
 * @param {string} entry
 * @returns {string[]}
 */
function moduleSet(entry) {
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = parse(file);
    for (const spec of relativeImports(source)) {
      queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  return [...seen].sort();
}

/** @param {string} file */
function parse(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf-8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS
  );
}

/**
 * @param {ts.SourceFile} source
 * @returns {string[]}
 */
function relativeImports(source) {
  /** @type {string[]} */
  const out = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (node.moduleSpecifier.text.startsWith('.')) out.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const text = node.arguments[0].text;
      if (text.startsWith('.')) out.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** @param {ts.Node} node */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * The name a function is called by. A declaration carries its own; an arrow or a
 * function expression takes the name of the binding it is assigned to, which is
 * how every callee in these modules is written.
 *
 * @param {ts.Node} node
 * @returns {string | null}
 */
function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/**
 * The derivation.
 *
 * @param {readonly string[]} registeredIds
 */
function deriveSizeExposure(registeredIds) {
  const modules = moduleSet(ENTRY);

  /** Every function-like node, keyed. @type {Map<string, { name: string | null, node: ts.Node, file: string }>} */
  const functions = new Map();
  /** name -> keys, so a call by name can find its targets. @type {Map<string, string[]>} */
  const byName = new Map();
  /** key -> the keys it calls. @type {Map<string, Set<string>>} */
  const calls = new Map();
  /** keys whose own body handles a font size. @type {Set<string>} */
  const handlesSize = new Set();
  /** id -> emitting keys. @type {Map<string, Set<string>>} */
  const emits = new Map();
  /** id -> the module files it is emitted from. @type {Map<string, Set<string>>} */
  const emitFiles = new Map();

  /** @type {{ source: ts.SourceFile, file: string }[]} */
  const parsed = modules.map((file) => ({ source: parse(file), file }));

  // Pass 1 — index every function, and record which handle a size and which emit an id.
  for (const { source, file } of parsed) {
    const rel = path.relative(DETECTOR, file);
    /** @type {string[]} */
    const stack = [];
    /** @param {ts.Node} node */
    const visit = (node) => {
      let pushed = false;
      if (isFunctionLike(node)) {
        const name = functionName(node);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const key = `${rel}#${name ?? '<anonymous>'}@${line}`;
        functions.set(key, { name, node, file: rel });
        if (name) byName.set(name, [...(byName.get(name) ?? []), key]);
        stack.push(key);
        pushed = true;
      }
      const here = stack[stack.length - 1] ?? `${rel}#<module>`;
      if (!functions.has(here) && here.endsWith('#<module>')) {
        functions.set(here, { name: null, node: source, file: rel });
      }

      // A size handled here: any identifier or property named for a font size.
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && SIZE_NAME.test(node.getText(source))) {
        handlesSize.add(here);
      }
      if (ts.isStringLiteral(node) && SIZE_NAME.test(node.text.replace('-', ''))) {
        handlesSize.add(here);
      }

      // An emission: `{ id: '<x>' }` or `finding('<x>', ...)`.
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        (node.name.text === 'id' || node.name.text === 'antipattern') &&
        ts.isStringLiteral(node.initializer)
      ) {
        record(node.initializer.text, [...stack, here], rel);
      }
      // The other emission shape: a helper that takes the id as its first
      // argument. `finding(...)` in the text analyzers and `makeDesignFinding(...)`
      // in the design-system module are both written this way, and matching the
      // shape rather than the two names keeps a third helper from being missed.
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        record(node.arguments[0].text, [...stack, here], rel);
      }

      ts.forEachChild(node, visit);
      if (pushed) stack.pop();
    };
    /**
     * The emitting site is the whole chain of functions the emission sits inside,
     * not the innermost one. A verdict built inside a `.map()` callback emits from
     * an anonymous arrow that nothing calls by name, and the size that gates it is
     * held by the named function around it — which is where the kicker verdict
     * lives, and why an innermost-only reading called it unable to move while a
     * driven page showed it moving.
     *
     * @param {string} id
     * @param {string[]} chain
     * @param {string} rel
     */
    function record(id, chain, rel) {
      if (!registeredIds.includes(id)) return;
      // The registry declares every id as a literal. Those are the definitions
      // the whole table is keyed by, not emissions, and counting them would make
      // all forty-five look emitted from one module scope.
      if (rel === REGISTRY_REL) return;
      const set = emits.get(id) ?? new Set();
      for (const key of chain) set.add(key);
      emits.set(id, set);
      emitFiles.set(id, (emitFiles.get(id) ?? new Set()).add(rel));
    }
    visit(source);
  }

  // Pass 2 — the call graph, by callee name.
  for (const [key, { node, file }] of functions) {
    /** @type {Set<string>} */
    const out = new Set();
    const source = node.getSourceFile();
    /** @param {ts.Node} n */
    const visit = (n) => {
      if (isFunctionLike(n) && n !== node) {
        // A nested function's calls belong to the nested function, which is
        // indexed under its own key.
        const nestedName = functionName(n);
        const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
        const nestedKey = `${file}#${nestedName ?? '<anonymous>'}@${line}`;
        if (functions.has(nestedKey)) {
          out.add(nestedKey);
          return;
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        for (const target of byName.get(n.expression.text) ?? []) out.add(target);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    calls.set(key, out);
  }

  // Pass 3 — FED: an argument-level fixpoint. A call marks its callee only when
  // one of that call's arguments carries a size.
  /** @type {Set<string>} */
  const fed = new Set(handlesSize);
  /** @type {Map<string, { node: ts.Node, source: ts.SourceFile, file: string }>} */
  const bodies = new Map();
  for (const [key, value] of functions) {
    bodies.set(key, { node: value.node, source: value.node.getSourceFile(), file: value.file });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, { node, source }] of bodies) {
      /** Locals bound to a size-derived initializer, inside this function. @type {Set<string>} */
      const aliases = new Set();
      /** @param {ts.Node} expr @returns {boolean} */
      const carriesSize = (expr) => {
        let found = false;
        /** @param {ts.Node} n */
        const walk = (n) => {
          if (found) return;
          if (ts.isIdentifier(n)) {
            if (SIZE_NAME.test(n.text) || aliases.has(n.text)) found = true;
          }
          if (ts.isPropertyAccessExpression(n) && SIZE_NAME.test(n.name.text)) found = true;
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
            for (const target of byName.get(n.expression.text) ?? []) {
              if (fed.has(target)) found = true;
            }
          }
          if (!found) ts.forEachChild(n, walk);
        };
        walk(expr);
        return found;
      };

      // Two sweeps of the body: the first collects aliases, the second reads the
      // calls, so a local declared before a call is seen by it. A local declared
      // after the call it feeds does not exist in this language.
      /** @param {ts.Node} n */
      const collect = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          if (carriesSize(n.initializer)) aliases.add(n.name.text);
        }
        ts.forEachChild(n, collect);
      };
      ts.forEachChild(node, collect);

      /** @param {ts.Node} n */
      const propagate = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const targets = byName.get(n.expression.text) ?? [];
          if (targets.length && n.arguments.some((a) => carriesSize(a))) {
            for (const target of targets) {
              if (!fed.has(target)) {
                fed.add(target);
                changed = true;
              }
            }
          }
        }
        ts.forEachChild(n, propagate);
      };
      ts.forEachChild(node, propagate);
      void key;
      void source;
    }
  }

  /** @type {Map<string, { atSite: boolean, upstream: boolean, emitted: boolean, sites: string[], files: string[] }>} */
  const table = new Map();
  for (const id of registeredIds) {
    const sites = [...(emits.get(id) ?? [])];
    table.set(id, {
      emitted: sites.length > 0,
      atSite: sites.some((s) => handlesSize.has(s)),
      upstream: sites.some((s) => fed.has(s)),
      sites: sites.sort(),
      files: [...(emitFiles.get(id) ?? [])].sort(),
    });
  }
  return { table, modules: modules.map((m) => path.relative(DETECTOR, m)), functionCount: functions.size };
}

/**
 * The ids a modelled size can reach, as the set the sweep grades against.
 *
 * @returns {Set<string>}
 */
function admittedIds() {
  const { table } = deriveSizeExposure(ANTIPATTERNS.map((a) => a.id));
  return new Set(
    [...table.entries()].filter(([, row]) => row.atSite || row.upstream).map(([id]) => id)
  );
}

export { admittedIds, deriveSizeExposure };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ids = ANTIPATTERNS.map((a) => a.id);
  const { table, modules, functionCount } = deriveSizeExposure(ids);
  const rows = [['id', 'emittedByThisEngine', 'sizeAtSite', 'sizeFedByCaller', 'mayMove', 'emittingFunctions'].join('\t')];
  for (const id of ids) {
    const r = /** @type {NonNullable<ReturnType<typeof table.get>>} */ (table.get(id));
    rows.push(
      [
        id,
        r.emitted ? 'yes' : 'no',
        r.atSite ? 'yes' : 'no',
        r.upstream ? 'yes' : 'no',
        r.atSite || r.upstream ? 'MAY MOVE' : 'cannot move',
        r.sites.map((s) => s.split('#')[1]).join(' '),
      ].join('\t')
    );
  }
  const i = process.argv.indexOf('--out');
  const named = i === -1 ? undefined : process.argv[i + 1];
  // A default inside the tree would leave a generated table sitting in a
  // directory the repository governs, for a run nothing but a reader asked for.
  const out = named === undefined ? path.join(os.tmpdir(), 'detector-size-derivation.tsv') : path.resolve(named);
  fs.writeFileSync(out, `${rows.join('\n')}\n`, 'utf-8');
  const may = ids.filter((id) => {
    const r = table.get(id);
    return r && (r.atSite || r.upstream);
  });
  process.stdout.write(
    `modules in the static engine's graph ${modules.length}, functions ${functionCount}\n` +
      `registered ids ${ids.length}; emitted by this engine ${ids.filter((id) => table.get(id)?.emitted).length}\n` +
      `ids a modelled size may move ${may.length}: ${may.join(', ')}\n` +
      `rows written to ${out}\n`
  );
}
