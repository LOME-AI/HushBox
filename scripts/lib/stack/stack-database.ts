import { STACK_DATABASE_MARKER } from '@hushbox/shared/env.config';
import { DEFAULT_STACK_MODE } from './stack-mode.js';
import type { StackMode } from './port-plan.js';

/**
 * Which Postgres database each stack owns, and how a registry value asks for
 * one.
 *
 * The environment registry spells no database of its own, for the reason it
 * spells no port: a name written there would be a second spelling of the
 * stack's identity with nothing to catch the two disagreeing. It writes
 * {@link STACK_DATABASE_MARKER} and the generator substitutes the database of
 * the stack whose files it is writing, so a stack added to the plan gets a
 * database of its own that nobody has to remember to give it.
 */

/**
 * The unsuffixed database name, and the only place one is spelled. It is also
 * what a fresh cluster initialises itself with: `docker-compose.yml` reads the
 * default stack's name out of the environment, where
 * `scripts/lib/stack/compose-env.ts` puts what {@link stackDatabaseName}
 * resolves.
 */
const BASE_DATABASE = 'hushbox';

/**
 * The database a stack owns. The default stack keeps the unsuffixed name, so a
 * checkout that never heard of the stack split reaches the database it already
 * had — the same rule its generated env files follow.
 */
export function stackDatabaseName(stackMode: StackMode): string {
  return stackMode === DEFAULT_STACK_MODE ? BASE_DATABASE : `${BASE_DATABASE}_${stackMode}`;
}

/** Substitute each {@link STACK_DATABASE_MARKER} in a resolved env value. */
export function applyStackDatabase(value: string, stackMode: StackMode): string {
  return value.replaceAll(STACK_DATABASE_MARKER, stackDatabaseName(stackMode));
}

/**
 * The database a Postgres connection string names.
 *
 * Neither the string nor the reason it failed to parse reaches the message: a
 * connection string carries a password, and a refusal is written wherever the
 * caller prints it.
 */
export function databaseNameOf(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('stack-database: the value given is not a valid connection string');
  }
  const name = url.pathname.replace(/^\//, '');
  if (name === '') {
    throw new Error('stack-database: the connection string names no database');
  }
  return name;
}
