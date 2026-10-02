import { describe, expect, it } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import * as jobsBarrel from './index.js';
import {
  collectJobWake,
  createJobWakeCollector,
  dischargeJobWakes,
  grantJobWakes,
  jobWakesOf,
  runWithJobWakes,
} from './wake-capability.js';
import type { JobWakeCapable, JobWakeCollector } from './wake-capability.js';
import type { JobDispatcherNamespace } from './wake.js';

describe('the job-wake capability', () => {
  it('records a shard collected through a granted handle', () => {
    const collector = createJobWakeCollector();
    const handle = grantJobWakes({ writer: 'db' }, collector);

    collectJobWake(handle, 'default');

    expect(collector.shards()).toEqual(['default']);
  });

  it('grants the capability on the handle itself, so the underlying writer still works', () => {
    const collector = createJobWakeCollector();
    const handle = { writer: 'db' };

    const granted = grantJobWakes(handle, collector);

    expect(granted).toBe(handle);
    expect(granted.writer).toBe('db');
  });
});

interface WakeNamespaceStub {
  readonly namespace: JobDispatcherNamespace;
  readonly woken: string[];
}

function wakeNamespace(outcome: 'ok' | 'reject' = 'ok'): WakeNamespaceStub {
  const woken: string[] = [];
  return {
    woken,
    namespace: {
      idFromName: (name: string) => name,
      get: (id) => ({
        fetch: () => {
          woken.push(String(id));
          return outcome === 'reject'
            ? Promise.reject(new Error('dispatcher unreachable'))
            : Promise.resolve();
        },
      }),
    },
  };
}

interface FakeWriter {
  readonly writer: string;
}

/** Stands in for the consumers that will demand a capability-bearing handle. */
function enqueueLike(handle: JobWakeCapable<FakeWriter>): string {
  collectJobWake(handle, 'bulk');
  return handle.writer;
}

describe('discharging collected job wakes', () => {
  it('satisfies a consumer that demands a capability-bearing handle', () => {
    const collector = createJobWakeCollector();

    expect(enqueueLike(grantJobWakes({ writer: 'db' }, collector))).toBe('db');
    expect(collector.shards()).toEqual(['bulk']);
  });

  it('wakes the dispatcher once per collected shard', async () => {
    const collector = createJobWakeCollector();
    const handle = grantJobWakes({}, collector);
    collectJobWake(handle, 'default');
    collectJobWake(handle, 'bulk');
    const stub = wakeNamespace();

    await dischargeJobWakes({ JOB_DISPATCHER: stub.namespace }, collector);

    expect(stub.woken).toEqual(['default', 'bulk']);
  });

  it('wakes a repeatedly collected shard once', async () => {
    const collector = createJobWakeCollector();
    const handle = grantJobWakes({}, collector);
    collectJobWake(handle, 'default');
    collectJobWake(handle, 'default');
    collectJobWake(handle, 'default');
    const stub = wakeNamespace();

    await dischargeJobWakes({ JOB_DISPATCHER: stub.namespace }, collector);

    expect(stub.woken).toEqual(['default']);
  });

  it('wakes nothing when no shard was collected', async () => {
    const stub = wakeNamespace();

    await dischargeJobWakes({ JOB_DISPATCHER: stub.namespace }, createJobWakeCollector());

    expect(stub.woken).toEqual([]);
  });

  it('is a no-op when the context has no dispatcher binding', async () => {
    const collector = createJobWakeCollector();
    collectJobWake(grantJobWakes({}, collector), 'default');

    await expect(dischargeJobWakes({}, collector)).resolves.toBeUndefined();
  });

  it('resolves when every wake fails', async () => {
    const collector = createJobWakeCollector();
    const handle = grantJobWakes({}, collector);
    collectJobWake(handle, 'default');
    collectJobWake(handle, 'bulk');
    const stub = wakeNamespace('reject');

    await expect(
      dischargeJobWakes({ JOB_DISPATCHER: stub.namespace }, collector)
    ).resolves.toBeUndefined();
    expect(stub.woken).toEqual(['default', 'bulk']);
  });
});

