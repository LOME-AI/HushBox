/**
 * `istanbul-lib-coverage` ships no types, and its percentage sits in a module
 * of its own rather than on the package barrel. Only that module is declared:
 * the coverage figures printed here are the library's own percentages, and
 * nothing reaches for the rest of its surface, so an accidental reach for one
 * is a compile error rather than a silent new dependency edge.
 */
declare module 'istanbul-lib-coverage/lib/percent.js' {
  /**
   * The share of `covered` in `total` as a percentage truncated to two
   * decimals, with a `total` of none reading as complete.
   */
  export default function percent(covered: number, total: number): number;
}
