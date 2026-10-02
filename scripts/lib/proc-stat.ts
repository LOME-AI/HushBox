/**
 * Where the fields of one `/proc/<pid>/stat` record stand — the single
 * statement of that rule for every reader of `/proc` in this package.
 *
 * The record reads `pid (command) state ppid pgrp …`, and the command is the
 * kernel's own copy of a name a user chose: it may hold spaces, and it may hold
 * brackets. Splitting the record on whitespace therefore lands on a different
 * field for every process that has a space in its name, and counting brackets
 * forward lands wrong on every process that has one. The fields begin past the
 * LAST bracket, and the id ahead of the first; nothing else about the record is
 * positionally safe. A record that brackets no name at all is one this declines
 * to read rather than one it guesses at — a misread group is a live process
 * counted into a stranger's tree.
 */

/** One `/proc/<pid>/stat` record, cut at the command name. */
interface ProcStatRecord {
  /** The record's leading field, as written; no caller's notion of validity is applied. */
  readonly pid: string;
  /** `state ppid pgrp …`, the fields past the command name, in kernel order. */
  readonly fields: readonly string[];
}

/** One letter; only `Z` means the process has exited and not yet been collected. */
export const STATE_FIELD = 0;

/** The process that started this one. */
export const PARENT_FIELD = 1;

/** The group a signal addresses to reach a whole tree. */
export const GROUP_FIELD = 2;

/**
 * How long after the machine booted the process started, in clock ticks. It is
 * the one figure here that is not an identifier: paired with the machine's
 * uptime it gives an elapsed time, read off the boot clock at both ends rather
 * than against a wall clock.
 */
export const START_FIELD = 19;

/** The fields of one `/proc/<pid>/stat` record, or nothing where it names no command. */
export function parseProcStatRecord(content: string): ProcStatRecord | undefined {
  const opened = content.indexOf('(');
  const closed = content.lastIndexOf(')');
  if (opened === -1 || closed < opened) return undefined;
  return {
    pid: content.slice(0, opened).trim(),
    fields: content
      .slice(closed + 1)
      .trim()
      .split(/\s+/),
  };
}
