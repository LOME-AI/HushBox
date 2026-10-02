import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portFor } from '../stack/port-plan.js';
import { stackModeFrom } from '../stack/stack-mode.js';
import { stackSlotFrom } from '../stack/stack-slot.js';
import { declaredWebServers, portsForWebServers } from './e2e-servers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** One stack's generated port variables, each a different number. */
const BANDED_PORTS: NodeJS.ProcessEnv = {
  HB_STACK_SLOT: '0',
  HB_ENV_MODE: 'e2e',
  HB_VITE_PORT: '10100',
  HB_PREVIEW_PORT: '10300',
  HB_API_PORT: '10500',
  HB_ADMIN_PORT: '12300',
  HB_SANDBOX_PORT: '12700',
  HB_API_INSPECTOR_PORT: '13200',
};

describe('portsForWebServers', () => {
  it('reads every declared port of a server started as a workspace package script', () => {
    const servers = [{ name: 'API', command: 'pnpm --filter @hushbox/api dev' }];

    expect(portsForWebServers(servers, BANDED_PORTS)).toEqual([10_500, 13_200]);
  });

  it('reads the port a server names on its own command line', () => {
    const servers = [
      { name: 'Preview', command: 'tsx scripts/e2e-preview.ts --app=web --port=10300' },
    ];

    expect(portsForWebServers(servers, BANDED_PORTS)).toEqual([10_300]);
  });

  it('names a port once when two servers state it', () => {
    const servers = [
      { name: 'Preview', command: 'tsx scripts/e2e-preview.ts --app=web --port=10300' },
      { name: 'Again', command: 'tsx scripts/e2e-preview.ts --app=web --port=10300' },
    ];

    expect(portsForWebServers(servers, BANDED_PORTS)).toEqual([10_300]);
  });

  it('refuses a server whose command states no port at all, naming it', () => {
    const servers = [{ name: 'Mystery', command: 'tsx scripts/some-server.ts' }];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('Mystery');
  });

  it('refuses an unnamed server by its command, which is the only handle it has', () => {
    const servers = [{ command: 'tsx scripts/some-server.ts' }];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('scripts/some-server.ts');
  });

  it('refuses a filtered command naming no script, which runs no package script', () => {
    const servers = [{ name: 'Half', command: 'pnpm --filter @hushbox/web' }];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('Half');
  });

  it('refuses a filtered command whose next word is a flag rather than a script', () => {
    const servers = [{ name: 'Flagged', command: 'pnpm --filter @hushbox/web --silent' }];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('Flagged');
  });

  it('refuses a package script whose bound ports nothing states, naming the package', () => {
    const servers = [{ name: 'New', command: 'pnpm --filter @fixture/new dev' }];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('@fixture/new');
  });

  it('refuses a named port belonging to another stack, which this run never binds', () => {
    const servers = [
      { name: 'Preview', command: 'tsx scripts/e2e-preview.ts --app=web --port=10200' },
    ];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('10200');
  });

  it('refuses a named port the port plan allocates to nothing', () => {
    const servers = [{ name: 'Preview', command: 'tsx scripts/e2e-preview.ts --port=9999' }];

    expect(() => portsForWebServers(servers, BANDED_PORTS)).toThrow('9999');
  });
});

describe('declaredWebServers', () => {
  it('hands back the server list the configuration declares', async () => {
    const load = (): Promise<unknown> =>
      Promise.resolve({ default: { webServer: [{ name: 'API', command: 'pnpm dev' }] } });

    await expect(declaredWebServers(REPO_ROOT, load)).resolves.toEqual([
      { name: 'API', command: 'pnpm dev' },
    ]);
  });

  it('refuses a configuration declaring no readable server list, naming the file', async () => {
    const load = (): Promise<unknown> => Promise.resolve({ default: { webServer: 'one server' } });

    await expect(declaredWebServers(REPO_ROOT, load)).rejects.toThrow('playwright.config.ts');
  });
});

describe('the servers this workspace declares for the end-to-end run', () => {
  it('states the ports of every server the configuration declares', async () => {
    const servers = await declaredWebServers(REPO_ROOT);

    expect(() => portsForWebServers(servers, process.env)).not.toThrow();
  });

  it('claims no port of a mode-banded server another command starts', async () => {
    const servers = await declaredWebServers(REPO_ROOT);
    const claimed = portsForWebServers(servers, process.env);
    const stack = { slot: stackSlotFrom(process.env), mode: stackModeFrom(process.env) };

    for (const elsewhere of [
      'vite',
      'astro',
      'studio',
      'docket',
      'crawlerView',
      'readmePreview',
      'emulatorVnc',
    ] as const) {
      expect(claimed).not.toContain(portFor(elsewhere, stack));
    }
  });

  it('claims the preview, api, inspector, admin and sandbox ports its servers bind', async () => {
    const servers = await declaredWebServers(REPO_ROOT);
    const claimed = portsForWebServers(servers, process.env);
    const stack = { slot: stackSlotFrom(process.env), mode: stackModeFrom(process.env) };

    for (const bound of ['preview', 'api', 'apiInspector', 'admin', 'sandbox'] as const) {
      expect(claimed).toContain(portFor(bound, stack));
    }
  });
});
