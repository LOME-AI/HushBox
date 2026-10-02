/**
 * The Redis commands that address the whole keyspace and take no key.
 *
 * Not a list of the dangerous commands anyone thought of: it is every command
 * the server itself reports as taking no key — `COMMAND INFO` first-key `0`
 * with no `movablekeys` flag — while sitting in Redis's own `@keyspace` ACL
 * category, taken over the server's whole command table. The colocated test
 * re-derives it from the live server and fails on any difference, so the set
 * cannot quietly become a list: the server decides what is in it, and a command
 * this file has never heard of is caught by the derivation rather than by
 * someone remembering to add it.
 *
 * Both properties are load-bearing. Taking no key is what makes a command
 * unscopable — the test harness scopes a run's keys by prefixing them
 * (`scripts/lib/vitest/redis-scope.ts`), which reaches a command only through
 * its key arguments. Sitting in `@keyspace` is what separates a command that
 * would then read or destroy every concurrent run from one that takes no key
 * and touches no keyspace at all — `PING`, `ECHO`, `SCRIPT LOAD` — which is
 * why membership is asked of the server rather than inferred from the absence
 * of a key.
 *
 * `SCAN` is here even though the harness can scope a `MATCH` pattern: a test
 * walking the keyspace is asking a question whose answer depends on what else
 * is running, and the scoped pattern makes it a narrower question rather than a
 * different kind of one.
 */
export const KEYSPACE_WIDE_COMMANDS: readonly string[] = [
  'dbsize',
  'flushall',
  'flushdb',
  'keys',
  'randomkey',
  'scan',
  'swapdb',
];

/** True for a command name Redis reports as addressing the keyspace with no key. */
export function isKeyspaceWideCommand(name: string): boolean {
  return KEYSPACE_WIDE_COMMANDS.includes(name.toLowerCase());
}
