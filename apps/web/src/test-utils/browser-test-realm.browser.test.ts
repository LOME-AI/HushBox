import { describe, expect, it } from 'vitest';

// A real-browser test drives a spawned browser from Node. A DOM emulator installed in its
// realm sends real requests to the emulator's origin for code the test process loads.
describe('real-browser test realm', () => {
  it('has no window', () => {
    expect('window' in globalThis).toBe(false);
  });

  it('has no XMLHttpRequest', () => {
    expect('XMLHttpRequest' in globalThis).toBe(false);
  });
});
