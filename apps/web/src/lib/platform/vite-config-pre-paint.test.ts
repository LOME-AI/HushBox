import { describe, it, expect } from 'vitest';
import { pluginNamed } from '@hushbox/shared/test-assertions';
import { prePaintScriptsPlugin } from '../../../../../scripts/lib/bundling/pre-paint-scripts-plugin';
import config from '../../../vite.config';

// The emitted shell is where the bundle verifier checks these two scripts, and
// nothing builds this app on a pull request — so on the branch a change is
// reviewed on, the config is the last place a dropped registration is
// observable. This suite runs on every push and every pre-push, which is what
// keeps that detection at review time rather than at merge time.
describe('the web shell’s pre-paint scripts', () => {
  it('reach the shell through the shared plugin the build config registers', () => {
    const plugins = config({ command: 'build', mode: 'production' }).plugins;

    expect(pluginNamed(plugins, prePaintScriptsPlugin().name)).toBeDefined();
  });
});
