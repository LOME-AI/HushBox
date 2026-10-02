import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { expectExposes, pluginNamed } from '@hushbox/shared/test-assertions';
import config from '../../vite.config';
import { MARKETING_PREVIEW_INDEX_PLUGIN_NAME } from './marketing-preview-index.js';
import type { Plugin } from 'vite';

function previewIndexPlugin(): Plugin | undefined {
  return pluginNamed(
    config({ command: 'serve', mode: 'development' }).plugins,
    MARKETING_PREVIEW_INDEX_PLUGIN_NAME
  );
}

describe('the admin config’s marketing preview index rule', () => {
  beforeEach(() => {
    // The config refuses to resolve a served command without the generated
    // ports; vite-config-port-guard.test.ts is where that refusal is covered.
    vi.stubEnv('HB_ADMIN_PORT', '4200');
    vi.stubEnv('HB_API_PORT', '4300');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is wired into the config a served command resolves', () => {
    expect(previewIndexPlugin()).toBeDefined();
  });

  it('installs itself on the development server', () => {
    expectExposes(previewIndexPlugin() ?? {}, 'configureServer');
  });

  it('is confined to a served server, so no build carries it', () => {
    expect(previewIndexPlugin()?.apply).toBe('serve');
  });

  it('leaves the preview server — the reference the development server matches — alone', () => {
    const plugin =
      previewIndexPlugin() ?? expect.fail('the admin config registers no preview index rule');

    expect(plugin.configurePreviewServer).toBeUndefined();
  });
});
