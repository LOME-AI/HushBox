import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StagedWriteFailed, stagedWrite, stagedWriteSync } from './staged-write.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'hb-staged-write-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

function failWith(code: string): (from: string, to: string) => void {
  return () => {
    throw errno(code);
  };
}

function failWithAsync(code: string): (from: string, to: string) => Promise<void> {
  return () => Promise.reject(errno(code));
}

/** A mode no umask produces, so reading it back names the caller as its source. */
const DISTINCT_MODE = 0o711;

/**
 * A code no step of a staged write raises on its own, so a report carrying it
 * names the injected failure rather than anything the clean-up met.
 */
const ORIGINAL_FAILURE = 'EXDEV';

/** The mode that leaves a directory readable and traversable but unwritable. */
const SEALED = 0o555;
const UNSEALED = 0o755;

describe('stagedWriteSync', () => {
  it('puts the whole body on the target', () => {
    const file = path.join(workDir, 'target');
    stagedWriteSync(file, 'the body\n');
    expect(readFileSync(file, 'utf8')).toBe('the body\n');
  });

  it('writes bytes as given rather than as text', () => {
    const file = path.join(workDir, 'target');
    stagedWriteSync(file, Uint8Array.from([0, 159, 146, 150]));
    expect([...readFileSync(file)]).toEqual([0, 159, 146, 150]);
  });

  it('creates the directory tree the target needs', () => {
    const file = path.join(workDir, 'nested', 'deeper', 'target');
    stagedWriteSync(file, 'body\n');
    expect(readFileSync(file, 'utf8')).toBe('body\n');
  });

  it('stages beside the target, so the move never crosses a filesystem', () => {
    const file = path.join(workDir, 'nested', 'target');
    let staged = '';
    stagedWriteSync(file, 'body\n', {
      rename: (from) => {
        staged = from;
      },
    });
    expect(path.dirname(staged)).toBe(path.dirname(file));
  });

  it('stages every write at a name no other writer can also choose', () => {
    const file = path.join(workDir, 'target');
    const staged: string[] = [];
    const capture = (from: string): void => {
      staged.push(from);
    };
    stagedWriteSync(file, 'one\n', { rename: capture });
    stagedWriteSync(file, 'two\n', { rename: capture });
    expect(staged[0]).not.toBe(staged[1]);
  });

  it('keeps no clock in the staging name', () => {
    const file = path.join(workDir, 'target');
    let staged = '';
    stagedWriteSync(file, 'body\n', {
      rename: (from) => {
        staged = from;
      },
    });
    const writer = path
      .basename(staged)
      .replace(`${path.basename(file)}.`, '')
      .replace('.tmp', '');
    // A version-4 identifier carries no time; version 7, which this repository
    // mints elsewhere, is a millisecond clock.
    expect(writer).toMatch(
      /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('names the target, the writer that lost and the reason when a write cannot land', () => {
    const file = path.join(workDir, 'target');
    let staged = '';
    let raised: unknown;
    try {
      stagedWriteSync(file, 'body\n', {
        rename: (from) => {
          staged = from;
          throw errno('ENOENT');
        },
      });
    } catch (error) {
      raised = error;
    }
    const writer = path
      .basename(staged)
      .replace(`${path.basename(file)}.`, '')
      .replace('.tmp', '');
    expect(raised).toBeInstanceOf(StagedWriteFailed);
    expect((raised as Error).message).toContain('target');
    expect((raised as Error).message).toContain(writer);
    expect((raised as Error).message).toContain('ENOENT');
  });

  it('says the reason is unknown when the failure carries no error code', () => {
    const file = path.join(workDir, 'target');
    expect(() => {
      stagedWriteSync(file, 'body\n', {
        rename: () => {
          throw new Error('a failure with no errno behind it');
        },
      });
    }).toThrow(/unknown/);
  });

  it('keeps the failure that stopped the write as the cause', () => {
    const file = path.join(workDir, 'target');
    const underlying = errno('EACCES');
    try {
      stagedWriteSync(file, 'body\n', {
        rename: () => {
          throw underlying;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBe(underlying);
    }
  });

  it('removes its staging file when the write cannot land', () => {
    const file = path.join(workDir, 'target');
    expect(() => {
      stagedWriteSync(file, 'body\n', { rename: failWith('EACCES') });
    }).toThrow(StagedWriteFailed);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('reports the failure that stopped the write when the staging file cannot be removed either', () => {
    const blocker = path.join(workDir, 'blocker');
    writeFileSync(blocker, 'a file where the target directory would go');
    expect(() => {
      stagedWriteSync(path.join(blocker, 'target'), 'body\n');
    }).toThrow(StagedWriteFailed);
    expect(existsSync(blocker)).toBe(true);
  });

  it('names the failure that stopped the write rather than the one met clearing up', () => {
    const file = path.join(workDir, 'target');
    try {
      expect(() => {
        stagedWriteSync(file, 'body\n', {
          rename: () => {
            // The staging file exists by now, and a directory nothing may write
            // is one nothing may unlink from either — so the clean-up below
            // fails, and what surfaces says which of the two failures is the
            // one a reader is told about.
            chmodSync(workDir, SEALED);
            throw errno(ORIGINAL_FAILURE);
          },
        });
      }).toThrow(new RegExp(ORIGINAL_FAILURE, 'u'));
    } finally {
      chmodSync(workDir, UNSEALED);
    }
  });

  it('lands the target at the mode it was given', () => {
    const file = path.join(workDir, 'target');
    stagedWriteSync(file, 'body\n', { mode: DISTINCT_MODE });
    expect(statSync(file).mode & 0o777).toBe(DISTINCT_MODE);
  });

  it('carries the mode on the staging file, so no rename can publish a target without it', () => {
    const file = path.join(workDir, 'target');
    let stagedMode = 0;
    let targetExisted = true;
    stagedWriteSync(file, 'body\n', {
      mode: DISTINCT_MODE,
      rename: (from, to) => {
        stagedMode = statSync(from).mode & 0o777;
        targetExisted = existsSync(to);
        renameSync(from, to);
      },
    });
    expect(
      stagedMode,
      'the rename is what brings the target into being, so the mode has to be on the file it moves'
    ).toBe(DISTINCT_MODE);
    expect(
      targetExisted,
      'nothing stood at the target before the rename, so no reader could have met it at another mode'
    ).toBe(false);
  });

  it('writes at the default mode where it is given none', () => {
    const file = path.join(workDir, 'target');
    const control = path.join(workDir, 'control');
    // The control is what an ordinary write of this process produces, so the
    // case states the default without naming a umask it cannot know.
    writeFileSync(control, 'body\n');
    stagedWriteSync(file, 'body\n');
    expect(statSync(file).mode & 0o777).toBe(statSync(control).mode & 0o777);
  });
});

describe('stagedWrite', () => {
  it('puts the whole body on the target', async () => {
    const file = path.join(workDir, 'target');
    await stagedWrite(file, 'the body\n');
    expect(readFileSync(file, 'utf8')).toBe('the body\n');
  });

  it('writes bytes as given rather than as text', async () => {
    const file = path.join(workDir, 'target');
    await stagedWrite(file, Uint8Array.from([0, 159, 146, 150]));
    expect([...readFileSync(file)]).toEqual([0, 159, 146, 150]);
  });

  it('creates the directory tree the target needs', async () => {
    const file = path.join(workDir, 'nested', 'deeper', 'target');
    await stagedWrite(file, 'body\n');
    expect(readFileSync(file, 'utf8')).toBe('body\n');
  });

  it('stages beside the target, so the move never crosses a filesystem', async () => {
    const file = path.join(workDir, 'nested', 'target');
    let staged = '';
    await stagedWrite(file, 'body\n', {
      rename: (from) => {
        staged = from;
        return Promise.resolve();
      },
    });
    expect(path.dirname(staged)).toBe(path.dirname(file));
  });

  it('stages every write at a name no other writer can also choose', async () => {
    const file = path.join(workDir, 'target');
    const staged: string[] = [];
    const capture = (from: string): Promise<void> => {
      staged.push(from);
      return Promise.resolve();
    };
    await stagedWrite(file, 'one\n', { rename: capture });
    await stagedWrite(file, 'two\n', { rename: capture });
    expect(staged[0]).not.toBe(staged[1]);
  });

  it('keeps no clock in the staging name', async () => {
    const file = path.join(workDir, 'target');
    let staged = '';
    await stagedWrite(file, 'body\n', {
      rename: (from) => {
        staged = from;
        return Promise.resolve();
      },
    });
    const writer = path
      .basename(staged)
      .replace(`${path.basename(file)}.`, '')
      .replace('.tmp', '');
    // A version-4 identifier carries no time; version 7, which this repository
    // mints elsewhere, is a millisecond clock.
    expect(writer).toMatch(
      /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('names the target, the writer that lost and the reason when a write cannot land', async () => {
    const file = path.join(workDir, 'target');
    let staged = '';
    let raised: unknown;
    try {
      await stagedWrite(file, 'body\n', {
        rename: (from) => {
          staged = from;
          return Promise.reject(errno('ENOENT'));
        },
      });
    } catch (error) {
      raised = error;
    }
    const writer = path
      .basename(staged)
      .replace(`${path.basename(file)}.`, '')
      .replace('.tmp', '');
    expect(raised).toBeInstanceOf(StagedWriteFailed);
    expect((raised as Error).message).toContain('target');
    expect((raised as Error).message).toContain(writer);
    expect((raised as Error).message).toContain('ENOENT');
  });

  it('says the reason is unknown when the failure carries no error code', async () => {
    const file = path.join(workDir, 'target');
    await expect(
      stagedWrite(file, 'body\n', {
        rename: () => Promise.reject(new Error('a failure with no errno behind it')),
      })
    ).rejects.toThrow(/unknown/u);
  });

  it('keeps the failure that stopped the write as the cause', async () => {
    const file = path.join(workDir, 'target');
    const underlying = errno('EACCES');
    try {
      await stagedWrite(file, 'body\n', { rename: () => Promise.reject(underlying) });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBe(underlying);
    }
  });

  it('removes its staging file when the write cannot land', async () => {
    const file = path.join(workDir, 'target');
    await expect(stagedWrite(file, 'body\n', { rename: failWithAsync('EACCES') })).rejects.toThrow(
      StagedWriteFailed
    );
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('reports the failure that stopped the write when the staging file cannot be removed either', async () => {
    const blocker = path.join(workDir, 'blocker');
    writeFileSync(blocker, 'a file where the target directory would go');
    await expect(stagedWrite(path.join(blocker, 'target'), 'body\n')).rejects.toThrow(
      StagedWriteFailed
    );
    expect(existsSync(blocker)).toBe(true);
  });

  it('names the failure that stopped the write rather than the one met clearing up', async () => {
    const file = path.join(workDir, 'target');
    try {
      await expect(
        stagedWrite(file, 'body\n', {
          rename: () => {
            chmodSync(workDir, SEALED);
            return Promise.reject(errno(ORIGINAL_FAILURE));
          },
        })
      ).rejects.toThrow(new RegExp(ORIGINAL_FAILURE, 'u'));
    } finally {
      chmodSync(workDir, UNSEALED);
    }
  });

  it('lands the target at the mode it was given', async () => {
    const file = path.join(workDir, 'target');
    await stagedWrite(file, 'body\n', { mode: DISTINCT_MODE });
    expect(statSync(file).mode & 0o777).toBe(DISTINCT_MODE);
  });

  it('carries the mode on the staging file, so no rename can publish a target without it', async () => {
    const file = path.join(workDir, 'target');
    let stagedMode = 0;
    let targetExisted = true;
    await stagedWrite(file, 'body\n', {
      mode: DISTINCT_MODE,
      rename: (from, to) => {
        stagedMode = statSync(from).mode & 0o777;
        targetExisted = existsSync(to);
        renameSync(from, to);
        return Promise.resolve();
      },
    });
    expect(
      stagedMode,
      'the rename is what brings the target into being, so the mode has to be on the file it moves'
    ).toBe(DISTINCT_MODE);
    expect(
      targetExisted,
      'nothing stood at the target before the rename, so no reader could have met it at another mode'
    ).toBe(false);
  });

  it('writes at the default mode where it is given none', async () => {
    const file = path.join(workDir, 'target');
    const control = path.join(workDir, 'control');
    writeFileSync(control, 'body\n');
    await stagedWrite(file, 'body\n');
    expect(statSync(file).mode & 0o777).toBe(statSync(control).mode & 0o777);
  });
});
