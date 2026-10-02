import { afterEach, describe, expect, it, vi } from 'vitest';
import webConfig from '../../../vite.config';

// A manual chunk group pulls every dependency of what it captures into itself,
// and `main.tsx` imports streamdown's stylesheet statically, so any group over
// the markdown stack lands that whole stack on every document load and defeats
// the lazy imports that keep it off. The bundler places every module instead.
describe('the web build’s chunking', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('declares no manual chunk rule', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HB_ENV_MODE', 'production');

    const output = webConfig({ command: 'build', mode: 'production' }).build?.rolldownOptions
      ?.output;
    const outputs = output === undefined ? [] : [output].flat();

    expect(outputs.filter((options) => 'manualChunks' in options)).toEqual([]);
  });
});
