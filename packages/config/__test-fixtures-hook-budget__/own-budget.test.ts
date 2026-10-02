import { beforeEach, describe, expect, it } from 'vitest';

const OWN_BUDGET_MS = 5000;
const OVERRUN_MS = 200;

// The same overrun as the control, under a budget this file declares for
// itself. The run hands in a smaller number, so a case that passes here can
// only have been measured against the declared one.
beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, OVERRUN_MS));
}, OWN_BUDGET_MS);

describe('a hook that declares a budget of its own', () => {
  it('reaches its case', () => {
    expect(true).toBe(true);
  });
});
