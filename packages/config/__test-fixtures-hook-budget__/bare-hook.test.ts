import { beforeEach, describe, expect, it } from 'vitest';

const OVERRUN_MS = 200;

// A hook declaring nothing: whatever budget the run was given is what measures
// it. The run that reads this corpus hands in a budget far below the overrun,
// so this hook is the control that shows the handed-in number is live.
beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, OVERRUN_MS));
});

describe('a hook that declares no budget of its own', () => {
  it('never reaches its case', () => {
    expect(true).toBe(true);
  });
});
