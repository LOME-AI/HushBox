import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pluginNamed } from '@hushbox/shared/test-assertions';
import { prePaintScriptsPlugin } from '../../../scripts/lib/bundling/pre-paint-scripts-plugin';
import config from '../vite.config';

// This console is served and never built, so nothing emits a shell that could
// be read back for the two pre-paint scripts. Registration in the config the
// dev server resolves is the last point at which their presence is observable
// here, which is why this app asserts the plugin rather than the output.
describe('the docket console’s pre-paint scripts', () => {
  beforeEach(() => {
    // The config refuses to resolve a served command without the generated
    // port; api-plugin.test.ts covers the console's own dev-server wiring.
    vi.stubEnv('HB_DOCKET_PORT', '4100');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reach the shell through the shared plugin the config registers', () => {
    const plugins = config({ command: 'serve', mode: 'development' }).plugins;

    expect(pluginNamed(plugins, prePaintScriptsPlugin().name)).toBeDefined();
  });
});
