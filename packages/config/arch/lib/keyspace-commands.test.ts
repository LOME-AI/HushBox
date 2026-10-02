import { describe, expect, it } from 'vitest';
import { KEYSPACE_WIDE_COMMANDS, isKeyspaceWideCommand } from './keyspace-commands.js';

/**
 * The pin: the set is re-derived from the live server's own command table and
 * compared. A command Redis adds, renames or recategorises fails here rather
 * than going silently uncovered, which is what keeps the set a derivation
 * rather than a list.
 *
 * This suite needs the local stack, which is what `pnpm test` brings up.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required to re-derive the keyspace-wide command set — run through \`tsx scripts/with-env.ts\`, which is what loads the env files`
    );
  }
  return value;
}

/** One `COMMAND INFO` row: name, arity, flags, first/last key, step, ACL categories. */
type CommandInfoRow = [string, number, string[], number, number, number, string[], ...unknown[]];

async function everyCommand(): Promise<CommandInfoRow[]> {
  const response = await fetch(requiredEnv('UPSTASH_REDIS_REST_URL'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnv('UPSTASH_REDIS_REST_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(['COMMAND', 'INFO']),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (body.error !== undefined) throw new Error(`COMMAND INFO failed: ${body.error}`);
  return (body.result as CommandInfoRow[]).filter((row) => Array.isArray(row));
}

/** Field offsets in one `COMMAND INFO` row, in the order the server returns them. */
const NAME = 0;
const FLAGS = 2;
const FIRST_KEY = 3;
const ACL_CATEGORIES = 6;

/** Keyless — no key position and no movable keys — and in the keyspace category. */
function isKeylessKeyspaceCommand(row: CommandInfoRow): boolean {
  return (
    row[FIRST_KEY] === 0 &&
    !row[FLAGS].includes('movablekeys') &&
    row[ACL_CATEGORIES].includes('@keyspace')
  );
}

describe('KEYSPACE_WIDE_COMMANDS', () => {
  it('is exactly what the server reports as keyless and keyspace-addressing', async () => {
    const rows = await everyCommand();
    const derived = rows
      .filter((row) => isKeylessKeyspaceCommand(row))
      .map((row) => row[NAME])
      .toSorted((a, b) => a.localeCompare(b));

    expect([...KEYSPACE_WIDE_COMMANDS].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      derived
    );
  });
});

describe('isKeyspaceWideCommand', () => {
  it('recognises a command that walks the keyspace', () => {
    expect(isKeyspaceWideCommand('scan')).toBe(true);
  });

  it('reads the name case-insensitively, as Redis does', () => {
    expect(isKeyspaceWideCommand('FLUSHALL')).toBe(true);
  });

  it('leaves a connection-level command out', () => {
    expect(isKeyspaceWideCommand('ping')).toBe(false);
  });

  it('leaves a command addressed to a key out', () => {
    expect(isKeyspaceWideCommand('get')).toBe(false);
  });
});
