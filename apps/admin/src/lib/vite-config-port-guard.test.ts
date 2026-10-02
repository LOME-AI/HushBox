import { describe, it, expect, vi, afterEach } from 'vitest';
import config from '../../vite.config';

// The guard fires only when the generated env file the shell is loading has no
// port in it, which is the moment the developer needs to be told which of the
// two stacks' files to regenerate.
describe('the admin dev server’s generated-port guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends a development-stack shell at the development stack’s env files', () => {
    vi.stubEnv('HB_ENV_MODE', 'development');
    vi.stubEnv('HB_ADMIN_PORT', '');

    expect(() => config({ command: 'serve', mode: 'development' })).toThrow(
      "HB_ADMIN_PORT is not set for the development stack — run `pnpm generate:env --mode=development` to regenerate that stack's env files"
    );
  });

  it('sends an end-to-end shell at the end-to-end stack’s env files, not the development ones', () => {
    vi.stubEnv('HB_ENV_MODE', 'e2e');
    vi.stubEnv('HB_ADMIN_PORT', '');

    expect(() => config({ command: 'serve', mode: 'e2e' })).toThrow(
      "HB_ADMIN_PORT is not set for the e2e stack — run `pnpm generate:env --mode=e2e` to regenerate that stack's env files"
    );
  });
});
