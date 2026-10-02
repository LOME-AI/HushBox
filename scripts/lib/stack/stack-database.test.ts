import { describe, expect, it } from 'vitest';
import { STACK_DATABASE_MARKER } from '@hushbox/shared/env.config';
import { quoteIdentifier } from '@hushbox/db/test-db';
import { STACK_MODES } from './port-plan.js';
import { applyStackDatabase, databaseNameOf, stackDatabaseName } from './stack-database.js';

describe('stackDatabaseName', () => {
  it('leaves the database of the stack a command resolves by default unsuffixed', () => {
    expect(stackDatabaseName('development')).toBe('hushbox');
  });

  it('gives every declared stack a database no other stack has', () => {
    const names = STACK_MODES.map((mode) => stackDatabaseName(mode));
    expect(new Set(names).size).toBe(STACK_MODES.length);
  });

  it('names a database Postgres will accept, for every declared stack', () => {
    for (const mode of STACK_MODES) {
      expect(() => quoteIdentifier(stackDatabaseName(mode))).not.toThrow();
    }
  });
});

describe('applyStackDatabase', () => {
  it('substitutes the marker a registry value writes with the stack own database', () => {
    expect(applyStackDatabase(`postgres://u:p@localhost:1/${STACK_DATABASE_MARKER}`, 'e2e')).toBe(
      'postgres://u:p@localhost:1/hushbox_e2e'
    );
  });

  it('resolves the marker to a different database for every declared stack', () => {
    const resolved = STACK_MODES.map((mode) => applyStackDatabase(STACK_DATABASE_MARKER, mode));
    expect(new Set(resolved).size).toBe(STACK_MODES.length);
  });

  it('leaves a value that asks for no stack database alone', () => {
    expect(applyStackDatabase('https://hushbox.ai', 'e2e')).toBe('https://hushbox.ai');
  });
});

describe('databaseNameOf', () => {
  it('reads the database a connection string names', () => {
    expect(databaseNameOf('postgres://postgres:postgres@localhost:1/hushbox_e2e')).toBe(
      'hushbox_e2e'
    );
  });

  it('refuses a connection string that names no database', () => {
    expect(() => databaseNameOf('postgres://postgres:postgres@localhost:1')).toThrow(/no database/);
  });

  it('refuses a value that is no connection string at all', () => {
    expect(() => databaseNameOf('not a url')).toThrow(/connection string/);
  });

  it('names neither the string nor its password in the refusal', () => {
    expect(() => databaseNameOf('postgres://postgres:hunter2@localhost:1')).not.toThrow(/hunter2/);
  });
});
