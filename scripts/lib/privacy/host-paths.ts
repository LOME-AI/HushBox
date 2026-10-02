/**
 * The host-path vocabulary: the alternatives that say a string names a machine
 * rather than a place in the repository. Both privacy gates ask that one
 * question — the text gate of file content, the binary gate of text parsed out
 * of container metadata — and so does {@link withoutHostPaths}, the redactor
 * that blanks a machine name out of a subprocess diagnosis before the gate
 * prints it. The answer is written once here and no caller restates it.
 *
 * This module is deliberately a leaf and loads nothing at all. Keeping the
 * vocabulary beside either gate closes a cycle between the text rules and the
 * binary format registry, and that cycle half-initialises: entry points that
 * reach the rules first die reading a constant inside its own dead zone while
 * the rest load cleanly, so the damage presents as scattered test failures
 * rather than as a broken module. A leaf cannot be a member of any cycle, which
 * is the whole reason this file has no dependency.
 */

// `/home/`, `/Users/`, `/workspace/`, `/opt/`, the per-user temp root below and
// the named-home shorthand each name a user or a checkout, so each fires on its
// own. The shared system temp directory does not, and it needs the extra
// condition below rather than either simplification:
//
// - treating it like the others reintroduces sixty-odd false findings, because
//   fixed `/tmp/<constant>` paths in workflow files disclose nothing;
// - leaving it out entirely hides the shape this run exists to catch, because a
//   process id or clock embedded in a temp filename abuts a hyphen, dot or
//   letter, and the epoch rules' boundary guards make them never match there.
//
// So the temp prefix can fire only when a segment after it carries a run of four
// or more digits — which is the process id or the clock, never the directory.
// That condition answers a population rather than the root itself: the false
// findings it exists for are fixed paths written into source text, so a caller
// reading a population where such paths do not occur declines it and takes the
// prefix unconditionally.
//
// Every form needs the segment after the prefix, so a bare prefix — the way a
// rule gets described in prose — is not a finding.
// A segment character is a word character, a dot, a hyphen, or any non-ASCII
// character that is not whitespace. The second half is a derivation rather than a
// list, and it has to cover two populations at once: the stand-in a writer reaches
// for when eliding the user segment — three ASCII periods, or the one character an
// editor substitutes for them, from whichever block — and the segment itself, which
// is a person's name and so is not ASCII either. Naming one Unicode category
// reaches only some of the first; excluding every letter and digit, which an
// earlier spelling did, drops all of the second. Whitespace is the only thing the
// complement withholds, and that is what keeps a bare prefix innocent when prose
// wraps a non-breaking space onto it.
const SEGMENT_SOURCE = String.raw`(?:[\w.-]|[^\p{ASCII}\s])`;
// Both temp spellings are read for the reason the per-user root below states:
// the platform symlinks this root to its resolved location, and the digit
// condition decides the same way on either.
const TEMP_PREFIX_SOURCE = String.raw`\/(?:private\/)?tmp\/(?:${SEGMENT_SOURCE}+\/)*`;
// The per-user temp root takes no digit condition, and the difference is the
// population rather than the shape: the directory immediately under it is the
// opaque per-account one the platform mints, so the path names an account
// whatever follows, and no fixed spelling of it exists to be a false finding.
// Both spellings are read because that platform reaches the directory through a
// symlink as well as at its resolved location, and a pattern that knew only the
// short one would match the long one at its inner segment — where the text
// gate's envelope guard refuses it.
const PER_USER_TEMP_SOURCE = String.raw`\/(?:private\/)?var\/folders\/${SEGMENT_SOURCE}+`;

interface RootedHostPathOptions {
  /**
   * Whether the shared system temp root counts only where a segment under it
   * also carries a run of four or more digits. The comment introducing that root
   * states what each answer costs and to which population; a caller declares its
   * own rather than inheriting one silently.
   */
  readonly tempRootNeedsDigitRun: boolean;
}

/**
 * The rooted spellings both gates read, less the named-home shorthand: each gate
 * needs the same alternatives, and a hand-written copy of them goes stale the
 * moment a root is named here. Compile the result with the `u` flag — the
 * segment class is built from Unicode properties. Omitting the flag does not
 * throw: the property escapes degrade to identity escapes and the pattern
 * silently reads a wider language than the gates do.
 */
export function rootedHostPathSource(options: RootedHostPathOptions): string {
  const tail = options.tempRootNeedsDigitRun
    ? String.raw`${SEGMENT_SOURCE}*\d{4}${SEGMENT_SOURCE}*`
    : String.raw`${SEGMENT_SOURCE}+`;
  return (
    String.raw`\/(?:home|Users|workspace|opt)\/${SEGMENT_SOURCE}+|${TEMP_PREFIX_SOURCE}${tail}` +
    String.raw`|${PER_USER_TEMP_SOURCE}|[A-Za-z]:\\{1,2}${SEGMENT_SOURCE}+`
  );
}

