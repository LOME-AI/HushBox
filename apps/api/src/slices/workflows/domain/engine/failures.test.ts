import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, nanoUSD } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import {
  AbsorbedSettlementRefusal,
  AllBranchesFailedError,
  BilledSettlementRefusal,
  InfrastructureUnavailableError,
  SettlementConflictError,
  absorbedLossEvent,
  costCircuitTripEvent,
  runFailureCode,
  settleAgainstHold,
  settlementAboveHoldEvent,
} from './failures.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { SettlementCharge } from '@hushbox/shared';

describe('runFailureCode', () => {
  it('maps invalid run inputs to the validation code', () => {
    expect(runFailureCode({ kind: 'inputs-invalid' })).toBe(ERROR_CODES.VALIDATION);
  });

  it('maps a byte-budget breach to the validation code', () => {
    expect(runFailureCode({ kind: 'byte-budget-exceeded' })).toBe(ERROR_CODES.VALIDATION);
  });

  it('passes an admission refusal code through unchanged', () => {
    expect(
      runFailureCode({ kind: 'admission-refused', code: ERROR_CODES.ADMISSION_UNAVAILABLE })
    ).toBe(ERROR_CODES.ADMISSION_UNAVAILABLE);
  });

  it('maps a failed node to the unavailable code', () => {
    expect(runFailureCode({ kind: 'node-failed', nodeId: 'answer' })).toBe(ERROR_CODES.UNAVAILABLE);
  });

  it('passes a node failure code through when the node carries one', () => {
    expect(
      runFailureCode({ kind: 'node-failed', nodeId: 'answer', code: ERROR_CODES.CONTENT_POLICY })
    ).toBe(ERROR_CODES.CONTENT_POLICY);
  });

  it('passes an inputs-invalid code through when one is carried', () => {
    expect(
      runFailureCode({ kind: 'inputs-invalid', code: ERROR_CODES.UNSUPPORTED_RESOLUTION })
    ).toBe(ERROR_CODES.UNSUPPORTED_RESOLUTION);
  });

  it('maps a defect to the internal code', () => {
    expect(runFailureCode({ kind: 'defect' })).toBe(ERROR_CODES.INTERNAL);
  });

  it('maps an all-branches-failed settlement to the unavailable code', () => {
    expect(runFailureCode({ kind: 'all-branches-failed' })).toBe(ERROR_CODES.UNAVAILABLE);
  });

  it('maps an infrastructure-unavailable failure to the unavailable code', () => {
    expect(runFailureCode({ kind: 'infrastructure-unavailable' })).toBe(ERROR_CODES.UNAVAILABLE);
  });

  it('passes a settlement-conflict code through unchanged', () => {
    expect(
      runFailureCode({ kind: 'settlement-conflict', code: ERROR_CODES.FORK_TIP_CONFLICT })
    ).toBe(ERROR_CODES.FORK_TIP_CONFLICT);
  });
});

