import { describe, expect, it } from 'vitest';

import { QaGateError, failureLine, gateResult } from './gate.js';

import type { GateFailure } from './gate.js';

const FAILURE: GateFailure = {
  filmId: 'engine-render',
  rule: 'purity',
  at: 'frame 48',
  detail: 'the two renders differ',
};

describe('failureLine', () => {
  it('names the film, the rule, where it broke and how, in that order', () => {
    expect(failureLine(FAILURE)).toBe('engine-render: purity: frame 48: the two renders differ');
  });
});

describe('gateResult', () => {
  it('passes a gate with no failures', () => {
    expect(gateResult('purity', [], ['3 probe frames compared']).passed).toBe(true);
  });

  it('fails a gate with a failure', () => {
    expect(gateResult('purity', [FAILURE], []).passed).toBe(false);
  });

  it('keeps each failure as its line', () => {
    expect(gateResult('purity', [FAILURE], []).failures).toEqual([
      'engine-render: purity: frame 48: the two renders differ',
    ]);
  });

  it('keeps what the gate measured', () => {
    expect(gateResult('purity', [], ['3 probe frames compared']).measured).toEqual([
      '3 probe frames compared',
    ]);
  });
});

describe('QaGateError', () => {
  const error = new QaGateError('engine-render', [
    gateResult('purity', [FAILURE], []),
    gateResult('frames', [], []),
  ]);

  it('prints every failing line of every failing gate', () => {
    expect(error.message).toContain('engine-render: purity: frame 48: the two renders differ');
  });

  it('opens with the film and the gates that failed', () => {
    expect(error.message.split('\n')[0]).toBe('engine-render: verify failed: purity');
  });

  it('is named for its class', () => {
    expect(error.name).toBe('QaGateError');
  });
});
