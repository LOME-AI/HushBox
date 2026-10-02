import { describe, it, expect } from 'vitest';

describe('the daemon entry module', () => {
  it('starts no daemon when it is imported rather than executed', async () => {
    // Its self-execution guard is the whole of this file's behaviour. Without
    // it, importing here would parse the test runner's own argv as the daemon's
    // flags, fail, and take the runner's process down with `process.exit(1)`.
    await expect(import('./idle-killer-daemon-entry.js')).resolves.toBeDefined();
  });
});
