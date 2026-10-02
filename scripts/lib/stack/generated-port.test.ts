import { describe, it, expect } from 'vitest';
import { STACK_MODES } from './port-plan.js';
import { envModeForStack } from './stack-mode.js';
import { missingPortVariable } from './generated-port.js';

describe('missingPortVariable', () => {
  it('sends a development-stack shell at the development stack’s env files', () => {
    expect(missingPortVariable('HB_API_PORT', 'development')).toBe(
      "HB_API_PORT is not set for the development stack — run `pnpm generate:env --mode=development` to regenerate that stack's env files"
    );
  });

  it('sends an end-to-end shell at the end-to-end stack’s env files, not the development ones', () => {
    expect(missingPortVariable('HB_VITE_PORT', 'e2e')).toBe(
      "HB_VITE_PORT is not set for the e2e stack — run `pnpm generate:env --mode=e2e` to regenerate that stack's env files"
    );
  });

  it('sends a vitest shell at the test stack’s env files, not the development ones', () => {
    expect(missingPortVariable('HB_API_PORT', 'test')).toBe(
      "HB_API_PORT is not set for the test stack — run `pnpm generate:env --mode=test` to regenerate that stack's env files"
    );
  });

  it('names a mode that regenerates the stack it is asked about, for every stack', () => {
    for (const stackMode of STACK_MODES) {
      expect(missingPortVariable('HB_API_PORT', stackMode)).toContain(
        `--mode=${envModeForStack(stackMode)}`
      );
    }
  });
});