describe('reading the collector a handle carries', () => {
  it('returns the collector the handle was granted', () => {
    const collector = createJobWakeCollector();

    expect(jobWakesOf(grantJobWakes({ writer: 'db' }, collector))).toBe(collector);
  });

  it('answers undefined rather than throwing for a handle no scope granted', () => {
    expect(jobWakesOf({ writer: 'db' })).toBeUndefined();
  });
});

describe('running a transaction body under a merge-on-commit scope', () => {
  it('merges the shards the body collected into the handle collector', async () => {
    const parent = createJobWakeCollector();
    const handle = grantJobWakes({ writer: 'db' }, parent);

    await runWithJobWakes(handle, (collected) => {
      collectJobWake(grantJobWakes({ writer: 'tx' }, collected), 'default');
      return Promise.resolve('committed');
    });

    expect(parent.shards()).toEqual(['default']);
  });

  it('merges nothing into the handle collector when the body throws', async () => {
    const parent = createJobWakeCollector();
    const handle = grantJobWakes({ writer: 'db' }, parent);

    await expect(
      runWithJobWakes(handle, (collected) => {
        collectJobWake(grantJobWakes({ writer: 'tx' }, collected), 'default');
        return Promise.reject(new Error('body aborted'));
      })
    ).rejects.toThrow('body aborted');

    expect(parent.shards()).toEqual([]);
  });

  it('returns the body result for a handle no scope granted', async () => {
    await expect(
      runWithJobWakes({ writer: 'db' }, (collected) => {
        collectJobWake(grantJobWakes({ writer: 'tx' }, collected), 'default');
        return Promise.resolve('committed');
      })
    ).resolves.toBe('committed');
  });

  it('wakes a shard two bodies both collected once', async () => {
    const parent = createJobWakeCollector();
    const handle = grantJobWakes({ writer: 'db' }, parent);
    const collectBulk = (collected: JobWakeCollector): Promise<void> => {
      collectJobWake(grantJobWakes({ writer: 'tx' }, collected), 'bulk');
      return Promise.resolve();
    };
    const stub = wakeNamespace();

    await runWithJobWakes(handle, collectBulk);
    await runWithJobWakes(handle, collectBulk);
    await dischargeJobWakes({ JOB_DISPATCHER: stub.namespace }, parent);

    expect(stub.woken).toEqual(['bulk']);
  });

  it('leaves the body collector holding what it collected', async () => {
    const parent = createJobWakeCollector();
    const handle = grantJobWakes({ writer: 'db' }, parent);
    let body: JobWakeCollector | undefined;

    await runWithJobWakes(handle, (collected) => {
      body = collected;
      collectJobWake(grantJobWakes({ writer: 'tx' }, collected), 'default');
      return Promise.resolve();
    });

    // Merging COPIES rather than drains, so the body's own collector still
    // holds its shard after the scope has merged it upward.
    expect(body?.shards()).toEqual(['default']);
    expect(parent.shards()).toEqual(['default']);
  });

  it('leaves the handle collector alone when the body collected nothing', async () => {
    const parent = createJobWakeCollector();
    const handle = grantJobWakes({ writer: 'db' }, parent);
    collectJobWake(handle, 'default');

    await runWithJobWakes(handle, () => Promise.resolve());

    expect(parent.shards()).toEqual(['default']);
  });
});

describe('the jobs barrel', () => {
  it('publishes the wake capability, which slice code reaches only through it', () => {
    expectExposes(
      jobsBarrel,
      'createJobWakeCollector',
      'grantJobWakes',
      'collectJobWake',
      'dischargeJobWakes'
    );
  });

  it('publishes the tolerant collector read a scope-observing caller needs', () => {
    expectExposes(jobsBarrel, 'jobWakesOf');
  });

  it('publishes the merge-on-commit scope both transaction openers run inside', () => {
    expectExposes(jobsBarrel, 'runWithJobWakes');
  });
});
