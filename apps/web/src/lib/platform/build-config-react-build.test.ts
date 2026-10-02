import { afterEach, describe, expect, it, vi } from 'vitest';
import webConfig from '../../../vite.config';

// The bundler picks React's build from NODE_ENV, and reads it only after this
// configuration has run. The end-to-end build runs with `development` in its
// environment, so the configuration is what decides the build.
describe('the React build the web app bundles', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds against React’s production build under an inherited development NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HB_ENV_MODE', 'e2e');

    webConfig({ command: 'build', mode: 'e2e' });

    expect(process.env['NODE_ENV']).toBe('production');
  });

  it('leaves the development server on React’s development build', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HB_ENV_MODE', 'development');
    vi.stubEnv('HB_VITE_PORT', '5173');
    vi.stubEnv('HB_API_PORT', '8787');

    webConfig({ command: 'serve', mode: 'development' });

    expect(process.env['NODE_ENV']).toBe('development');
  });
});