/** The rooted spellings under the temp condition, which is what the text gate reads. */
export const ROOTED_HOST_PATH_SOURCE = rootedHostPathSource({ tempRootNeedsDigitRun: true });

/**
 * The shorthand is a spelling of the same disclosure, but it names no root. It
 * *is* a root, though, which is what the lookbehind says: a separator in front
 * of it means the tilde opens a path segment rather than a home directory, and
 * every such segment met so far has been the tail of a URL whose scheme and host
 * sit on the same line. Allowlisting those one at a time closes a site and
 * leaves the gates producing the next one.
 *
 * The character straight after the tilde is a letter in any script, which is a
 * narrower class than the segment behind it and deliberately so. A home
 * directory is named after a person and a person's name need not be Latin, so
 * the class cannot be the ASCII letters; but the segment class would also admit
 * a digit, a hyphen and a dot, and a tilde opening on one of those is a version
 * number, a flag or a relative path rather than anybody's home.
 *
 * Separate from its rooted sibling for the same reason, but the flag it needs
 * fails the other way: compile it under `u`, or the property escape degrades
 * into an identity escape and the source reads a literal brace-wrapped name,
 * leaving a caller that forgot the flag a pattern silent on every home directory
 * rather than a wider one.
 */
export const NAMED_HOME_SOURCE = String.raw`(?<!\/)~\p{L}${SEGMENT_SOURCE}*\/`;

/**
 * Neither source above carries this: compiled bare, both read a rooted or
 * shorthand spelling at an inner segment, where a path that names nobody's
 * machine sits behind an ordinary word character. It is the envelope rather than
 * part of either alternative because the two share it — a gate that composes one
 * alternative or both composes this once in front.
 *
 * Whether the bare reading is a defect is a question about the population, not
 * about the sources, so this is not folded into them: the text gate composes it,
 * the binary gate deliberately does not, and each states its reason where it
 * composes.
 */
export const HOST_PATH_ENVELOPE_GUARD_SOURCE = String.raw`(?<![\w.~])`;

/**
 * A location rather than a path: `user@host:path` is how git names a
 * destination on an ordinary `git push <location> <ref>`, and it carries an
 * account and a machine name before it carries any path. An address shape is a
 * disclosure whether or not a path follows it.
 */
const ADDRESS_SOURCE = String.raw`[^\s'"]*@[^\s'"]+`;

/**
 * Everything from where a spelling starts to the closing quote or the end of
 * the line. Deliberately looser than the segment class above, and the looseness
 * is the population: this reads one line of subprocess stderr, where a home
 * directory carrying a person's full name is exactly the case a `\w`-shaped tail
 * leaks a surname through. It admits too much rather than too little, which
 * costs a message its trailing words and never costs a person their name.
 */
const REDACTED_TAIL_SOURCE = String.raw`[^'"\n]*`;

/**
 * The redactor's language, which is required to be wider than the gate's. It
 * takes {@link HOST_PATH_ENVELOPE_GUARD_SOURCE} rather than its own start
 * condition, which is what keeps the containment structural: a redactor that
 * listed the characters a path may start *after* was silent wherever the gate's
 * guard admits a character that list forgot, and a bracket or an angle bracket
 * introducing a path is exactly that shape.
 *
 * Its alternatives are the address above, the named-home shorthand, and any
 * separator-led path — a drive letter optionally in front, because a Windows
 * clone path renders whole under a rule that knows only the forward slash. Each
 * runs to the closing quote or the end of the line. The tilde takes the
 * letter-first condition its rooted sibling states: a tilde opening on a digit,
 * a hyphen or a dot is a version number, a flag or a relative path rather than
 * anybody's home.
 *
 * The property escape needs the `u` flag, so this is compiled here rather than
 * published as a source: the flag hazard both sources above document is
 * unreachable where no caller does the compiling.
 */
const HOST_PATH = new RegExp(
  `${HOST_PATH_ENVELOPE_GUARD_SOURCE}(?:${ADDRESS_SOURCE}` +
    String.raw`|~\p{L}${REDACTED_TAIL_SOURCE}|(?:[A-Za-z]:)?[\\/]${REDACTED_TAIL_SOURCE})`,
  'gu'
);

/**
 * git reports a failure by quoting the invocation back, and the invocation
 * carries this clone's absolute path — which names the machine and the account
 * the work happened on. git's own diagnosis survives; the command line does
 * not, and neither does any absolute path inside the diagnosis.
 *
 * Every spelling the text gate reports as a machine name is blanked here: that
 * containment is one-way and asserted as such, because a disclosure the gate
 * refuses to let into a file must not reach a committed error message either.
 */
export function withoutHostPaths(text: string): string {
  return text.replaceAll(HOST_PATH, '<path>');
}
