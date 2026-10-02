import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV } from '../claims/claim.js';
import { RUN_CLAIM_ENV, addResource, enumerateClaims, registerRun } from '../claims/registry.js';
import {
  closeProcessLifeline,
  probeLifelineSocket,
  socketAnswerFor,
  reclaimLifelineSockets,
  scanLifelineSockets,
  spawnLongLived,
} from './long-lived.js';
import type { Server } from 'node:net';
import type { RunInit } from '../claims/registry.js';
import type { SocketAnswer, TreeForwarder } from './long-lived.js';

/**
 * What a spawning process leaves in the temporary directory when it is killed
 * too hard to close its own socket, and what the next run does about it.
 *
 * Every socket here is a real one the kernel made and a real one it refuses:
 * the fixture listens on an address, renames the file out from under the
 * listener and closes it, which is what a process killed by a signal leaves —
 * a file nothing answers on. A fabricated file would be asserting over its own
 * fixture rather than over the thing the pass has to classify.
 */

/**
 * A process adopts a run only by inheriting it, so the case about adoption runs
 * a real child. It goes through tsx's loader in-process (`--import`) rather than
 * through its CLI, which forks: the process that reports on the socket has to be
 * the process that opened it.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const ADOPTED_ENTRY = fileURLToPath(new URL('adopted-spawn-entry.mjs', import.meta.url));

let registryDir: string;
let socketDir: string;

function init(overrides: Partial<RunInit> = {}): RunInit {
  return {
    command: 'pnpm dev',
    mode: 'development',
    slot: 3,
    gitCommonDir: path.join(registryDir, 'checkout', '.git'),
    registryDir,
    ...overrides,
  };
}

/** A real listener answering at `address`, for a case that needs something behind the file. */
async function listenOn(address: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

/** Stops a listener this case started, and waits for it to have stopped. */
function stopListening(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A socket file the kernel made and nothing answers on, at `address`. */
async function staleSocket(address: string): Promise<string> {
  const listened = `${address}.listening`;
  const server = await listenOn(listened);
  // Renamed out from under its listener, so closing the server unlinks a name
  // nothing holds and the file it made stays where a killed process left one.
  await fs.rename(listened, address);
  await stopListening(server);
  return address;
}

/** A forwarder that watches nothing, so a case never installs handlers on the vitest process. */
const detachedForwarder: TreeForwarder = {
  add: () => (): void => {},
};

/** Every socket in this case's own directory, which is the world a pass here reads. */
function scratchScan(): Promise<readonly string[]> {
  return scanLifelineSockets(socketDir);
}

/** The address a spawning process would have named, under the scratch directory. */
function addressIn(nonce: string): string {
  return path.join(socketDir, `hb-${nonce}`);
}

/** Makes the running run's own record unreadable, and names the run it damaged. */
function damageOwnRecord(): string {
  const runDir = process.env[RUN_CLAIM_ENV] ?? '';
  const record = path.join(runDir, 'run.json');
  const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
  writeFileSync(
    record,
    JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
  );
  return path.basename(runDir);
}

/** Leaves an owned-expired claim behind: the run throws, so its record survives. */
async function leaveExpiredClaim(record: () => Promise<void>): Promise<void> {
  await registerRun(init(), async () => {
    await record();
    throw new Error('the run was killed');
  }).catch(() => undefined);
}

beforeEach(async () => {
  // The invocation running this suite is itself a registered run and advertises
  // it in the environment every child inherits, so a case calling `registerRun`
  // would adopt that run instead of registering its own.
  vi.stubEnv(RUN_CLAIM_ENV, '');
  vi.stubEnv(HELD_CLAIMS_ENV, '');
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-socket-registry-'));
  socketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-socket-scratch-'));
});

afterEach(async () => {
  // Ahead of the cleanup, because a cleanup that throws would otherwise skip it.
  // The runner restores stubs before each test and never after the last one, so
  // the tokens this file blanks in setup outlive the file without this.
  vi.unstubAllEnvs();
  // The socket this worker answers on goes before the directory holding it
  // does, whether a case opened one or not: the runner ends a worker by
  // signalling it, which reaches no handler and would leave the file behind.
  await closeProcessLifeline();
  await fs.rm(registryDir, { recursive: true, force: true });
  await fs.rm(socketDir, { recursive: true, force: true });
});

describe('scanning for the sockets a spawning process leaves', () => {
  it('finds a socket file whose name this mechanism could have produced', async () => {
    const address = await staleSocket(addressIn('0123456789'));

    await expect(scanLifelineSockets(socketDir)).resolves.toEqual([address]);
  });

  it('passes over a name this mechanism could not have produced', async () => {
    await staleSocket(path.join(socketDir, 'hb-spawner-death-0'));
    await staleSocket(path.join(socketDir, 'hb-0123456789abcdef'));

    await expect(scanLifelineSockets(socketDir)).resolves.toEqual([]);
  });

  it('passes over a file of the right name that is not a socket', async () => {
    await fs.writeFile(addressIn('abcdef0123'), '');

    await expect(scanLifelineSockets(socketDir)).resolves.toEqual([]);
  });

  it('finds nothing in a directory that is not there', async () => {
    await expect(scanLifelineSockets(path.join(socketDir, 'gone'))).resolves.toEqual([]);
  });

  it('raises on a failure that is not a missing directory, rather than reading it as empty', async () => {
    const notADirectory = path.join(socketDir, 'file');
    await fs.writeFile(notADirectory, '');

    await expect(scanLifelineSockets(notADirectory)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('reading one failed connect', () => {
  it('calls a refusal the absence it is', () => {
    expect(socketAnswerFor('ECONNREFUSED')).toEqual({ kind: 'refused' });
  });

  it('calls every other code unknown, and carries it into the line', () => {
    expect(socketAnswerFor('EACCES')).toEqual({ kind: 'unknown', reason: 'EACCES' });
    expect(socketAnswerFor('ENOENT')).toEqual({ kind: 'unknown', reason: 'ENOENT' });
  });

  it('says a failure carrying no code at all carries none, rather than naming one', () => {
    expect(socketAnswerFor()).toEqual({ kind: 'unknown', reason: 'no error code' });
  });
});

describe('asking the kernel what is behind a socket file', () => {
  it('answers that something is there when a real listener is', async () => {
    const address = addressIn('0123456789');
    const server = await listenOn(address);

    await expect(probeLifelineSocket(address)).resolves.toEqual({ kind: 'answered' });

    await stopListening(server);
  });

  it('answers refused for a file whose listener has gone', async () => {
    const address = await staleSocket(addressIn('0123456789'));

    await expect(probeLifelineSocket(address)).resolves.toEqual({ kind: 'refused' });
  });

  it('answers unknown for a name that is not there, which names no file to act on', async () => {
    await expect(probeLifelineSocket(addressIn('0123456789'))).resolves.toEqual({
      kind: 'unknown',
      reason: 'ENOENT',
    });
  });

  it('answers unknown when the connect is not permitted, which hides a listener as readily as debris', async () => {
    const address = await staleSocket(addressIn('0123456789'));
    await fs.chmod(address, 0o000);

    await expect(probeLifelineSocket(address)).resolves.toEqual({
      kind: 'unknown',
      reason: 'EACCES',
    });
  });
});

describe('reclaiming the socket of a run that has gone', () => {
  it('removes the file its expired claim names', async () => {
    const address = await staleSocket(addressIn('0123456789'));
    await leaveExpiredClaim(() => addResource({ kind: 'socket', id: address }));

    const report = await reclaimLifelineSockets({ scan: scratchScan, registryDir });

    expect(report.reclaimed).toEqual([address]);
    await expect(fs.stat(address)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the file of a run that still holds its claim', async () => {
    const address = await staleSocket(addressIn('0123456789'));

    const report = await registerRun(init(), async () => {
      await addResource({ kind: 'socket', id: address });
      return reclaimLifelineSockets({ scan: scratchScan, registryDir });
    });

    expect(report).toEqual({ reclaimed: [], live: [address], unowned: [], refused: [] });
    await expect(fs.stat(address)).resolves.toBeDefined();
  });

  it('removes a file no claim names once a connect to it is refused', async () => {
    const address = await staleSocket(addressIn('0123456789'));

    const report = await reclaimLifelineSockets({ scan: scratchScan, registryDir });

    expect(report).toEqual({ reclaimed: [address], live: [], unowned: [], refused: [] });
    await expect(fs.stat(address)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a file no claim names standing while a real listener answers on it', async () => {
    const address = addressIn('0123456789');
    const server = await listenOn(address);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await reclaimLifelineSockets({ scan: scratchScan, registryDir });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [address], refused: [] });
    await expect(fs.stat(address)).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join('\n')).toContain(address);
    warn.mockRestore();
    await stopListening(server);
  });

  it('leaves a file standing when the connect was not permitted rather than reading that as absence', async () => {
    const address = await staleSocket(addressIn('0123456789'));
    await fs.chmod(address, 0o000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await reclaimLifelineSockets({ scan: scratchScan, registryDir });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [address], refused: [] });
    await expect(fs.stat(address)).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join('\n')).toContain('EACCES');
    warn.mockRestore();
  });

  it('removes nothing for a name that has gone between the scan and the connect', async () => {
    const gone = addressIn('0123456789');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await reclaimLifelineSockets({
      scan: () => Promise.resolve([gone]),
      registryDir,
    });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [gone], refused: [] });
    expect(warn.mock.calls.flat().join('\n')).toContain('ENOENT');
    warn.mockRestore();
  });

  it('counts a file gone before its removal as removed rather than failing on it', async () => {
    // The removal is an unlink and nothing more, so a name that has already
    // gone is the outcome the removal wanted rather than a failure.
    const gone = addressIn('0123456789');
    await leaveExpiredClaim(() => addResource({ kind: 'socket', id: gone }));

    const report = await reclaimLifelineSockets({
      scan: () => Promise.resolve([gone]),
      registryDir,
    });

    expect(report).toEqual({ reclaimed: [gone], live: [], unowned: [], refused: [] });
  });

  it('raises on a refused removal where the caller names no refusal it steps over', async () => {
    const address = await staleSocket(addressIn('0123456789'));
    // The kernel's own refusal, from a directory this user may not write. The
    // mode goes back before the case ends: the teardown that removes the
    // directory needs the permission this took away.
    await fs.chmod(socketDir, 0o500);

    try {
      await expect(
        reclaimLifelineSockets({ scan: scratchScan, registryDir })
      ).rejects.toMatchObject({ code: 'EACCES', syscall: 'unlink', path: address });
    } finally {
      await fs.chmod(socketDir, 0o700);
    }
  });

  it('asks the kernel nothing about a file a claim places, in either state a claim can be in', async () => {
    const live = await staleSocket(addressIn('0123456789'));
    const expired = await staleSocket(addressIn('abcdef0123'));
    await leaveExpiredClaim(() => addResource({ kind: 'socket', id: expired }));
    const probe = vi.fn((): Promise<SocketAnswer> => Promise.resolve({ kind: 'refused' }));

    const report = await registerRun(init(), async () => {
      await addResource({ kind: 'socket', id: live });
      return reclaimLifelineSockets({ scan: scratchScan, registryDir, probe });
    });

    expect(report).toEqual({ reclaimed: [expired], live: [live], unowned: [], refused: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it('asks the kernel nothing while a live run\u2019s record cannot be read, whatever the file would answer', async () => {
    const address = await staleSocket(addressIn('0123456789'));
    const probe = vi.fn((): Promise<SocketAnswer> => Promise.resolve({ kind: 'refused' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await registerRun(init(), async () => {
      damageOwnRecord();
      return reclaimLifelineSockets({ scan: scratchScan, registryDir, probe });
    });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [address], refused: [] });
    expect(probe).not.toHaveBeenCalled();
    await expect(fs.stat(address)).resolves.toBeDefined();
    warn.mockRestore();
  });

  it('names the unreadable live run rather than asserting no claim names the socket', async () => {
    await staleSocket(addressIn('0123456789'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const runId = await registerRun(init(), async () => {
      const named = damageOwnRecord();
      await reclaimLifelineSockets({ scan: scratchScan, registryDir });
      return named;
    });

    const printed = warn.mock.calls.flat().join('\n');
    expect(printed).not.toContain('no claim, live or expired');
    expect(printed).toContain(runId);
    warn.mockRestore();
  });

  it('reclaims nothing from a world that never held still', async () => {
    await staleSocket(addressIn('0123456789'));
    // A socket appearing between the two readings of a pass invalidates it: the
    // pass would otherwise classify a file against a registry written before
    // that file's claim was.
    let reading = 0;
    const restless = (): Promise<readonly string[]> => {
      reading += 1;
      return Promise.resolve([addressIn(String(reading).padStart(10, '0'))]);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await reclaimLifelineSockets({ scan: restless, registryDir });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [], refused: [] });
    warn.mockRestore();
  });

  it('decides from the claim and never from the file answering, so a refused socket a live run owns stays', async () => {
    const address = await staleSocket(addressIn('0123456789'));
    await expect(probeLifelineSocket(address)).resolves.toEqual({ kind: 'refused' });

    const report = await registerRun(init(), async () => {
      await addResource({ kind: 'socket', id: address });
      return reclaimLifelineSockets({ scan: scratchScan, registryDir });
    });

    expect(report.live).toEqual([address]);
  });
});

describe('the socket a run answers its children on', () => {
  it('is gone before the record naming it is, so a finished run leaves nothing unowned', async () => {
    vi.stubEnv('TMPDIR', socketDir);
    let whileRunning: readonly string[] = [];

    await registerRun(init(), async () => {
      const child = await spawnLongLived(process.execPath, ['-e', ''], {
        stdio: 'ignore',
        forwarder: detachedForwarder,
        ports: [],
      });
      await child.exit;
      whileRunning = await scanLifelineSockets(socketDir);
    });

    expect(whileRunning).toHaveLength(1);
    await expect(scanLifelineSockets(socketDir)).resolves.toEqual([]);
    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('stays for the next run to reclaim when the run it belonged to did not finish', async () => {
    vi.stubEnv('TMPDIR', socketDir);
    let address = '';

    await registerRun(init(), async () => {
      const child = await spawnLongLived(process.execPath, ['-e', ''], {
        stdio: 'ignore',
        forwarder: detachedForwarder,
        ports: [],
      });
      await child.exit;
      [address = ''] = await scanLifelineSockets(socketDir);
      throw new Error('the run was killed');
    }).catch(() => undefined);

    await expect(scanLifelineSockets(socketDir)).resolves.toEqual([address]);
    const report = await reclaimLifelineSockets({ scan: scratchScan, registryDir });
    expect(report.reclaimed).toEqual([address]);
  });

  it('is gone before the record naming it is when the run was adopted rather than started', async () => {
    vi.stubEnv('TMPDIR', socketDir);
    let left = '';
    let recorded = 0;

    await registerRun(init(), async () => {
      const { stdout } = await execa(process.execPath, [
        '--import',
        TSX_LOADER,
        ADOPTED_ENTRY,
        registryDir,
        'pnpm build',
        'development',
        '3',
        path.join(registryDir, 'checkout', '.git'),
      ]);
      left = stdout;
      const claims = await enumerateClaims(registryDir);
      recorded = claims.length;
    });

    expect(left).toBe('0');
    expect(recorded).toBe(1);
  });
});
