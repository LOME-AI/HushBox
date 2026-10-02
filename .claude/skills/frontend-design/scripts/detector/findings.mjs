import { getAntipattern } from './registry/antipatterns.mjs';

/**
 * One reported anti-pattern, as every engine emits it and every consumer reads
 * it. `engine` is stamped at an engine's exit and `importedBy` by the directory
 * scan, so each is absent on a finding that has not passed through its stamper.
 *
 * @typedef {{
 *   antipattern: string,
 *   name: string,
 *   description: string,
 *   severity: string,
 *   file: string,
 *   line: number,
 *   snippet: string,
 *   engine?: string,
 *   importedBy?: string[],
 * }} Finding
 */

/**
 * The two analysis engines a finding can come out of, spelled the way
 * `RULE_ENGINE_SUPPORT` in registry/antipatterns.mjs spells them — that map is
 * the vocabulary of record for engine names, so a finding's stamp and the
 * registry's per-engine rule sets cannot drift into naming different things.
 */
const ENGINE_STATIC_HTML = 'static-html';
const ENGINE_REGEX = 'regex';

/** @param {string} id */
function getAP(id) {
  return getAntipattern(id);
}

/**
 * @param {string} id
 * @param {string} filePath
 * @param {string} snippet
 * @param {number} [line]
 * @returns {Finding}
 */
function finding(id, filePath, snippet, line = 0) {
  const ap = getAP(id);
  // An id with no registry entry must not crash the whole scan. Degrade to a
  // minimal finding that still carries the id, snippet, and location.
  if (!ap) {
    return { antipattern: id, name: id, description: '', severity: 'warning', file: filePath, line, snippet };
  }
  return { antipattern: id, name: ap.name, description: ap.description, severity: ap.severity || 'warning', file: filePath, line, snippet };
}

/**
 * Stamp each finding with the engine whose run emitted it.
 *
 * Called at each engine's single exit, after provider filtering, dedup and
 * inline ignores have already decided what is reported — so `engine` reaches no
 * predicate that can change a verdict, and adding it cannot move a finding in or
 * out of the output.
 */
/**
 * @param {Finding[]} findings
 * @param {string} engine
 */
function stampEngine(findings, engine) {
  for (const item of findings) item.engine = engine;
  return findings;
}

export { ENGINE_REGEX, ENGINE_STATIC_HTML, getAP, finding, stampEngine };
