import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { adbPortForShard } from '../../mobile-test.js';
import { runEmulatorContainer } from '../mobile/mobile-image.js';
import {
  CONTAINER_OWNED_PORTS,
  HOST_BOUND_PORT_ENVS,
  MODE_BANDED_PORT_ENVS,
  hostBoundPortEnvNames,
  portEnvName,
} from './dev-ports.js';
import { SERVICES, SERVICE_KEYS } from './port-plan.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const mockExeca = vi.mocked(execa);

/** The port key whose generated variable holds this number, as its variable name. */
function portEnvNameForNumber(port: number): string {
  const key = SERVICE_KEYS.find(
    (candidate) => Number(process.env[portEnvName(candidate)]) === port
  );
  if (key === undefined) throw new Error(`no generated port variable holds ${String(port)}`);
  return portEnvName(key);
}

/** Host ports `docker-compose.yml` publishes, read off its port mappings. */
function composePublishedPortEnvNames(): string[] {
  const compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  return [...compose.matchAll(/\$\{(HB_[A-Z0-9_]+_PORT)/g)].map((match) => String(match[1]));
}

/**
 * Host ports the Android emulator container publishes, read off the `docker run`
 * it is launched with — including the noVNC option, so a viewer port published
 * only when that is on would be counted.
 */
async function emulatorPublishedPortEnvNames(): Promise<string[]> {
  await runEmulatorContainer({
    name: 'probe',
    hostAdbPort: adbPortForShard(0),
    imageTag: 'probe:tag',
    kvmGid: '0',
    includeVnc: true,
  });
  const run = mockExeca.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('run'));
  const args = [...((run?.[1] ?? []) as readonly string[])];
  return args
    .filter((_, index) => args[index - 1] === '-p')
    .map((mapping) => portEnvNameForNumber(Number(mapping.split(':')[0])));
}

async function containerPublishedPortEnvNames(): Promise<string[]> {
  return [...composePublishedPortEnvNames(), ...(await emulatorPublishedPortEnvNames())].toSorted(
    (left, right) => left.localeCompare(right)
  );
}

describe('portEnvName', () => {
  it('spells a single-word port key as HB_<WORD>_PORT', () => {
    expect(portEnvName('vite')).toBe('HB_VITE_PORT');
  });

  it('splits a camelCase port key on the word boundary', () => {
    expect(portEnvName('redisHttp')).toBe('HB_REDIS_HTTP_PORT');
  });
});

describe('hostBoundPortEnvNames', () => {
  it('names a port key it has never seen before', () => {
    const names = hostBoundPortEnvNames([...SERVICE_KEYS, 'freshService']);

    expect(names).toContain('HB_FRESH_SERVICE_PORT');
  });

  it('drops the container-owned keys', () => {
    const names = hostBoundPortEnvNames(['vite', 'postgres']);

    expect(names).toStrictEqual(['HB_VITE_PORT']);
  });
});

describe('HOST_BOUND_PORT_ENVS', () => {
  it('covers the marketing dev server', () => {
    expect(HOST_BOUND_PORT_ENVS).toContain('HB_ASTRO_PORT');
  });

  it('holds every minted port that is not container-owned', () => {
    const expected = SERVICE_KEYS.filter((key) => !CONTAINER_OWNED_PORTS.has(key)).map((key) =>
      portEnvName(key)
    );

    expect([...HOST_BOUND_PORT_ENVS]).toStrictEqual(expected);
  });
});

describe('MODE_BANDED_PORT_ENVS', () => {
  it('holds every host-bound port but the idle daemon sentinel', () => {
    const expected = HOST_BOUND_PORT_ENVS.filter((name) => name !== portEnvName('idleDaemon'));

    expect([...MODE_BANDED_PORT_ENVS]).toStrictEqual(expected);
  });

  it('leaves every container-published port on one band across modes', () => {
    for (const key of SERVICE_KEYS) {
      if (SERVICES[key].owner !== 'container') continue;

      expect(MODE_BANDED_PORT_ENVS).not.toContain(portEnvName(key));
    }
  });
});

describe('CONTAINER_OWNED_PORTS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
  });

  it('names exactly the host ports this stack publishes from a container', async () => {
    const published = await containerPublishedPortEnvNames();

    const owned = [...CONTAINER_OWNED_PORTS]
      .map((key) => portEnvName(key))
      .toSorted((left, right) => left.localeCompare(right));

    expect(owned).toStrictEqual(published);
  });
});
