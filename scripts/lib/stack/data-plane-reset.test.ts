import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emptyPersistRoot,
  liveDataPlaneLegs,
  resetDataPlane,
  type DataPlaneLegs,
  type DataPlaneTargets,
} from './data-plane-reset.js';
import type { StoreAnswer } from '../claims/world-reading.js';

const TARGETS: DataPlaneTargets = {
  databaseName: 'hushbox_scratch_target',
  redisToken: 'token-of-the-target-pool',
  bucket: 'hushbox-scratch-target',
  persistRoot: path.join(os.tmpdir(), 'persist-root-under-test'),
  browserTmp: path.join(os.tmpdir(), 'browser-tmp-under-test'),
};

const VACANT: StoreAnswer = { kind: 'vacant' };

/** Every leg recording its call into one ordered list. */
function recordingLegs(calls: string[], answer: StoreAnswer = VACANT): DataPlaneLegs {
  return {
    dropDatabase: (name): Promise<void> => {
      calls.push(`dropDatabase ${name}`);
      return Promise.resolve();
    },
    flushRedis: (token): Promise<void> => {
      calls.push(`flushRedis ${token}`);
      return Promise.resolve();
    },
    emptyBucket: (bucket): Promise<void> => {
      calls.push(`emptyBucket ${bucket}`);
      return Promise.resolve();
    },
    probeStore: (root): Promise<StoreAnswer> => {
      calls.push(`probeStore ${root}`);
      return Promise.resolve(answer);
    },
    emptyDirectory: (root): Promise<void> => {
      calls.push(`emptyDirectory ${root}`);
      return Promise.resolve();
    },
  };
}

describe('resetting a data plane', () => {
  it('drops, flushes and empties every target it is handed', async () => {
    const calls: string[] = [];

    await resetDataPlane(TARGETS, recordingLegs(calls));

    expect(calls).toEqual(
      expect.arrayContaining([
        `dropDatabase ${TARGETS.databaseName}`,
        `flushRedis ${TARGETS.redisToken}`,
        `emptyBucket ${TARGETS.bucket}`,
        `emptyDirectory ${TARGETS.persistRoot}`,
        `emptyDirectory ${TARGETS.browserTmp ?? ''}`,
      ])
    );
  });

  it('empties no browser temporary directory where it is handed none', async () => {
    const calls: string[] = [];
    const withoutBrowserDirectory: DataPlaneTargets = {
      databaseName: TARGETS.databaseName,
      redisToken: TARGETS.redisToken,
      bucket: TARGETS.bucket,
      persistRoot: TARGETS.persistRoot,
    };

    await resetDataPlane(withoutBrowserDirectory, recordingLegs(calls));

    expect(calls.filter((call) => call.startsWith('emptyDirectory'))).toEqual([
      `emptyDirectory ${TARGETS.persistRoot}`,
    ]);
  });

  it('asks whether the persist root is occupied before deleting anything', async () => {
    const calls: string[] = [];

    await resetDataPlane(TARGETS, recordingLegs(calls));

    expect(calls[0]).toBe(`probeStore ${TARGETS.persistRoot}`);
  });

  it('refuses with a message naming the persist root while a process holds it', async () => {
    await expect(resetDataPlane(TARGETS, recordingLegs([], { kind: 'occupied' }))).rejects.toThrow(
      TARGETS.persistRoot
    );
  });

  it('deletes nothing when the persist root is occupied', async () => {
    const calls: string[] = [];

    await resetDataPlane(TARGETS, recordingLegs(calls, { kind: 'occupied' })).catch(
      (error: unknown) => error
    );

    expect(calls).toEqual([`probeStore ${TARGETS.persistRoot}`]);
  });

  it('proceeds where the platform cannot say whether the persist root is occupied', async () => {
    const calls: string[] = [];

    await resetDataPlane(
      TARGETS,
      recordingLegs(calls, { kind: 'unknown', reason: 'no process filesystem' })
    );

    expect(calls).toContain(`emptyDirectory ${TARGETS.persistRoot}`);
  });
});

describe('the Redis leg of the live reset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The request the proxy stub received, once `flushRedis` has sent it. */
  function stubProxy(result: unknown): { init: RequestInit | undefined } {
    const received: { init: RequestInit | undefined } = { init: undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
        received.init = init;
        return Promise.resolve(Response.json({ result }));
      })
    );
    return received;
  }

  function legs(): DataPlaneLegs {
    return liveDataPlaneLegs({
      databaseUrl: 'postgres://user:password@localhost:5432/unused',
      redisUrl: 'http://localhost:8079',
      objectStore: { endpoint: 'http://localhost:9000', accessKeyId: 'a', secretAccessKey: 'b' },
    });
  }

  it('sends exactly flushdb, never flushall', async () => {
    const received = stubProxy('OK');

    await legs().flushRedis('the-given-token');

    expect(received.init?.body).toBe(JSON.stringify(['flushdb']));
  });

  it('sends the command through the token it is given', async () => {
    const received = stubProxy('OK');

    await legs().flushRedis('the-given-token');

    expect(new Headers(received.init?.headers).get('Authorization')).toBe('Bearer the-given-token');
  });

  it('refuses an answer other than the one a flush gives', async () => {
    stubProxy(3);

    await expect(legs().flushRedis('the-given-token')).rejects.toThrow('flushdb');
  });
});

describe('the occupancy leg of the live reset', () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a root a process holds a file open in as occupied, where the platform can say', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'hb-persist-root-held-'));
    const held = await open(path.join(root, 'held.sqlite'), 'w');
    try {
      const answer = await liveDataPlaneLegs({
        databaseUrl: 'postgres://user:password@localhost:5432/unused',
        redisUrl: 'http://localhost:8079',
        objectStore: { endpoint: 'http://localhost:9000', accessKeyId: 'a', secretAccessKey: 'b' },
      }).probeStore(root);

      // Only a process filesystem can answer; elsewhere the probe says it cannot.
      expect(answer.kind).toBe(process.platform === 'linux' ? 'occupied' : 'unknown');
    } finally {
      await held.close();
    }
  });
});

describe('emptying a persist root', () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes everything the root holds', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'hb-persist-root-'));
    await writeFile(path.join(root, 'sentinel'), 'left by an earlier run');

    await emptyPersistRoot(root);

    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('treats a root that does not exist yet as already empty', async () => {
    root = path.join(os.tmpdir(), `hb-persist-root-absent-${String(process.pid)}`);

    await expect(emptyPersistRoot(root)).resolves.toBeUndefined();
  });

  it('raises a failure other than the root being absent', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'hb-persist-root-file-'));
    const notADirectory = path.join(root, 'a-file');
    await writeFile(notADirectory, 'not a directory');

    await expect(emptyPersistRoot(notADirectory)).rejects.toThrow('ENOTDIR');
  });
});
