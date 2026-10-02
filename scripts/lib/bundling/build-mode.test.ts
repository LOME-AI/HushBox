import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ENV_MODE_VARIABLE } from '../stack/stack-mode.js';
import {
  buildEnvMode,
  frontendEnvFile,
  frontendEnvFilePlugin,
  missingFrontendEnvFile,
} from './build-mode.js';
import type { ConfigEnv, UserConfig } from 'vite';

function configHook(plugin: ReturnType<typeof frontendEnvFilePlugin>): (env: ConfigEnv) => void {
  const hook = plugin.config;
  if (typeof hook !== 'function') throw new Error('the plugin declares no config hook');
  return (env) => {
    const result = hook.call(undefined as never, {} as UserConfig, env);
    expect(result).toBeUndefined();
  };
}

const BUILD: Omit<ConfigEnv, 'mode'> = { command: 'build', isSsrBuild: false, isPreview: false };

describe('the mode a build resolves', () => {
  it('takes the mode the selector names', () => {
    expect(buildEnvMode({ [ENV_MODE_VARIABLE]: 'e2e' })).toBe('e2e');
  });

  it('takes the test stack under that selector', () => {
    expect(buildEnvMode({ [ENV_MODE_VARIABLE]: 'test' })).toBe('test');
  });

  it('resolves the stack a runner mode stands in for, whose file that build bakes', () => {
    expect(buildEnvMode({ [ENV_MODE_VARIABLE]: 'ciE2E' })).toBe('e2e');
  });

  it('resolves production where the selector names it', () => {
    expect(buildEnvMode({ [ENV_MODE_VARIABLE]: 'production' })).toBe('production');
  });

  it('refuses a selector that names no mode at all', () => {
    expect(() => buildEnvMode({ [ENV_MODE_VARIABLE]: 'staging' })).toThrow('staging');
  });
});

describe('a build whose selector names nothing', () => {
  it('refuses rather than resolving a mode of its own', () => {
    expect(() => buildEnvMode({})).toThrow(ENV_MODE_VARIABLE);
  });

  it('refuses an empty selector the same way', () => {
    expect(() => buildEnvMode({ [ENV_MODE_VARIABLE]: '' })).toThrow(ENV_MODE_VARIABLE);
  });

  it('names how to set the selector, so the refusal is a repair', () => {
    expect(() => buildEnvMode({})).toThrow(`${ENV_MODE_VARIABLE}=production`);
  });

  it('lists the modes the selector accepts', () => {
    expect(() => buildEnvMode({})).toThrow('development');
  });
});

describe('the file a mode names', () => {
  it('is the generated frontend file of that mode', () => {
    expect(frontendEnvFile('e2e')).toBe('.env.e2e');
  });

  it('names both the mode and the file it looked for', () => {
    const message = missingFrontendEnvFile('production', '.env.production');

    expect(message).toContain('production');
    expect(message).toContain('.env.production');
    expect(message).toContain('pnpm generate:env --mode=production');
  });

  it('names the selector where the mode is the one that runs no stack', () => {
    expect(missingFrontendEnvFile('production', '.env.production')).toContain(ENV_MODE_VARIABLE);
  });

  it('leaves the selector out where the mode runs a stack', () => {
    expect(missingFrontendEnvFile('e2e', '.env.e2e')).not.toContain(ENV_MODE_VARIABLE);
  });
});

describe('a build whose mode names a missing file', () => {
  it('fails naming the mode and the file', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'build-mode-'));
    const run = configHook(frontendEnvFilePlugin(rootDir));

    expect(() => {
      run({ ...BUILD, mode: 'production' });
    }).toThrow(missingFrontendEnvFile('production', '.env.production'));
  });

  it('passes once that file exists', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'build-mode-'));
    writeFileSync(path.join(rootDir, '.env.production'), '');
    const run = configHook(frontendEnvFilePlugin(rootDir));

    expect(() => {
      run({ ...BUILD, mode: 'production' });
    }).not.toThrow();
  });

  it('leaves a command that builds nothing alone', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'build-mode-'));
    const run = configHook(frontendEnvFilePlugin(rootDir));

    expect(() => {
      run({ ...BUILD, command: 'serve', mode: 'production' });
    }).not.toThrow();
  });
});
