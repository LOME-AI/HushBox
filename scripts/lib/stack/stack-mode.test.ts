import { describe, it, expect } from 'vitest';

import { Mode } from '@hushbox/shared';
import { STACK_MODES, type StackMode } from './port-plan.js';
import {
  ENV_MODE_VARIABLE,
  DEFAULT_ENV_MODE,
  envModeForStack,
  envModeFrom,
  envModeOrDefault,
  frontendModeFor,
  isPerCheckoutMode,
  stackModeFrom,
  stackModeFor,
  writesStackFiles,
} from './stack-mode.js';

describe('envModeFrom', () => {
  it('answers no mode when nothing names one', () => {
    expect(envModeFrom({})).toBeUndefined();
  });

  it('answers no mode when the variable is empty', () => {
    expect(envModeFrom({ [ENV_MODE_VARIABLE]: '' })).toBeUndefined();
  });

  it('answers every mode the registry declares', () => {
    for (const mode of Object.values(Mode)) {
      expect(envModeFrom({ [ENV_MODE_VARIABLE]: mode })).toBe(mode);
    }
  });

  it('refuses a value that names no mode, listing the ones that do', () => {
    expect(() => envModeFrom({ [ENV_MODE_VARIABLE]: 'staging' })).toThrow(
      new RegExp(`${ENV_MODE_VARIABLE}.*staging.*${Object.values(Mode).join(', ')}`)
    );
  });
});

describe('envModeOrDefault', () => {
  it('answers the default mode when nothing names one', () => {
    expect(envModeOrDefault({})).toBe(DEFAULT_ENV_MODE);
  });

  it('answers the default mode when the variable is empty', () => {
    expect(envModeOrDefault({ [ENV_MODE_VARIABLE]: '' })).toBe(DEFAULT_ENV_MODE);
  });

  it('answers the mode the variable names', () => {
    for (const mode of Object.values(Mode)) {
      expect(envModeOrDefault({ [ENV_MODE_VARIABLE]: mode })).toBe(mode);
    }
  });
});

describe('stackModeFrom', () => {
  it('selects the unsuffixed stack when nothing names one', () => {
    expect(stackModeFrom({})).toBe('development');
  });

  it('selects the unsuffixed stack when the variable is empty', () => {
    expect(stackModeFrom({ [ENV_MODE_VARIABLE]: '' })).toBe('development');
  });

  it('selects the stack of the mode the variable names', () => {
    for (const mode of Object.values(Mode)) {
      expect(stackModeFrom({ [ENV_MODE_VARIABLE]: mode })).toBe(stackModeFor(mode));
    }
  });

  it('selects a stack for a runner mode, which names no stack of its own', () => {
    expect(stackModeFrom({ [ENV_MODE_VARIABLE]: Mode.CiE2E })).toBe('e2e');
  });

  it('refuses a value that names no mode, listing the ones that do', () => {
    expect(() => stackModeFrom({ [ENV_MODE_VARIABLE]: 'staging' })).toThrow(
      new RegExp(`${ENV_MODE_VARIABLE}.*staging.*${Object.values(Mode).join(', ')}`)
    );
  });
});

describe('stackModeFor', () => {
  it('gives every env mode a stack the plan declares', () => {
    for (const mode of Object.values(Mode)) {
      expect(STACK_MODES).toContain(stackModeFor(mode));
    }
  });

  it('leaves the development stack to the development mode', () => {
    expect(stackModeFor(Mode.Development)).toBe('development');
  });

  it('gives local and CI end-to-end runs the one end-to-end stack', () => {
    expect(stackModeFor(Mode.E2E)).toBe('e2e');
    expect(stackModeFor(Mode.CiE2E)).toBe('e2e');
  });

  it('gives a vitest run a stack of its own, sharing no data plane with development', () => {
    expect(stackModeFor(Mode.CiVitest)).toBe('test');
  });

  it('gives local and CI vitest runs the one test stack', () => {
    expect(stackModeFor(Mode.Test)).toBe('test');
    expect(stackModeFor(Mode.CiVitest)).toBe('test');
  });

  it('allocates production nothing of its own, having no local stack to name', () => {
    expect(stackModeFor(Mode.Production)).toBe('development');
  });
});

describe('isPerCheckoutMode', () => {
  it('holds for the modes a developer regenerates a stack under', () => {
    expect(isPerCheckoutMode(Mode.Development)).toBe(true);
    expect(isPerCheckoutMode(Mode.Test)).toBe(true);
    expect(isPerCheckoutMode(Mode.E2E)).toBe(true);
  });

  it('does not hold for a mode that only stands in for a stack', () => {
    expect(isPerCheckoutMode(Mode.CiVitest)).toBe(false);
    expect(isPerCheckoutMode(Mode.CiE2E)).toBe(false);
    expect(isPerCheckoutMode(Mode.Production)).toBe(false);
  });

  it('names exactly one mode per stack, so no stack is written by two or none', () => {
    const owners = Object.values(Mode).filter((mode) => isPerCheckoutMode(mode));

    expect(new Set(owners.map((mode) => stackModeFor(mode)))).toStrictEqual(new Set(STACK_MODES));
    expect(owners).toHaveLength(STACK_MODES.length);
  });
});

describe('writesStackFiles', () => {
  /**
   * Two fields can contradict each other: a mode declared as a stack's own
   * writer while declared not to run it would leave `envModeForStack` naming a
   * mode that writes nothing, and the stack unregenerable with nothing saying
   * so. Nothing else compares the two.
   */
  it('holds for every mode a checkout regenerates a stack under', () => {
    const owners = Object.values(Mode).filter((mode) => isPerCheckoutMode(mode));

    expect(owners.filter((mode) => !writesStackFiles(mode))).toEqual([]);
  });
});

describe('frontendModeFor', () => {
  it('answers a declared stack for every mode that runs one', () => {
    for (const mode of Object.values(Mode).filter((candidate) => writesStackFiles(candidate))) {
      expect(frontendModeFor(mode)).toBe(stackModeFor(mode));
    }
  });

  it('answers the mode itself where it runs no stack', () => {
    for (const mode of Object.values(Mode).filter((candidate) => !writesStackFiles(candidate))) {
      expect(frontendModeFor(mode)).toBe(mode);
    }
  });
});

describe('envModeForStack', () => {
  it('answers the mode a regeneration of that stack is asked for', () => {
    expect(envModeForStack('test')).toBe(Mode.Test);
  });

  it('round-trips every declared stack', () => {
    for (const stackMode of STACK_MODES) {
      expect(stackModeFor(envModeForStack(stackMode))).toBe(stackMode);
    }
  });

  it('refuses a stack no env mode writes, naming it', () => {
    expect(() => envModeForStack('staging' as StackMode)).toThrow(/staging/);
  });
});
