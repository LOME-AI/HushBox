/**
 * The rule keys on which two resolved ESLint configs disagree.
 *
 * An absent entry counts as a value, which is the whole point: a relaxation
 * that reaches one path and not another shows up here as the key of the rule
 * one path still carries. Comparing the whole entry rather than its severity
 * catches an options object that differs under an unchanged severity.
 *
 * Shared rather than spelled at each caller because the two of them compare the
 * same two things and any disagreement between them is a wrong answer on one
 * side. They are split across processes rather than by subject: one resolves a
 * config composed in this process, and a child resolves every tree the walk
 * derives — this package's included — for the coverage reason
 * `packages/config/eslint-config.test.mjs` records.
 *
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {string[]}
 */
export function differingRuleKeys(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}
