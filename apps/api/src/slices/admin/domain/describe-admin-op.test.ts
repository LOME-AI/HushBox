import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { conflictError, validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import {
  assertReadBattery,
  describeAdminOp,
  ephemeralProbes,
  requiredInverse,
  requiredInverseInput,
  requiredOverGuardrailInput,
  rolesRefusedBy,
  runSeededActions,
  seededRng,
  undoInputFor,
  winnerOfConcurrentRace,
} from './describe-admin-op.js';
import {
  FIXTURE_AMOUNT_CAP_NANO_USD,
  fixtureLookContract,
  fixtureMarkContract,
  fixturePingContract,
} from './fixture-ops.js';
import type { AdminOpContract } from '@hushbox/shared';
import type { AdminOpHarnessInstance, DescribeAdminOpConfig } from './describe-admin-op.js';
import type { AdminOpRunResult } from './engine.js';

function contractWithInverse(inverse: `${string}.${string}` | null): AdminOpContract {
  return {
    name: 'fixture.guarded',
    title: 'Guarded',
    kind: 'mutation',
    input: z.object({}),
    inverse,
    effectClass: inverse === null ? 'ephemeral' : 'durable',
    target: null,
    allowedRoles: ['operator'],
  };
}

function guardrailedConfig(
  overGuardrailInput?: () => Record<string, unknown>
): DescribeAdminOpConfig {
  return {
    contract: { ...contractWithInverse('fixture.undo'), guardrails: { maxAmountNanoUsd: 1n } },
    createHarness: () => Promise.resolve({} as unknown as AdminOpHarnessInstance),
    validInput: () => ({}),
    invalidInput: {},
    ...(overGuardrailInput === undefined ? {} : { overGuardrailInput }),
  };
}

/** A durable config carrying no interleaving battery — the Iron Law test's own control. */
function durableConfig(): DescribeAdminOpConfig {
  return {
    contract: contractWithInverse('fixture.undo'),
    createHarness: () => Promise.resolve({} as unknown as AdminOpHarnessInstance),
    validInput: () => ({}),
    invalidInput: {},
  };
}

/** A config whose contract declares no enforceable cap, yet supplies an over-cap input. */
function caplessConfig(contract: AdminOpContract): DescribeAdminOpConfig {
  return {
    contract,
    createHarness: () => Promise.resolve({} as unknown as AdminOpHarnessInstance),
    validInput: () => ({}),
    invalidInput: {},
    overGuardrailInput: () => ({ amountNanoUsd: '2' }),
  };
}

function resultWithInverseInput(inverseInput: Record<string, unknown> | null): AdminOpRunResult {
  return { auditId: crypto.randomUUID(), effects: [], inverseInput };
}

describe('describeAdminOp guard helpers', () => {
  it('requiredInverse returns the registered inverse name', () => {
    expect(requiredInverse(contractWithInverse('fixture.undo'))).toBe('fixture.undo');
  });

  it('requiredInverse throws on a contract without an inverse', () => {
    expect(() => requiredInverse(contractWithInverse(null))).toThrow(/without an inverse/);
  });

  it('requiredInverseInput returns the stored inverse input', () => {
    const inverseInput = { targetId: 'x' };

    expect(requiredInverseInput(resultWithInverseInput(inverseInput))).toBe(inverseInput);
  });

  it('requiredInverseInput throws when the op stored none', () => {
    expect(() => requiredInverseInput(resultWithInverseInput(null))).toThrow(/no inverseInput/);
  });

  it('undoInputFor keeps the recorded values but replaces the recorded reason', () => {
    const recorded = { targetId: 'x', reason: 'undo of fixture.guarded on x' };

    const built = undoInputFor(resultWithInverseInput(recorded));

    expect(built['targetId']).toBe('x');
    expect(built['reason']).toBeTypeOf('string');
    expect(built['reason']).not.toBe(recorded.reason);
  });

  it('undoInputFor throws when the op stored no inverseInput', () => {
    expect(() => undoInputFor(resultWithInverseInput(null))).toThrow(/no inverseInput/);
  });

  it('requiredOverGuardrailInput throws when a capped contract supplies none', () => {
    expect(() => requiredOverGuardrailInput(guardrailedConfig())).toThrow(
      /must supply overGuardrailInput/
    );
  });

  it('requiredOverGuardrailInput throws when a config supplies an input for a contract declaring no guardrails', () => {
    expect(() =>
      requiredOverGuardrailInput(caplessConfig(contractWithInverse('fixture.undo')))
    ).toThrow(/must not supply overGuardrailInput/);
  });

  it('requiredOverGuardrailInput throws when a config supplies an input for guardrails declaring no cap', () => {
    const contract = { ...contractWithInverse('fixture.undo'), guardrails: {} };

    expect(() => requiredOverGuardrailInput(caplessConfig(contract))).toThrow(
      /must not supply overGuardrailInput/
    );
  });

  it('requiredOverGuardrailInput returns the supplied over-cap input', () => {
    const overGuardrailInput = (): Record<string, unknown> => ({ amountNanoUsd: '2' });

    expect(requiredOverGuardrailInput(guardrailedConfig(overGuardrailInput))()).toEqual({
      amountNanoUsd: '2',
    });
  });

  it('describeAdminOp refuses a durable op that ships no interleaving battery', () => {
    expect(() => {
      describeAdminOp(durableConfig());
    }).toThrow(/must supply interleaving/);
  });

  it('describeAdminOp refuses a config whose over-cap input matches no declared cap', () => {
    expect(() => {
      describeAdminOp(caplessConfig(contractWithInverse('fixture.undo')));
    }).toThrow(/must not supply overGuardrailInput/);
  });

  it('ephemeralProbes throws when the harness carries no probes', () => {
    const harness = { ephemeral: undefined } as unknown as AdminOpHarnessInstance;

    expect(() => ephemeralProbes(harness)).toThrow(/harness\.ephemeral/);
  });

  it('ephemeralProbes returns the harness probes when present', () => {
    const probes = { log: (): readonly string[] => [], armFailure: (): void => undefined };
    const harness = { ephemeral: probes } as unknown as AdminOpHarnessInstance;

    expect(ephemeralProbes(harness)).toBe(probes);
  });

  it('runSeededActions throws on an empty action set', async () => {
    const harness = {} as unknown as AdminOpHarnessInstance;

    await expect(
      runSeededActions(
        harness,
        { seeds: [1], stepsPerSeed: 1, opInput: () => ({}), actions: [] },
        seededRng(1)
      )
    ).rejects.toThrow(/at least one action/);
  });

  it('winnerOfConcurrentRace throws when nothing committed', () => {
    expect(() => winnerOfConcurrentRace([err(conflictError('in progress'))])).toThrow(
      /committed nothing/
    );
  });

  it('winnerOfConcurrentRace fails the battery on a non-conflict loser', () => {
    expect(() => winnerOfConcurrentRace([err(validationError('wrong'))])).toThrow(/conflict/);
  });

  it('winnerOfConcurrentRace returns the winner and requires a replay to match it', () => {
    const winner = resultWithInverseInput(null);

    expect(winnerOfConcurrentRace([ok(winner), err(conflictError('in progress'))])).toBe(winner);
    expect(winnerOfConcurrentRace([ok(winner), ok({ ...winner })])).toBe(winner);
  });
});

/**
 * The obligation a declared money cap places on a battery is a BUILD-time one
 * for any config whose contract keeps its declaration in the type. The pin is
 * each annotation below; `pnpm typecheck` is the instrument — the two shapes
 * transpile to identical JavaScript, so no runtime case can stand in for it.
 *
 * The runtime guard ({@link requiredOverGuardrailInput}) is NOT subsumed and
 * stays: it also refuses the converse (an over-cap input for an op declaring
 * no cap), and it still governs every config whose contract arrives widened to
 * {@link AdminOpContract} — as `guardrailedConfig` and `caplessConfig` build
 * theirs — where the declaration is no longer in the type to read.
 */
describe('the battery obligates a capped op at build time (compile-time)', () => {
  const harness = (): Promise<AdminOpHarnessInstance> =>
    Promise.resolve({} as unknown as AdminOpHarnessInstance);

  it('demands an over-cap input from a capped contract', () => {
    // @ts-expect-error -- fixture.mark declares a money cap, so its battery owes overGuardrailInput
    const missing: DescribeAdminOpConfig<typeof fixtureMarkContract> = {
      contract: fixtureMarkContract,
      createHarness: harness,
      validInput: () => ({}),
      invalidInput: {},
    };

    expect(missing.contract.guardrails.maxAmountNanoUsd).toBe(FIXTURE_AMOUNT_CAP_NANO_USD);
  });

  it('demands no over-cap input from a contract declaring no cap', () => {
    const complete: DescribeAdminOpConfig<typeof fixturePingContract> = {
      contract: fixturePingContract,
      createHarness: harness,
      validInput: () => ({}),
      invalidInput: {},
    };

    expect(complete.contract.guardrails).toBeUndefined();
  });
});

describe('rolesRefusedBy', () => {
  it('names the roles a contract leaves out, which are the ones its battery probes', () => {
    expect(rolesRefusedBy(fixtureMarkContract)).toEqual(['growth-viewer']);
  });

  it('names none when a contract lists every role, so no refusal case is registered', () => {
    expect(rolesRefusedBy(fixtureLookContract)).toEqual([]);
  });
});

describe('assertReadBattery', () => {
  it('refuses a read battery supplying the Iron Law interleaving config', () => {
    expect(() => {
      assertReadBattery({
        contract: fixtureLookContract,
        createHarness: () => {
          throw new Error('unreachable');
        },
        validInput: () => ({}),
        invalidInput: {},
        interleaving: { seeds: [1], stepsPerSeed: 1, opInput: () => ({}), actions: [] },
      });
    }).toThrow(/interleaving/);
  });

  it('refuses a read battery supplying an over-guardrail input', () => {
    expect(() => {
      assertReadBattery({
        contract: fixtureLookContract,
        createHarness: () => {
          throw new Error('unreachable');
        },
        validInput: () => ({}),
        invalidInput: {},
        overGuardrailInput: () => ({}),
      });
    }).toThrow(/overGuardrailInput/);
  });

  it('accepts a read battery that supplies neither mutation-only field', () => {
    expect(() => {
      assertReadBattery({
        contract: fixtureLookContract,
        createHarness: () => {
          throw new Error('unreachable');
        },
        validInput: () => ({}),
        invalidInput: {},
      });
    }).not.toThrow();
  });
});
