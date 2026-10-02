import { describe, it, expect, afterEach, vi } from 'vitest';
import { Mode } from '@hushbox/shared';
import { stackModeFor } from '../../generate-env.js';
import { ENV_MODE_VARIABLE } from '../../with-env.js';
import requireE2eStack from './require-e2e-stack.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the stack a Playwright run demands', () => {
  it('admits a run that loaded the end-to-end stack', () => {
    vi.stubEnv(ENV_MODE_VARIABLE, Mode.E2E);

    expect(() => {
      requireE2eStack();
    }).not.toThrow();
  });

  it('admits the runner mode that stands in for that same stack', () => {
    vi.stubEnv(ENV_MODE_VARIABLE, Mode.CiE2E);

    expect(() => {
      requireE2eStack();
    }).not.toThrow();
  });

  it('refuses a run that loaded another stack, naming the one it loaded', () => {
    vi.stubEnv(ENV_MODE_VARIABLE, Mode.Development);

    expect(() => {
      requireE2eStack();
    }).toThrow(stackModeFor(Mode.Development));
  });

  it('names the stack it wanted, so the refusal says what to run instead', () => {
    vi.stubEnv(ENV_MODE_VARIABLE, Mode.Development);

    expect(() => {
      requireE2eStack();
    }).toThrow(stackModeFor(Mode.E2E));
  });

  it('refuses a run that loaded no stack at all', () => {
    // Absence, not emptiness, is the case: a Playwright started outside the env
    // wrapper has never heard of the variable. Removed through `Reflect` because
    // the `delete` operator is banned on a computed key.
    Reflect.deleteProperty(process.env, ENV_MODE_VARIABLE);

    expect(() => {
      requireE2eStack();
    }).toThrow(ENV_MODE_VARIABLE);
  });
});
