import { describe, it, expect } from 'vitest';
import { config } from 'zod';
import './zod-jitless.ts';

describe('the jitless door', () => {
  it('leaves the JIT probe disabled for every schema built after it', () => {
    // Importing the module is the whole contract: it exports nothing, so a
    // consumer cannot apply the setting too late by forgetting to call it.
    expect(config().jitless).toBe(true);
  });
});
