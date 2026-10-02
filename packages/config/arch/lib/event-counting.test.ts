import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { advancesByOne, isEventStep, isOne, scriptCountsEvents } from './event-counting.js';
import type { Node } from 'ts-morph';

/** The trailing argument node of `redis.incrby(<arguments>)`, as a rule reads it. */
function amountNode(argumentList: string): Node | undefined {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('step.ts', `redis.incrby(${argumentList});\n`);
  return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]?.getArguments().at(-1);
}

describe('isEventStep', () => {
  it('counts a command that steps by itself, whatever its amount reads as', () => {
    expect(isEventStep('incr', false)).toBe(true);
  });

  it('counts a countdown command that steps by itself', () => {
    expect(isEventStep('decr', false)).toBe(true);
  });

  it('counts an amount-carrying command when the amount steps by one', () => {
    expect(isEventStep('hincrby', true)).toBe(true);
  });

  it('leaves out an amount-carrying command folding an amount it cannot read as one', () => {
    expect(isEventStep('incrby', false)).toBe(false);
  });

  it('leaves out a command in neither family', () => {
    expect(isEventStep('zadd', true)).toBe(false);
  });
});

describe('isOne', () => {
  it('reads a bare one', () => {
    expect(isOne('1')).toBe(true);
  });

  it('reads a quoted one, which Redis takes as the same amount', () => {
    expect(isOne("'1'")).toBe(true);
  });

  it('reads a decimal one, because the float pair counts the same events', () => {
    expect(isOne('1.0')).toBe(true);
  });

  it('reads magnitude, so a countdown of one is one', () => {
    expect(isOne('-1')).toBe(true);
  });

  it('leaves out an amount of another magnitude', () => {
    expect(isOne('2')).toBe(false);
  });

  it('leaves out an amount it cannot read as a number', () => {
    expect(isOne('tonumber(ARGV[1])')).toBe(false);
  });
});

describe('advancesByOne', () => {
  it('reads a bare one', () => {
    expect(advancesByOne(amountNode('key, 1'))).toBe(true);
  });

  it('reads a quoted one, which Redis takes as the same amount', () => {
    expect(advancesByOne(amountNode("key, '1'"))).toBe(true);
  });

  it('reads magnitude, so a countdown of one is one', () => {
    expect(advancesByOne(amountNode('key, -1'))).toBe(true);
  });

  it('reads an amount whose sign is written out as a plus', () => {
    expect(advancesByOne(amountNode('key, +1'))).toBe(true);
  });

  it('reads a decimal one, because the float pair counts the same events', () => {
    expect(advancesByOne(amountNode('key, 1.0'))).toBe(true);
  });

  it('leaves out an amount of another magnitude', () => {
    expect(advancesByOne(amountNode('key, 2'))).toBe(false);
  });

  it('leaves out an amount that is a variable, which folds a quantity', () => {
    expect(advancesByOne(amountNode('key, amountNanoUsd'))).toBe(false);
  });

  it('leaves out a sign applied to something it cannot read as one', () => {
    expect(advancesByOne(amountNode('key, -amountNanoUsd'))).toBe(false);
  });

  it('leaves out a call carrying no amount at all', () => {
    expect(advancesByOne(amountNode(''))).toBe(false);
  });
});

describe('scriptCountsEvents', () => {
  it('reads an amount past a key whose quoted text carries a close paren', () => {
    expect(scriptCountsEvents(`redis.call('INCRBY', "attempts)", 1)`)).toBe(true);
  });

  it('reads an amount past a key whose quotes do not balance', () => {
    expect(scriptCountsEvents(`redis.call('INCRBY', 'user's attempts', 1)`)).toBe(true);
  });

  it('reads an amount past a nested call in the key position', () => {
    expect(scriptCountsEvents(`redis.call('INCRBY', redis.call('GET', KEYS[1]), 1)`)).toBe(true);
  });

  it('counts a command that steps by itself, whatever follows it', () => {
    expect(scriptCountsEvents(`redis.call('INCR', KEYS[1])`)).toBe(true);
  });

  it('leaves out an amount folding a quantity it cannot read as one', () => {
    expect(scriptCountsEvents(`redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))`)).toBe(false);
  });

  it('leaves out a script dispatching no counting command', () => {
    expect(scriptCountsEvents(`redis.call('GET', KEYS[1])`)).toBe(false);
  });
});
