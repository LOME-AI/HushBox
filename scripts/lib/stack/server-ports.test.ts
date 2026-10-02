import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_KEYS, portFor } from './port-plan.js';
import { portEnvName } from './dev-ports.js';
import { portForServer, portsForServers, serversRunningScript } from './server-ports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('serversRunningScript', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-ports-'));
    await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writePackage(dir: string, manifest: unknown): Promise<void> {
    const target = path.join(root, 'apps', dir);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(manifest), 'utf8');
  }

  it('names every workspace package whose manifest declares the script', async () => {
    await writePackage('one', { name: '@fixture/one', scripts: { dev: 'vite' } });
    await writePackage('two', { name: '@fixture/two', scripts: { dev: 'astro dev' } });

    expect(serversRunningScript('dev', root)).toEqual([
      { workspace: '@fixture/one', script: 'dev' },
      { workspace: '@fixture/two', script: 'dev' },
    ]);
  });

  it('leaves out a package whose manifest declares no scripts at all', async () => {
    await writePackage('one', { name: '@fixture/one', scripts: { dev: 'vite' } });
    await writePackage('two', { name: '@fixture/two' });

    expect(serversRunningScript('dev', root)).toEqual([
      { workspace: '@fixture/one', script: 'dev' },
    ]);
  });

  it('leaves out a package that declares no such script', async () => {
    await writePackage('one', { name: '@fixture/one', scripts: { dev: 'vite' } });
    await writePackage('two', { name: '@fixture/two', scripts: { build: 'vite build' } });

    expect(serversRunningScript('dev', root)).toEqual([
      { workspace: '@fixture/one', script: 'dev' },
    ]);
  });
});

describe('the dev task fan-out over this workspace', () => {
  /** Every generated port variable of one stack, as the wrapper would load them. */
  const GENERATED: NodeJS.ProcessEnv = Object.fromEntries(
    SERVICE_KEYS.map((service) => [
      portEnvName(service),
      String(portFor(service, { slot: 0, mode: 'development' })),
    ])
  );

  it('states the ports of every package it fans out to', () => {
    expect(() => portsForServers(serversRunningScript('dev', REPO_ROOT), GENERATED)).not.toThrow();
  });

  it('claims no port of a mode-banded server another command starts', () => {
    const claimed = portsForServers(serversRunningScript('dev', REPO_ROOT), GENERATED);

    for (const elsewhere of ['preview', 'docket', 'readmePreview', 'emulatorVnc'] as const) {
      expect(claimed).not.toContain(portFor(elsewhere, { slot: 0, mode: 'development' }));
    }
  });
});

describe('portsForServers', () => {
  const web = { workspace: '@hushbox/web', script: 'dev' };
  const api = { workspace: '@hushbox/api', script: 'dev' };

  it('reads each bound port from the variable the server itself reads', () => {
    const env = { HB_VITE_PORT: '10000', HB_API_PORT: '10400', HB_API_INSPECTOR_PORT: '13100' };

    expect(portsForServers([web, api], env)).toEqual([10_000, 10_400, 13_100]);
  });

  it('names a port once when two of the servers bind it', () => {
    const env = { HB_STUDIO_PORT: '12000' };
    const studio = { workspace: '@hushbox/db', script: 'db:studio' };

    expect(portsForServers([{ ...studio, script: 'dev' }, studio], env)).toEqual([12_000]);
  });

  it('refuses a server whose ports nothing states, naming it', () => {
    expect(() => portsForServers([{ workspace: '@fixture/new', script: 'dev' }], {})).toThrow(
      '@fixture/new'
    );
  });

  it('refuses a bound port whose variable the generated env never wrote', () => {
    expect(() => portsForServers([web], {})).toThrow('HB_VITE_PORT');
  });

  it('refuses a port variable carrying no port rather than claiming NaN', () => {
    expect(() => portsForServers([web], { HB_VITE_PORT: 'nine' })).toThrow('HB_VITE_PORT');
  });

  it('refuses a port variable present but empty, which names no stack either', () => {
    expect(() => portsForServers([web], { HB_VITE_PORT: '' })).toThrow('HB_VITE_PORT');
  });

  it('refuses a port number no socket can bind', () => {
    expect(() => portsForServers([web], { HB_VITE_PORT: '0' })).toThrow('HB_VITE_PORT');
  });

  it('refuses a script the declaration does not cover for a package it does name', () => {
    expect(() => portsForServers([{ workspace: '@hushbox/web', script: 'start' }], {})).toThrow(
      '@hushbox/web'
    );
  });
});

describe('portForServer', () => {
  it('hands back the one port a single-port server binds', () => {
    expect(
      portForServer({ workspace: '@hushbox/web', script: 'preview' }, { HB_PREVIEW_PORT: '10200' })
    ).toBe(10_200);
  });

  it('refuses a server binding more than one, which no command line can name', () => {
    expect(() =>
      portForServer(
        { workspace: '@hushbox/api', script: 'dev' },
        { HB_API_PORT: '10400', HB_API_INSPECTOR_PORT: '13100' }
      )
    ).toThrow('@hushbox/api');
  });
});
