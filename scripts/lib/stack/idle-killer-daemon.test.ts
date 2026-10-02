/* eslint-disable @typescript-eslint/require-await -- mock fns intentionally async */
/* eslint-disable sonarjs/publicly-writable-directories -- /tmp paths in test fixtures */
import { describe, it, expect, vi } from 'vitest';
import { parseCommandLine, readCommandLine } from '../cli/command-line.js';
import {
  DAEMON_COMMAND_LINE,
  daemonArgsFrom,
  daemonLoop,
  formatDaemonIdentity,
  parseDaemonIdentity,
  composeProjectOf,
  requireComposeProject,
  type DaemonDeps,
  type DaemonIdentityRecord,
  type DaemonOptions,
  type DaemonResult,
} from './idle-killer-daemon.js';

function fakeDeps(overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  return {
    bindSingleton: vi.fn().mockResolvedValue({ close: vi.fn() }),
    holdIdentity: (_port, _identity, body) => body(),
    liveClaimCount: vi.fn().mockResolvedValue(0),
    composeDown: vi.fn(async () => ({ exitCode: 0, output: '' })),
    recordTeardownFailure: vi.fn(async () => {}),
    clearTeardownFailure: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

function options(overrides: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    port: 7707,
    slot: 1,
    pollMs: 1000,
    graceWindowPolls: 1,
    composeProject: 'hushbox-1',
    repoRoot: '/tmp/repo',
    ...overrides,
  };
}

/** Stops the loop after `polls` sleeps, so a run that never tears down still ends. */
function haltAfter(polls: number): () => Promise<void> {
  let slept = 0;
  return async () => {
    slept += 1;
    if (slept >= polls) throw new Error('halt-test');
  };
}

/**
 * The daemon's arguments as an entry point reads them: the shared grammar
 * first, then the values it names. Composed here rather than behind a second
 * argv-taking door, because a door that cannot answer a help request is the
 * shape this grammar exists to remove.
 */
function daemonArgs(argv: readonly string[]): ReturnType<typeof daemonArgsFrom> {
  const invocation = readCommandLine(DAEMON_COMMAND_LINE, argv, () => undefined);
  if (invocation === null) throw new Error('the line asked for usage, not a run');
  return daemonArgsFrom(invocation.flags);
}

describe('the daemon command line', () => {
  it('reads --port and --slot', () => {
    const parsed = daemonArgs(['--port', '7707', '--slot', '5']);
    expect(parsed.port).toBe(7707);
    expect(parsed.slot).toBe(5);
  });

  it('refuses a missing --slot', () => {
    expect(() => daemonArgs(['--port', '7707'])).toThrow(/--slot/);
  });

  it('refuses a non-numeric port', () => {
    expect(() => daemonArgs(['--port', 'abc', '--slot', '1'])).toThrow(/--port/);
  });

  it('refuses a flag whose value is missing', () => {
    expect(() => daemonArgs(['--port'])).toThrow(/--port/);
  });

  it('refuses a negative --slot', () => {
    expect(() => daemonArgs(['--port', '7707', '--slot', '-1'])).toThrow(/--slot/);
  });

  it('answers the registry directory the argv names', () => {
    const parsed = daemonArgs([
      '--port',
      '7707',
      '--slot',
      '5',
      '--registry-dir',
      '/tmp/hb-registry',
    ]);
    expect(parsed.registryDir).toBe('/tmp/hb-registry');
  });

  it('leaves the registry unnamed when the argv names none', () => {
    expect(daemonArgs(['--port', '7707', '--slot', '5']).registryDir).toBeUndefined();
  });

  it('refuses an empty --registry-dir rather than resolving it against the cwd', () => {
    expect(() => daemonArgs(['--port', '7707', '--slot', '5', '--registry-dir', ''])).toThrow(
      /--registry-dir/
    );
  });

  it('refuses a misspelt registry-directory flag rather than reading the machine-wide registry', () => {
    expect(() =>
      daemonArgs(['--port', '7707', '--slot', '5', '--registry-dirs', '/tmp/hb-registry'])
    ).toThrow('--registry-dirs');
  });

  it('reads a help request as a request for usage rather than a run', () => {
    expect(parseCommandLine(DAEMON_COMMAND_LINE, ['--help']).kind).toBe('help');
  });
});

describe('composeProjectOf', () => {
  it('answers the compose project the environment names', () => {
    expect(composeProjectOf({ COMPOSE_PROJECT_NAME: 'hushbox-3' })).toBe('hushbox-3');
  });

  it('answers nothing when the environment names no project', () => {
    expect(composeProjectOf({})).toBeUndefined();
  });

  it('answers nothing for an empty name, which names no project either', () => {
    expect(composeProjectOf({ COMPOSE_PROJECT_NAME: '' })).toBeUndefined();
  });
});

describe('requireComposeProject', () => {
  it('answers the compose project the environment names', () => {
    expect(requireComposeProject({ COMPOSE_PROJECT_NAME: 'hushbox-3' })).toBe('hushbox-3');
  });

  it('refuses to run against a project the environment does not name', () => {
    expect(() => requireComposeProject({})).toThrow(/COMPOSE_PROJECT_NAME/);
  });

  it('refuses an empty project name rather than tearing down a nameless project', () => {
    expect(() => requireComposeProject({ COMPOSE_PROJECT_NAME: '' })).toThrow(
      /COMPOSE_PROJECT_NAME/
    );
  });
});

describe('the identity a daemon states in the claim that identifies it', () => {
  const record: DaemonIdentityRecord = {
    slot: 5,
    composeProject: 'hushbox-5',
    repoRoot: '/tmp/checkout',
    pid: 4242,
  };

  it('reads back the project, the checkout and the slot the daemon wrote', () => {
    expect(parseDaemonIdentity(formatDaemonIdentity(record))).toEqual(record);
  });

  it('reads no identity out of a holder that states one in prose rather than as a record', () => {
    expect(parseDaemonIdentity('idle daemon for slot 5 on port 7707 (pid 4242)')).toBeUndefined();
  });

  it('reads no identity out of a record that names no project to tear down', () => {
    const withoutProject = { slot: record.slot, repoRoot: record.repoRoot, pid: record.pid };
    expect(parseDaemonIdentity(JSON.stringify(withoutProject))).toBeUndefined();
  });

  it('reads no identity when nothing holds the claim at all', () => {
    expect(parseDaemonIdentity(null)).toBeUndefined();
  });
});

describe('daemonLoop', () => {
  it('exits immediately when bindSingleton fails (another daemon already alive)', async () => {
    const deps = fakeDeps({
      bindSingleton: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('addr in use'), { code: 'EADDRINUSE' })),
    });
    const result = await daemonLoop(options(), deps);
    expect(result.exitReason).toBe('singleton-conflict');
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('polls only while holding the claim that identifies it as the process on the port', async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      holdIdentity: async (port, identity, body) => {
        order.push(`identified as slot ${String(identity.slot)} on port ${String(port)}`);
        const result = await body();
        order.push('identity released');
        return result;
      },
      composeDown: async () => {
        order.push('teardown');
        return { exitCode: 0, output: '' };
      },
    });

    await daemonLoop(options({ port: 7707, slot: 1, graceWindowPolls: 1 }), deps);

    expect(order).toEqual(['identified as slot 1 on port 7707', 'teardown', 'identity released']);
  });

  it('takes its identity claim after the port is bound and drops it before the port closes', async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      bindSingleton: async () => {
        order.push('port bound');
        return {
          close: () => {
            order.push('port closed');
          },
        };
      },
      holdIdentity: async (_port, _identity, body) => {
        order.push('identity taken');
        const result = await body();
        order.push('identity released');
        return result;
      },
    });

    await daemonLoop(options({ graceWindowPolls: 1 }), deps);

    // Bound before claimed, so a held claim means its holder is on that port;
    // released before the port closes, so a daemon shutting down cannot refuse
    // the successor that binds the port it just let go of.
    expect(order).toEqual(['port bound', 'identity taken', 'identity released', 'port closed']);
  });

  it('states the project it would tear down, the checkout it runs in and the slot it watches', async () => {
    let stated: DaemonIdentityRecord | undefined;
    const deps = fakeDeps({
      holdIdentity: async (_port, identity, body) => {
        stated = identity;
        return body();
      },
    });

    await daemonLoop(
      options({ slot: 7, composeProject: 'hushbox-7', repoRoot: '/tmp/checkout' }),
      deps
    );

    expect(stated).toEqual({
      slot: 7,
      composeProject: 'hushbox-7',
      repoRoot: '/tmp/checkout',
      pid: process.pid,
    });
  });

  it('claims no identity for a port another daemon already owns', async () => {
    const holdIdentity = vi.fn(
      (_port: number, _identity: DaemonIdentityRecord, body: () => Promise<DaemonResult>) => body()
    );
    const deps = fakeDeps({
      bindSingleton: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('addr in use'), { code: 'EADDRINUSE' })),
      holdIdentity,
    });

    await daemonLoop(options(), deps);

    expect(holdIdentity).not.toHaveBeenCalled();
  });

  it('keeps polling while a run holds a claim on the slot, however long it runs', async () => {
    const deps = fakeDeps({
      liveClaimCount: vi.fn().mockResolvedValue(1),
      sleep: vi.fn(haltAfter(40)),
    });
    await expect(daemonLoop(options({ graceWindowPolls: 30 }), deps)).rejects.toThrow('halt-test');
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('keeps polling through the last poll before the grace window closes', async () => {
    const deps = fakeDeps({ sleep: vi.fn(haltAfter(29)) });
    await expect(daemonLoop(options({ graceWindowPolls: 30 }), deps)).rejects.toThrow('halt-test');
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('tears down on the poll that closes the grace window', async () => {
    const deps = fakeDeps({ sleep: vi.fn(haltAfter(40)) });
    const result = await daemonLoop(options({ graceWindowPolls: 30 }), deps);
    expect(deps.composeDown).toHaveBeenCalledWith('hushbox-1', '/tmp/repo');
    expect(vi.mocked(deps.sleep).mock.calls.length).toBe(29);
    expect(result.exitReason).toBe('idle-teardown');
  });

  it('starts the window again from zero when a run claims the slot mid-window', async () => {
    let polls = 0;
    const deps = fakeDeps({
      // Empty for the first two polls, claimed on the third, empty after.
      liveClaimCount: vi.fn(async () => {
        polls += 1;
        return polls === 3 ? 1 : 0;
      }),
      sleep: vi.fn(haltAfter(40)),
    });
    const result = await daemonLoop(options({ graceWindowPolls: 3 }), deps);
    expect(result.exitReason).toBe('idle-teardown');
    // Without the reset the third poll would have closed the window; the count
    // restarts there, so the teardown lands on the sixth.
    expect(vi.mocked(deps.liveClaimCount).mock.calls.length).toBe(6);
  });

  it('counts the slot it was told to watch, and no other', async () => {
    const deps = fakeDeps();
    await daemonLoop(options({ slot: 7, graceWindowPolls: 1 }), deps);
    expect(deps.liveClaimCount).toHaveBeenCalledWith(7);
  });

  it('names the slot and the grace window it acted on', async () => {
    const deps = fakeDeps();
    await daemonLoop(options({ slot: 7, graceWindowPolls: 1 }), deps);
    const logged = vi.mocked(deps.log).mock.calls.map(([message]) => message);
    expect(logged.some((message) => message.includes('slot 7'))).toBe(true);
    expect(logged.some((message) => message.includes('hushbox-1'))).toBe(true);
  });

  it('does not report a teardown when the compose down exits non-zero', async () => {
    const deps = fakeDeps({
      composeDown: vi.fn(async () => ({ exitCode: 1, output: 'no such service: postgres' })),
      sleep: vi.fn(haltAfter(1)),
    });
    await expect(daemonLoop(options(), deps)).rejects.toThrow('halt-test');
  });

  it('logs the failing exit code and the compose output', async () => {
    const deps = fakeDeps({
      composeDown: vi.fn(async () => ({ exitCode: 1, output: 'no such service: postgres' })),
      sleep: vi.fn(haltAfter(1)),
    });
    await expect(daemonLoop(options(), deps)).rejects.toThrow('halt-test');
    const logged = vi.mocked(deps.log).mock.calls.map(([message]) => message);
    expect(logged.some((message) => message.includes('exit 1'))).toBe(true);
    expect(logged.some((message) => message.includes('no such service: postgres'))).toBe(true);
  });

  it('attempts the teardown again on the next poll after a failure', async () => {
    const composeDown = vi.fn(async () => ({ exitCode: 1, output: '' }));
    const deps = fakeDeps({ composeDown, sleep: vi.fn(haltAfter(2)) });
    await expect(daemonLoop(options(), deps)).rejects.toThrow('halt-test');
    expect(composeDown).toHaveBeenCalledTimes(2);
  });
});

describe('the evidence a teardown that cannot succeed leaves', () => {
  it('records the exit code and the last thing the failing teardown printed', async () => {
    const deps = fakeDeps({
      composeDown: vi.fn(async () => ({
        exitCode: 1,
        output: 'reading the compose file\nerror: required variable is missing a value\n',
      })),
      sleep: vi.fn(haltAfter(1)),
    });

    await expect(daemonLoop(options(), deps)).rejects.toThrow('halt-test');

    expect(deps.recordTeardownFailure).toHaveBeenCalledWith({
      consecutiveFailures: 1,
      exitCode: 1,
      reason: 'error: required variable is missing a value',
    });
  });

  it('counts the attempts that have failed in a row, so a stuck one reads as stuck', async () => {
    const deps = fakeDeps({
      composeDown: vi.fn(async () => ({ exitCode: 1, output: 'no configuration file provided' })),
      sleep: vi.fn(haltAfter(3)),
    });

    await expect(daemonLoop(options(), deps)).rejects.toThrow('halt-test');

    expect(
      vi.mocked(deps.recordTeardownFailure).mock.calls.map(([f]) => f.consecutiveFailures)
    ).toEqual([1, 2, 3]);
  });

  it('leaves no evidence behind when the teardown succeeds', async () => {
    const deps = fakeDeps();

    await daemonLoop(options({ graceWindowPolls: 1 }), deps);

    expect(deps.recordTeardownFailure).not.toHaveBeenCalled();
    expect(deps.clearTeardownFailure).toHaveBeenCalled();
  });

  it('forgets a failure once a later teardown succeeds', async () => {
    let attempts = 0;
    const deps = fakeDeps({
      composeDown: vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? { exitCode: 1, output: 'the daemon could not reach docker' }
          : { exitCode: 0, output: '' };
      }),
      sleep: vi.fn(haltAfter(5)),
    });

    const result = await daemonLoop(options(), deps);

    expect(result.exitReason).toBe('idle-teardown');
    expect(deps.recordTeardownFailure).toHaveBeenCalledTimes(1);
    // Once before the first poll and once on the success: a record describes the
    // attempts of the daemon that wrote it, and nothing that has succeeded since.
    expect(deps.clearTeardownFailure).toHaveBeenCalledTimes(2);
  });

  it('discards the evidence a predecessor left before it has attempted anything itself', async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      clearTeardownFailure: vi.fn(async () => {
        order.push('cleared');
      }),
      liveClaimCount: vi.fn(async () => {
        order.push('polled');
        return 0;
      }),
    });

    await daemonLoop(options({ graceWindowPolls: 1 }), deps);

    expect(order[0]).toBe('cleared');
    expect(order[1]).toBe('polled');
  });

  it('records nothing for a slot whose runs keep it claimed', async () => {
    const deps = fakeDeps({
      liveClaimCount: vi.fn().mockResolvedValue(1),
      sleep: vi.fn(haltAfter(5)),
    });

    await expect(daemonLoop(options({ graceWindowPolls: 1 }), deps)).rejects.toThrow('halt-test');

    expect(deps.recordTeardownFailure).not.toHaveBeenCalled();
  });

  it('leaves the evidence only where its identity claim is held', async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      holdIdentity: async (_port, _identity, body) => {
        order.push('identity taken');
        const result = await body();
        order.push('identity released');
        return result;
      },
      composeDown: vi.fn(async () => ({ exitCode: 1, output: 'no such project' })),
      recordTeardownFailure: vi.fn(async () => {
        order.push('evidence written');
      }),
      sleep: vi.fn(haltAfter(1)),
    });

    await expect(daemonLoop(options(), deps)).rejects.toThrow('halt-test');

    expect(order).toEqual(['identity taken', 'evidence written']);
  });
});
