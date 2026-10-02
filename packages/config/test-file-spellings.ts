/**
 * How this repository spells a module that exists only so tests can run, and
 * the two renderings of that one answer its readers need.
 *
 * Its readers are the exemptions that turn on "is this a test module" —
 * whichever they are on the day, which the import graph answers and a list
 * here would not. Each used to spell the set itself, and they had already
 * drifted apart: the boundaries perimeter — which both stops holding such a
 * module to its import rules and refuses it as a target for governed code —
 * recognised one extension where the architecture layer recognised every
 * extension a module can be written in, so a test-setup file outside `.ts` was
 * exempt from the rules on one side while reading as ordinary production
 * source on the other.
 *
 * The renderings are derived rather than written out because a glob and a
 * regular expression are two spellings of one set, and a set spelled twice is
 * the drift above one edit later.
 *
 * The file is TypeScript with two import spellings behind it, and which one a
 * reader takes turns on whether a compiler rewrites its specifiers rather than
 * on what the reader is written in. Where one does, it is named
 * `./test-file-spellings.js` as every other module is. Where the specifier
 * reaches Node as written — every `.mjs` module here, and equally a TypeScript
 * one whose loader hands its relative imports straight to Node — it must name
 * the file that is on disk.
 */

/** The name segment marking a module as existing for tests. */
const MARKERS = ['test', 'spec', 'setup'] as const;

/**
 * Every extension a module in this repository can be written in. Exported
 * because the answer is also needed away from the test-module question — the
 * seed's crypto fingerprint has to keep tracking every module the toolchain
 * compiles, and a family it spelled for itself would go stale here one
 * extension later, tracking nothing for a module whose bytes decide key
 * material.
 */
export const MODULE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs', 'cts', 'mts'] as const;

/** Selects every test-file spelling, wherever it sits. */
export const TEST_FILE_GLOB = `**/*.{${MARKERS.join(',')}}.{${MODULE_EXTENSIONS.join(',')}}`;

/** {@link TEST_FILE_GLOB} as a predicate over a path. */
export const TEST_FILE_PATTERN = new RegExp(
  String.raw`\.(${MARKERS.join('|')})\.(${MODULE_EXTENSIONS.join('|')})$`
);
