import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import config, {
  resolveNativeWebViewServer,
  resolveWebContentsDebugging,
} from '../capacitor.config';

import type { CapacitorConfig } from '@capacitor/cli';

describe('resolveWebContentsDebugging', () => {
  it('disables WebView debugging for release (production) builds', () => {
    expect(resolveWebContentsDebugging('production')).toBe(false);
  });

  it('enables WebView debugging for development builds', () => {
    expect(resolveWebContentsDebugging('development')).toBe(true);
  });

  it('defaults to disabled when the Capacitor CLI provides no NODE_ENV', () => {
    // An unset env key reads as `undefined` — the real bare-`cap sync` case.
    expect(resolveWebContentsDebugging(process.env['HB_UNSET_NODE_ENV_PROBE'])).toBe(false);
  });

  it('wires the resolved value into the Android config', () => {
    expect(config.android?.webContentsDebuggingEnabled).toBe(
      resolveWebContentsDebugging(process.env['NODE_ENV'])
    );
  });
});

describe('resolveNativeWebViewServer', () => {
  it('serves release (production) builds over https from the app-owned hostname', () => {
    expect(resolveNativeWebViewServer('production')).toEqual({
      hostname: 'native.hushbox.ai',
      androidScheme: 'https',
    });
  });

  it('serves development builds over http from localhost', () => {
    expect(resolveNativeWebViewServer('development')).toEqual({
      hostname: 'localhost',
      androidScheme: 'http',
    });
  });

  it('defaults to the production origin when the Capacitor CLI provides no NODE_ENV', () => {
    expect(resolveNativeWebViewServer(process.env['HB_UNSET_NODE_ENV_PROBE'])).toEqual({
      hostname: 'native.hushbox.ai',
      androidScheme: 'https',
    });
  });

  it('wires the resolved server into the config', () => {
    const { hostname, androidScheme } = resolveNativeWebViewServer(process.env['NODE_ENV']);
    expect(config.server).toMatchObject({ hostname, androidScheme });
  });
});

describe('CapacitorUpdater vendor endpoints', () => {
  it.each(['statsUrl', 'channelUrl', 'updateUrl'] as const)(
    'configures %s as an empty string',
    (key) => {
      expect(config.plugins?.CapacitorUpdater?.[key]).toBe('');
    }
  );
});

describe('Capacitor CLI', () => {
  it('loads the production server block the way cap sync does', () => {
    const cliPackage = createRequire(import.meta.url).resolve('@capacitor/cli/package.json');
    const cliEntry = path.join(path.dirname(cliPackage), 'bin', 'capacitor');
    // A bare `cap sync` runs with NODE_ENV unset.
    const cliEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'NODE_ENV')
    );

    const result = spawnSync(process.execPath, [cliEntry, 'config', '--json'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: cliEnv,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const resolved: { app: { extConfig: CapacitorConfig } } = JSON.parse(result.stdout);
    expect(resolved.app.extConfig.server).toMatchObject({
      hostname: 'native.hushbox.ai',
      androidScheme: 'https',
    });
  }, 60_000);
});