describe('SettlementConflictError', () => {
  it('is a typed Error subclass the engine can discriminate via instanceof', () => {
    const error = new SettlementConflictError(
      notFoundError('fork gone'),
      'chat settlement: fork-tip advancement failed'
    );
    expect(error).toBeInstanceOf(SettlementConflictError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its class name for telemetry', () => {
    expect(new SettlementConflictError(notFoundError('fork gone'), 'msg').name).toBe(
      'SettlementConflictError'
    );
  });

  it('carries the wire-code-bearing domain error the engine projects to the client', () => {
    const domainError = conflictError('epoch rotated', undefined, ERROR_CODES.CONFLICT);
    const error = new SettlementConflictError(domainError, 'chat settlement: wrap-epoch failed');
    expect(error.domainError).toBe(domainError);
    expect(error.message).toBe('chat settlement: wrap-epoch failed');
  });
});

describe('InfrastructureUnavailableError', () => {
  it('is a typed Error subclass the engine can discriminate via instanceof', () => {
    const error = new InfrastructureUnavailableError('storage put failed');
    expect(error).toBeInstanceOf(InfrastructureUnavailableError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its class name for telemetry', () => {
    expect(new InfrastructureUnavailableError('storage put failed').name).toBe(
      'InfrastructureUnavailableError'
    );
  });

  it('attaches the originating error as its cause when one is supplied', () => {
    const origin = new Error('minio put timed out');
    expect(new InfrastructureUnavailableError('storage put failed', origin).cause).toBe(origin);
  });

  it('omits the cause when none is supplied', () => {
    expect(new InfrastructureUnavailableError('storage put failed').cause).toBeUndefined();
  });
});

describe('AllBranchesFailedError', () => {
  it('is a typed Error subclass the engine can discriminate via instanceof', () => {
    const error = new AllBranchesFailedError();
    expect(error).toBeInstanceOf(AllBranchesFailedError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its class name for telemetry', () => {
    expect(new AllBranchesFailedError().name).toBe('AllBranchesFailedError');
  });
});

describe('AbsorbedSettlementRefusal', () => {
  it('is the refusal it wraps, so the engine still reports the refusal code', () => {
    const refusal = new SettlementConflictError(
      conflictError('refused', undefined, ERROR_CODES.FORK_TIP_CONFLICT),
      'settlement refused'
    );
    const absorbed = new AbsorbedSettlementRefusal(refusal);
    expect(absorbed).toBeInstanceOf(SettlementConflictError);
    expect(absorbed.domainError).toBe(refusal.domainError);
    expect(absorbed.message).toBe('settlement refused');
    expect(absorbed.name).toBe('AbsorbedSettlementRefusal');
  });
});

describe('BilledSettlementRefusal', () => {
  const posted: SettlementCharge = {
    key: 'answer',
    modelId: 'answer-model',
    providerName: 'p',
    modality: 'text',
    billableCostNanoUsd: 100n,
    isEstimated: false,
    storageFeeNanoUsd: 0n,
  };

  it('is the refusal it wraps, so the engine still reports the refusal code', () => {
    const refusal = new SettlementConflictError(
      conflictError('refused', undefined, ERROR_CODES.FORK_TIP_CONFLICT),
      'settlement refused'
    );
    const billed = new BilledSettlementRefusal(refusal, [posted]);
    expect(billed).toBeInstanceOf(SettlementConflictError);
    expect(billed.domainError).toBe(refusal.domainError);
    expect(billed.message).toBe('settlement refused');
    expect(billed.name).toBe('BilledSettlementRefusal');
  });

  it('carries the charges the refusal commit posted', () => {
    const refusal = new SettlementConflictError(conflictError('refused'), 'settlement refused');
    expect(new BilledSettlementRefusal(refusal, [posted]).billed).toEqual([posted]);
  });
});

describe('settlementAboveHoldEvent', () => {
  const RUN_ID = '0b7f2c1e-4a3d-4f6b-9c2e-8d1a5e7f3b90';
  const event = settlementAboveHoldEvent({
    runId: RUN_ID,
    holdNanoUsd: 900n,
    billedNanoUsd: 1200n,
    legs: ['tier-crossed', 'input-above-estimate'],
    billing: 'inline',
  });

  it('carries the run, both amounts, the sorted legs and the billing as its only own properties beside its name', () => {
    expect(event).toBeInstanceOf(Error);
    expect(event.name).toBe('SettlementAboveHold');
    expect(Reflect.get(event, 'runId')).toBe(RUN_ID);
    expect(Reflect.get(event, 'holdNanoUsd')).toBe('900');
    expect(Reflect.get(event, 'billedNanoUsd')).toBe('1200');
    expect(Reflect.get(event, 'legs')).toBe('input-above-estimate,tier-crossed');
    expect(Reflect.get(event, 'billing')).toBe('inline');
    expect(Object.keys(event)).toEqual([
      'name',
      'runId',
      'holdNanoUsd',
      'billedNanoUsd',
      'legs',
      'billing',
    ]);
  });

  it('states the run, both amounts and the legs in its message', () => {
    expect(event.message).toBe(
      `settlement billed above its hold: run ${RUN_ID} billed 1200 nano-USD against a 900 nano-USD hold (input-above-estimate,tier-crossed)`
    );
  });
});

describe('settleAgainstHold', () => {
  const posted: SettlementCharge = {
    key: 'answer',
    modelId: 'answer-model',
    providerName: 'p',
    modality: 'text',
    billableCostNanoUsd: 150n,
    isEstimated: false,
  };
  const HOLD = { totalNanoUsd: nanoUSD(100n), calls: [] };
  const SETTLING = { runKey: 'k', outputs: {}, charges: [] };

  function telemetryThatThrows(): Telemetry {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      captureError: vi.fn(() => {
        throw new Error('sink down');
      }),
    };
  }

  it('warns with no run id when a run that minted none fails to capture', async () => {
    const telemetry = telemetryThatThrows();

    await settleAgainstHold(
      { telemetry },
      { hooks: { admission: vi.fn(), settlement: () => Promise.resolve({ billed: [posted] }) } },
      HOLD,
      SETTLING
    );

    expect(telemetry.warn).toHaveBeenCalledWith('settlement above hold capture failed', {});
  });

  it('rethrows a settlement failure that is not a refusal without capturing', async () => {
    const telemetry = telemetryThatThrows();
    const thrown = new Error('db exploded');

    await expect(
      settleAgainstHold(
        { telemetry },
        { hooks: { admission: vi.fn(), settlement: () => Promise.reject(thrown) } },
        HOLD,
        SETTLING
      )
    ).rejects.toBe(thrown);
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('absorbedLossEvent', () => {
  const RUN_ID = '0b7f2c1e-4a3d-4f6b-9c2e-8d1a5e7f3b90';

  it('carries the run id and the absorbed nano-USD as its only tag properties', () => {
    const event = absorbedLossEvent({
      name: 'SettlementRefusalAbsorbed',
      summary: 'settlement refusal absorbed spend',
      runId: RUN_ID,
      absorbedNanoUsd: 8000n,
    });
    expect(event).toBeInstanceOf(Error);
    expect(event.name).toBe('SettlementRefusalAbsorbed');
    expect(Reflect.get(event, 'runId')).toBe(RUN_ID);
    expect(Reflect.get(event, 'absorbedNanoUsd')).toBe('8000');
    expect(Object.keys(event)).toEqual(['name', 'runId', 'absorbedNanoUsd']);
  });

  it('states the loss, the run and the amount in its message', () => {
    const event = absorbedLossEvent({
      name: 'RejectedOutputAbsorbed',
      summary: 'rejected node output absorbed spend',
      runId: RUN_ID,
      absorbedNanoUsd: 2000n,
    });
    expect(event.message).toBe(
      `rejected node output absorbed spend: run ${RUN_ID} absorbed 2000 nano-USD unbilled`
    );
  });
});

describe('costCircuitTripEvent', () => {
  const RUN_ID = '0b7f2c1e-4a3d-4f6b-9c2e-8d1a5e7f3b90';

  it('carries the run id, the accrual and the limit as its only enumerable own properties beside its name', () => {
    const event = costCircuitTripEvent({
      runId: RUN_ID,
      accruedNanoUsd: 2000n,
      limitNanoUsd: 500n,
    });
    expect(event).toBeInstanceOf(Error);
    expect(event.name).toBe('CostCircuitTripped');
    expect(Reflect.get(event, 'runId')).toBe(RUN_ID);
    expect(Reflect.get(event, 'accruedNanoUsd')).toBe('2000');
    expect(Reflect.get(event, 'limitNanoUsd')).toBe('500');
    expect(Object.keys(event)).toEqual(['name', 'runId', 'accruedNanoUsd', 'limitNanoUsd']);
  });

  it('states the run, the accrual and the limit in its message', () => {
    const event = costCircuitTripEvent({
      runId: RUN_ID,
      accruedNanoUsd: 2000n,
      limitNanoUsd: 500n,
    });
    expect(event.message).toBe(
      `cost circuit closed the spend gate: run ${RUN_ID} accrued 2000 nano-USD over a 500 nano-USD limit`
    );
  });
});
