/**
 * The extensions a specifier writes that are dropped before it resolves: the
 * repo's own `./x.js`, and the `.ts`/`.tsx` an `allowImportingTsExtensions`
 * spelling writes. Any other extension stays on the specifier, for the reader
 * resolving it to judge rather than for this to guess at.
 *
 * One definition because every reader that resolves a repo specifier strips the
 * same set, and a spelling one reader drops while another keeps takes every
 * module behind it out of one answer while both read clean — silently, because
 * a guard whose resolver stops resolving reports nothing at all rather than
 * something wrong.
 *
 * `.mjs` rather than `.ts` because ESLint loads a vendored rule as a plain Node
 * module, with no TypeScript loader in front of it.
 */
export const WRITTEN_EXTENSIONS = /\.[jt]sx?$/;
