import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { adminBundleOptions } from '../../vite.config';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

// The admin bundle is built inside the workspace build, which hands it no
// prefixed variable, so a shipping build bakes the production file alone and
// nothing in it may differ from that file.
describe('the admin dist the build verifies', () => {
  it('holds a shipping build to the production environment file', () => {
    expect(adminBundleOptions('production').stackEnvFile).toBe(
      path.join(REPO_ROOT, '.env.production')
    );
  });

  it('declares no key a shipping build bakes in place of that file', () => {
    expect(adminBundleOptions('production').overriddenKeys).toBeUndefined();
  });

  it('compares nothing for a build that ships nothing', () => {
    expect(adminBundleOptions('e2e').stackEnvFile).toBeUndefined();
  });
});
