import { describe, it, expect } from 'vitest';
import { GROUP_FIELD, PARENT_FIELD, STATE_FIELD, parseProcStatRecord } from './proc-stat.js';

describe('parseProcStatRecord', () => {
  it('finds the fields past a command name that holds a bracket', () => {
    const record = parseProcStatRecord('4321 (tsx (evil) name) S 1 4242 4242 0 -1 4194560');
    expect(record?.fields[GROUP_FIELD]).toBe('4242');
  });

  it('finds the fields past a command name that holds a space', () => {
    const record = parseProcStatRecord('4321 (Web Content) R 7 1234 1234 0 -1 0');
    expect(record?.fields[GROUP_FIELD]).toBe('1234');
  });

  it('reads the process id from ahead of a command name that holds a bracket', () => {
    expect(parseProcStatRecord('7 (tsx (evil) name) R 1 7 1')?.pid).toBe('7');
  });

  it('reads the run state as the first field past the command name', () => {
    expect(parseProcStatRecord('4321 (node) Z 1 4242 4242')?.fields[STATE_FIELD]).toBe('Z');
  });

  it('reads the parent as the second field past the command name', () => {
    expect(parseProcStatRecord('123 (eslint) S 45 123 45 0 -1')?.fields[PARENT_FIELD]).toBe('45');
  });

  it('reads nothing out of a record that never brackets a command name', () => {
    expect(parseProcStatRecord('4321 node S 1 4242')).toBeUndefined();
  });

  it('reads nothing out of a record whose bracket never closes', () => {
    expect(parseProcStatRecord('12 (x R nope')).toBeUndefined();
  });

  // A `/proc` file the reader could not open reaches its parser as empty
  // content rather than as an absent value, so no reader of `/proc` needs a
  // branch on whether the process outlived the listing that named it.
  it('reads nothing out of the empty content an unreadable file yields', () => {
    expect(parseProcStatRecord('')).toBeUndefined();
  });
});
