import { describe, expect, it } from 'vitest';
import { StepFailure, atStep, duringStep } from './step.js';

describe('StepFailure', () => {
  it('reads as the failure of its step', () => {
    expect(new StepFailure('clone', 'no such remote').message).toBe(
      'records: clone failed: no such remote'
    );
  });
});

describe('atStep', () => {
  it('returns what the action returns', () => {
    expect(atStep('count', () => 3)).toBe(3);
  });

  it('reports a thrown error as the failure of its step', () => {
    expect(() =>
      atStep('count', () => {
        throw new Error('no numbers');
      })
    ).toThrow(/^records: count failed: Error: no numbers$/u);
  });

  it('keeps the thrown error as the cause', () => {
    const thrown = new Error('no numbers');

    let caught: unknown;
    try {
      atStep('count', () => {
        throw thrown;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toHaveProperty('cause', thrown);
  });

  it('passes on a failure that already names its step', () => {
    const inner = new StepFailure('clone', 'no such remote');

    expect(() =>
      atStep('restore', () => {
        throw inner;
      })
    ).toThrow(inner);
  });
});

describe('duringStep', () => {
  it('resolves to what the action resolves to', async () => {
    await expect(duringStep('count', () => Promise.resolve(3))).resolves.toBe(3);
  });

  it('reports a rejection as the failure of its step', async () => {
    await expect(
      duringStep('count', () => Promise.reject(new Error('no numbers')))
    ).rejects.toThrow(/^records: count failed: Error: no numbers$/u);
  });

  it('passes on a rejection that already names its step', async () => {
    const inner = new StepFailure('clone', 'no such remote');

    await expect(duringStep('restore', () => Promise.reject(inner))).rejects.toBe(inner);
  });
});
