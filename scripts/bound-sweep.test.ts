import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enumerateBoundMutants } from './bound-mutants.js';
import {
  sweepFile,
  formatSweepReport,
  assertOutsideRepository,
  mirrorRepository,
  mirroredPort,
  runSweep,
  commandOracle,
  SWEPT_SOURCES,
  SWEPT_MUTANT_MOVEMENTS,
  boundMovement,
  type SweepPort,
  type SweepResult,
} from './bound-sweep.js';
import { isOutsideRoot } from './lib/path-containment.js';

const TARGET = 'scripts/example.ts';

interface Recorder extends SweepPort {
  readonly writes: string[];
}

function recorder(pristine: string, rejects: () => Promise<boolean>): Recorder {
  const writes: string[] = [];
  return {
    writes,
    pristine,
    writeMutant: (contents: string): Promise<void> => {
      writes.push(contents);
      return Promise.resolve();
    },
    rejects,
  };
}

const always = (verdict: boolean) => (): Promise<boolean> => Promise.resolve(verdict);

async function isLink(target: string): Promise<boolean> {
  const stats = await fs.lstat(target);
  return stats.isSymbolicLink();
}

describe('sweepFile', () => {
  const source = 'const cap = 20;\n';

  it('returns one verdict per enumerated mutant, in enumeration order', async () => {
    const results = await sweepFile(TARGET, recorder(source, always(true)));
    expect(results.map((result) => result.mutant.replacement)).toEqual(['19', '21']);
    expect(results.map((result) => result.path)).toEqual([TARGET, TARGET]);
  });

  it('counts a mutant the oracle rejects as killed', async () => {
    const results = await sweepFile(TARGET, recorder(source, always(true)));
    expect(results.map((result) => result.verdict)).toEqual(['killed', 'killed']);
  });

  it('counts a mutant the oracle accepts as a survivor', async () => {
    const results = await sweepFile(TARGET, recorder(source, always(false)));
    expect(results.map((result) => result.verdict)).toEqual(['survived', 'survived']);
  });

  it('applies every mutant to the pristine source rather than to the one before it', async () => {
    const port = recorder(source, always(true));
    await sweepFile(TARGET, port);
    expect(port.writes).toEqual(['const cap = 19;\n', 'const cap = 21;\n']);
  });

  it('writes nothing at all when the file carries no bound', async () => {
    const port = recorder('export const name = mark;\n', always(true));
    expect(await sweepFile(TARGET, port)).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it('never writes the pristine source back, because there is nothing to put back', async () => {
    const port = recorder(source, always(true));
    await sweepFile(TARGET, port);
    expect(port.writes).not.toContain(source);
  });

  it('leaves the last mutant where it lies when the oracle throws', async () => {
    const port = recorder(source, () => Promise.reject(new Error('oracle unavailable')));
    await expect(sweepFile(TARGET, port)).rejects.toThrow('oracle unavailable');
    expect(port.writes).toEqual(['const cap = 19;\n']);
  });
});

describe('formatSweepReport', () => {
  const [first, second] = enumerateBoundMutants('const cap = 20;\n');
  const resultOf = (index: number, verdict: SweepResult['verdict']): SweepResult => ({
    path: TARGET,
    mutant: (index === 0 ? first : second)!,
    verdict,
  });

  it('says nothing was swept when the enumeration was empty', () => {
    expect(formatSweepReport([])).toBe('No bound-bearing construct: nothing to sweep.');
  });

  it('names every survivor with its location and its movement', () => {
    const report = formatSweepReport([resultOf(0, 'survived'), resultOf(1, 'killed')]);
    expect(report).toContain('1 of 2 mutants killed');
    expect(report).toContain(`${TARGET}:1 numeric-literal 20 -> 19`);
    expect(report).not.toContain('-> 21');
  });

  it('states the clean result rather than printing an empty list', () => {
    const report = formatSweepReport([resultOf(0, 'killed'), resultOf(1, 'killed')]);
    expect(report).toBe('2 of 2 mutants killed; no survivor.');
  });
});

describe('assertOutsideRepository', () => {
  const repoRoot = path.join(path.sep, 'somewhere', 'repository');

  it('refuses a destination inside the repository', () => {
    expect(() => {
      assertOutsideRepository(repoRoot, path.join(repoRoot, 'scripts', 'gate.ts'));
    }).toThrow(/inside the repository/);
  });

  it('refuses the repository root itself', () => {
    expect(() => {
      assertOutsideRepository(repoRoot, repoRoot);
    }).toThrow(/inside the repository/);
  });

  it('names no path in its refusal, since the path is the host layout', () => {
    expect(() => {
      assertOutsideRepository(repoRoot, path.join(repoRoot, 'scripts'));
    }).toThrow(/^(?:(?!somewhere).)*$/s);
  });

  it('accepts a destination beside the repository', () => {
    expect(() => {
      assertOutsideRepository(repoRoot, path.join(path.sep, 'somewhere', 'scratch'));
    }).not.toThrow();
  });

  it('accepts a destination whose name merely begins with the repository root', () => {
    expect(() => {
      assertOutsideRepository(repoRoot, `${repoRoot}-scratch`);
    }).not.toThrow();
  });

  it('accepts a destination that merely carries the repository root inside it', () => {
    expect(() => {
      assertOutsideRepository(repoRoot, path.join(path.sep, 'scratch', repoRoot, 'gate.ts'));
    }).not.toThrow();
  });
});

const scratches: string[] = [];

afterEach(async () => {
  for (const scratch of scratches.splice(0)) {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

/** A miniature of this repository's shape: a subject package, a sibling, and git state. */
async function fakeRepository(
  packageModules = true
): Promise<{ repoRoot: string; scratchParent: string }> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bound-sweep-fixture-'));
  scratches.push(scratch);
  const repoRoot = path.join(scratch, 'repository');
  const write = async (relative: string, contents: string): Promise<void> => {
    const target = path.join(repoRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  };
  await write('package.json', '{"name":"root"}\n');
  await write('.git/HEAD', 'ref: refs/heads/main\n');
  await write('node_modules/marker.txt', 'root modules\n');
  await write('packages/sibling.txt', 'sibling\n');
  await write('scripts/gate.ts', 'const cap = 20;\n');
  if (packageModules) await write('scripts/node_modules/marker.txt', 'package modules\n');
  return { repoRoot, scratchParent: path.join(scratch, 'outside') };
}

const build = async (): Promise<{ repoRoot: string; mirrorRoot: string }> => {
  const { repoRoot, scratchParent } = await fakeRepository();
  await fs.mkdir(scratchParent, { recursive: true });
  return {
    repoRoot,
    mirrorRoot: await mirrorRepository(repoRoot, ['scripts/gate.ts'], scratchParent),
  };
};

describe('the mirror', () => {
  it('places the mirror outside the repository', async () => {
    const { repoRoot, mirrorRoot } = await build();
    expect(isOutsideRoot(path, repoRoot, mirrorRoot)).toBe(true);
  });

  it('copies the subject directory as real files', async () => {
    const { mirrorRoot } = await build();
    const copy = path.join(mirrorRoot, 'scripts', 'gate.ts');
    expect(await isLink(copy)).toBe(false);
    expect(await fs.readFile(copy, 'utf8')).toBe('const cap = 20;\n');
  });

  it('links every other top-level directory rather than copying it', async () => {
    const { mirrorRoot } = await build();
    expect(await isLink(path.join(mirrorRoot, 'packages'))).toBe(true);
    expect(await isLink(path.join(mirrorRoot, 'node_modules'))).toBe(true);
  });

  it('links the installed modules inside the copied directory rather than copying them', async () => {
    const { mirrorRoot } = await build();
    const modules = path.join(mirrorRoot, 'scripts', 'node_modules');
    expect(await isLink(modules)).toBe(true);
    expect(await fs.readFile(path.join(modules, 'marker.txt'), 'utf8')).toBe('package modules\n');
  });

  it('mirrors a subject directory that has no installed modules of its own', async () => {
    const { repoRoot, scratchParent } = await fakeRepository(false);
    await fs.mkdir(scratchParent, { recursive: true });
    const mirrorRoot = await mirrorRepository(repoRoot, ['scripts/gate.ts'], scratchParent);
    await expect(fs.lstat(path.join(mirrorRoot, 'scripts', 'node_modules'))).rejects.toThrow();
    expect(await fs.readFile(path.join(mirrorRoot, 'scripts', 'gate.ts'), 'utf8')).toBe(
      'const cap = 20;\n'
    );
  });

  it('copies top-level files, so the oracle reads configuration without a link', async () => {
    const { mirrorRoot } = await build();
    const root = path.join(mirrorRoot, 'package.json');
    expect(await isLink(root)).toBe(false);
    expect(await fs.readFile(root, 'utf8')).toBe('{"name":"root"}\n');
  });

  it('copies no git directory, so the mirror root is not a repository', async () => {
    const { mirrorRoot } = await build();
    await expect(fs.lstat(path.join(mirrorRoot, '.git'))).rejects.toThrow();
  });

  it('writes through a linked top-level directory into the repository itself', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await fs.writeFile(path.join(mirrorRoot, 'packages', 'sibling.txt'), 'written\n', 'utf8');
    expect(await fs.readFile(path.join(repoRoot, 'packages', 'sibling.txt'), 'utf8')).toBe(
      'written\n'
    );
  });

  it('refuses to build a mirror inside the repository, before creating anything', async () => {
    const { repoRoot } = await fakeRepository();
    const inside = path.join(repoRoot, 'scratch');
    await expect(mirrorRepository(repoRoot, ['scripts/gate.ts'], inside)).rejects.toThrow(
      /inside the repository/
    );
    await expect(fs.lstat(inside)).rejects.toThrow();
  });

  it('reads the pristine subject out of the repository', async () => {
    const { repoRoot, mirrorRoot } = await build();
    const port = await mirroredPort(repoRoot, mirrorRoot, 'scripts/gate.ts', always(true));
    expect(port.pristine).toBe('const cap = 20;\n');
  });

  it('writes a mutant to the mirror and leaves the repository byte-identical', async () => {
    const { repoRoot, mirrorRoot } = await build();
    const subject = path.join(repoRoot, 'scripts', 'gate.ts');
    const before = await fs.readFile(subject);
    const port = await mirroredPort(repoRoot, mirrorRoot, 'scripts/gate.ts', always(true));
    await sweepFile('scripts/gate.ts', port);
    expect(await fs.readFile(subject)).toEqual(before);
    expect(await fs.readFile(path.join(mirrorRoot, 'scripts', 'gate.ts'), 'utf8')).toBe(
      'const cap = 21;\n'
    );
  });

  it('refuses a mirror that resolves inside the repository', async () => {
    const { repoRoot } = await fakeRepository();
    await expect(mirroredPort(repoRoot, repoRoot, 'scripts/gate.ts', always(true))).rejects.toThrow(
      /inside the repository/
    );
  });
});

describe('the subject check', () => {
  it('refuses a subject that traverses out through its parent directory', async () => {
    const { repoRoot, mirrorRoot } = await build();
    const sideways = 'scripts/../packages/sibling.txt';
    await expect(mirroredPort(repoRoot, mirrorRoot, sideways, always(true))).rejects.toThrow(
      /plain repository-relative path/
    );
    expect(await fs.readFile(path.join(repoRoot, 'packages', 'sibling.txt'), 'utf8')).toBe(
      'sibling\n'
    );
  });

  it('refuses a subject with a leading slash, which no top-level entry can carry', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    await expect(mirrorRepository(repoRoot, ['/scripts/gate.ts'], scratchParent)).rejects.toThrow(
      /plain repository-relative path/
    );
    expect(await fs.readdir(scratchParent)).toEqual([]);
  });

  it('refuses a subject that traverses above the repository root', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await expect(mirroredPort(repoRoot, mirrorRoot, '../gate.ts', always(true))).rejects.toThrow(
      /plain repository-relative path/
    );
  });

  /**
   * Every shape here lands inside the mirror once the port joins it, so none is
   * an escape and the refusal is about the spelling alone. The backslash clause
   * is the one that looks like containment and is not: it exists because a
   * backslash-bearing segment is several segments on Windows, where a `..`
   * among them would traverse, which the spelling driven here does not.
   */
  it('refuses every non-canonical spelling, none of which resolves outside the named directory', async () => {
    const { repoRoot, mirrorRoot } = await build();
    const shapes = ['', 'scripts/./gate.ts', String.raw`scripts\gate.ts`, 'C:/scripts/gate.ts'];
    for (const shape of shapes) {
      await expect(mirroredPort(repoRoot, mirrorRoot, shape, always(true))).rejects.toThrow(
        /plain repository-relative path/
      );
    }
  });

  it('names no path in its refusal, since the path is the host layout', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await expect(mirroredPort(repoRoot, mirrorRoot, '../escape.ts', always(true))).rejects.toThrow(
      /^(?:(?!escape).)*$/s
    );
  });
});

/**
 * A repository whose subject is a relative link into a sibling top-level
 * directory — the shape whose mirrored copy points back at the tracked file.
 */
async function linkedSubjectRepository(): Promise<{ repoRoot: string; scratchParent: string }> {
  const fixture = await fakeRepository();
  await fs.writeFile(
    path.join(fixture.repoRoot, 'packages', 'bound.ts'),
    'const cap = 20;\n',
    'utf8'
  );
  const subject = path.join(fixture.repoRoot, 'scripts', 'gate.ts');
  await fs.rm(subject);
  await fs.symlink(path.join('..', 'packages', 'bound.ts'), subject);
  await fs.mkdir(fixture.scratchParent, { recursive: true });
  return fixture;
}

describe('the mirrored-destination check', () => {
  it('writes through a mirrored link subject into the repository itself', async () => {
    const { repoRoot, scratchParent } = await linkedSubjectRepository();
    const mirrorRoot = await mirrorRepository(repoRoot, ['scripts/gate.ts'], scratchParent);
    await fs.writeFile(path.join(mirrorRoot, 'scripts', 'gate.ts'), 'written\n', 'utf8');
    expect(await fs.readFile(path.join(repoRoot, 'packages', 'bound.ts'), 'utf8')).toBe(
      'written\n'
    );
  });

  it('refuses a subject whose mirrored copy is a link back into the repository', async () => {
    const { repoRoot, scratchParent } = await linkedSubjectRepository();
    const mirrorRoot = await mirrorRepository(repoRoot, ['scripts/gate.ts'], scratchParent);
    await expect(
      mirroredPort(repoRoot, mirrorRoot, 'scripts/gate.ts', always(true))
    ).rejects.toThrow(/inside the repository/);
    expect(await fs.readFile(path.join(repoRoot, 'packages', 'bound.ts'), 'utf8')).toBe(
      'const cap = 20;\n'
    );
  });

  it('stops a whole sweep whose subject is a link, leaving its target byte-identical', async () => {
    const { repoRoot, scratchParent } = await linkedSubjectRepository();
    const tracked = path.join(repoRoot, 'packages', 'bound.ts');
    const before = await fs.readFile(tracked);
    await expect(
      runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, () =>
        Promise.resolve({ rejected: false, output: '' })
      )
    ).rejects.toThrow(/inside the repository/);
    expect(await fs.readFile(tracked)).toEqual(before);
  });

  it('refuses a subject the mirror only reaches through a linked directory', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await expect(
      mirroredPort(repoRoot, mirrorRoot, 'packages/sibling.txt', always(true))
    ).rejects.toThrow(/inside the repository/);
    expect(await fs.readFile(path.join(repoRoot, 'packages', 'sibling.txt'), 'utf8')).toBe(
      'sibling\n'
    );
  });

  it('refuses a subject reached through a link that leaves the mirror without entering the repository', async () => {
    const { repoRoot, mirrorRoot } = await build();
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'bound-sweep-elsewhere-'));
    scratches.push(elsewhere);
    await fs.writeFile(path.join(elsewhere, 'sibling.txt'), 'elsewhere\n', 'utf8');
    const linked = path.join(mirrorRoot, 'packages');
    await fs.rm(linked);
    await fs.symlink(elsewhere, linked, 'junction');
    await expect(
      mirroredPort(repoRoot, mirrorRoot, 'packages/sibling.txt', always(true))
    ).rejects.toThrow(/resolves outside the mirror/);
    expect(await fs.readFile(path.join(elsewhere, 'sibling.txt'), 'utf8')).toBe('elsewhere\n');
  });

  it('refuses a subject the mirror holds no entry for', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await expect(
      mirroredPort(repoRoot, mirrorRoot, 'scripts/absent.ts', always(true))
    ).rejects.toThrow(/does not hold as a file it copied/);
  });

  it('refuses a subject the mirror holds as a directory rather than a file', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await expect(mirroredPort(repoRoot, mirrorRoot, 'scripts', always(true))).rejects.toThrow(
      /does not hold as a file it copied/
    );
  });

  it('names no path in either refusal, since the path is the host layout', async () => {
    const { repoRoot, mirrorRoot } = await build();
    await expect(
      mirroredPort(repoRoot, mirrorRoot, 'scripts/absent.ts', always(true))
    ).rejects.toThrow(/^(?:(?!absent).)*$/s);
    await expect(
      mirroredPort(repoRoot, mirrorRoot, 'packages/sibling.txt', always(true))
    ).rejects.toThrow(/^(?:(?!sibling).)*$/s);
  });
});

describe('runSweep', () => {
  /** Records what the mirror held each time the oracle ran, and how it answered. */
  const watchingOracle = (
    seen: string[],
    verdicts: readonly boolean[]
  ): ((cwd: string) => Promise<{ rejected: boolean; output: string }>) => {
    let call = 0;
    return async (cwd: string) => {
      seen.push(await fs.readFile(path.join(cwd, 'scripts', 'gate.ts'), 'utf8'));
      const rejected = verdicts[call] ?? false;
      call += 1;
      return { rejected, output: 'oracle said so' };
    };
  };

  it('asks the oracle about the unmutated mirror before writing any mutant', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    const seen: string[] = [];
    await runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, watchingOracle(seen, []));
    expect(seen).toEqual(['const cap = 20;\n', 'const cap = 19;\n', 'const cap = 21;\n']);
  });

  it('refuses the sweep when the oracle is already red on the unmutated mirror', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    const seen: string[] = [];
    await expect(
      runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, watchingOracle(seen, [true]))
    ).rejects.toThrow(/red on the unmutated mirror/);
    expect(seen).toEqual(['const cap = 20;\n']);
  });

  it('surfaces the output of the failed baseline run, so the refusal is diagnosable', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    await expect(
      runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, watchingOracle([], [true]))
    ).rejects.toThrow(/oracle said so/);
  });

  it('returns a verdict per mutant once the baseline is green', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    const results = await runSweep(
      repoRoot,
      ['scripts/gate.ts'],
      scratchParent,
      watchingOracle([], [false, true, false])
    );
    expect(results.map((result) => result.verdict)).toEqual(['killed', 'survived']);
  });

  it('leaves the swept subject byte-identical in the repository', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    await runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, watchingOracle([], []));
    expect(await fs.readFile(path.join(repoRoot, 'scripts', 'gate.ts'), 'utf8')).toBe(
      'const cap = 20;\n'
    );
  });

  /** The mirror root each oracle call was asked about, which is what was built. */
  const recordingOracle = (
    roots: string[],
    rejected = false
  ): ((cwd: string) => Promise<{ rejected: boolean; output: string }>) => {
    return (cwd: string) => {
      roots.push(cwd);
      return Promise.resolve({ rejected, output: 'oracle said so' });
    };
  };

  it('removes the mirror it built once the sweep is done', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    const roots: string[] = [];

    await runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, recordingOracle(roots));

    expect(existsSync(roots[0] ?? '')).toBe(false);
  });

  it('removes the mirror when the baseline refuses the sweep', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });
    const roots: string[] = [];

    await expect(
      runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, recordingOracle(roots, true))
    ).rejects.toThrow(/red on the unmutated mirror/);

    expect(existsSync(roots[0] ?? '')).toBe(false);
  });

  // Every top-level entry the subject does not live in is a link back into the
  // repository, so a removal that descended a link would delete the tree being
  // swept — announced much later, in an unrelated command.
  it('leaves the repository the mirror links back to intact', async () => {
    const { repoRoot, scratchParent } = await fakeRepository();
    await fs.mkdir(scratchParent, { recursive: true });

    await runSweep(repoRoot, ['scripts/gate.ts'], scratchParent, watchingOracle([], []));

    expect(await fs.readFile(path.join(repoRoot, 'packages', 'sibling.txt'), 'utf8')).toBe(
      'sibling\n'
    );
    expect(await fs.readFile(path.join(repoRoot, 'node_modules', 'marker.txt'), 'utf8')).toBe(
      'root modules\n'
    );
  });
});

describe('commandOracle', () => {
  it('reads a non-zero exit as the oracle rejecting the mirror', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bound-sweep-oracle-'));
    scratches.push(scratch);
    const outcome = await commandOracle('node -e "process.exit(1)"')(scratch);
    expect(outcome.rejected).toBe(true);
  });

  it('carries the output of the command back for the caller to surface', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bound-sweep-oracle-'));
    scratches.push(scratch);
    const outcome = await commandOracle('node -e "console.error(\'probe spoke\')"')(scratch);
    expect(outcome).toEqual({ rejected: false, output: expect.stringContaining('probe spoke') });
  });
});

describe('the recorded sweep subject', () => {
  /**
   * The record is what makes a re-run a check rather than a fresh measurement:
   * without the set and the per-source movements, a later enumeration has
   * nothing to disagree with. So the record is re-derived here, source by
   * source: any swept source whose bound-bearing constructs move fails this,
   * and the failure names the source and the movement. Two things a total
   * cannot say are why the record is a table: two sources moving in opposite
   * directions cancel in a sum, and one movement swapped for another cancels
   * in a per-source count — a threshold retuned or a comparison loosened
   * leaves the count exactly where it was.
   *
   * What a movement still cannot say is where it sits. The same movement is
   * one row wherever in the source it occurs, so a bound relocated without
   * changing its kind, its value or its step passes. That is the residual
   * bought by a record no line-number edit can rot.
   */
  it('re-derives, per swept source, every movement the record claims for it', async () => {
    const root = path.join(import.meta.dirname, '..');
    const derived: Record<string, Record<string, number>> = {};
    for (const source of SWEPT_SOURCES) {
      const contents = await fs.readFile(path.join(root, ...source.split('/')), 'utf8');
      const movements: Record<string, number> = {};
      for (const mutant of enumerateBoundMutants(contents)) {
        const movement = boundMovement(mutant);
        movements[movement] = (movements[movement] ?? 0) + 1;
      }
      derived[source] = movements;
    }
    expect(derived).toEqual(SWEPT_MUTANT_MOVEMENTS);
  });

  /**
   * The scope the record was written for, stated a second time so that
   * narrowing it is an edit to two files rather than one. Nothing derives this
   * list, and that is the point: derived from the swept set it would pass over
   * any content whatsoever, which is the circularity the recorded values exist
   * to avoid. No other enumeration of what deserves sweeping exists to anchor
   * it to either — the sweep is invoked by no script and no workflow, so the
   * swept set is the only statement of scope in the tree. What this buys is
   * that a narrowing is deliberate and reviewable; it cannot make one
   * impossible.
   */
  it('sweeps exactly the sources the record was written for', () => {
    expect(
      [...SWEPT_SOURCES],
      'NARROWED SWEEP — dropping a source together with its recorded movements typechecks and leaves every other case green, so this literal is the only thing that reds. Change it deliberately, and record the movements of anything added in the same change.'
    ).toEqual(['scripts/privacy-gate.ts', 'scripts/pre-push.ts']);
  });
});

/**
 * A fixture whose mirror root and whose scratch parent are each a link back into
 * the repository: two shapes whose spelling is outside the tree while the
 * filesystem places them inside it.
 */
async function linkedIntoRepository(): Promise<{
  repoRoot: string;
  linkedMirror: string;
  inside: string;
  linkedScratch: string;
}> {
  const { repoRoot } = await fakeRepository();
  const beside = path.dirname(repoRoot);
  const linkedMirror = path.join(beside, 'mirror-link');
  await fs.symlink(repoRoot, linkedMirror, 'junction');
  const inside = path.join(repoRoot, 'scratch');
  await fs.mkdir(inside, { recursive: true });
  const linkedScratch = path.join(beside, 'scratch-link');
  await fs.symlink(inside, linkedScratch, 'junction');
  return { repoRoot, linkedMirror, inside, linkedScratch };
}

describe('the resolved outside-the-repository assertion', () => {
  it('writes through a mirror root linked to the repository into the repository itself', async () => {
    const { repoRoot, linkedMirror } = await linkedIntoRepository();
    await fs.writeFile(path.join(linkedMirror, 'scripts', 'gate.ts'), 'written\n', 'utf8');
    expect(await fs.readFile(path.join(repoRoot, 'scripts', 'gate.ts'), 'utf8')).toBe('written\n');
  });

  it('refuses a mirror root that resolves to the repository, leaving the subject byte-identical', async () => {
    const { repoRoot, linkedMirror } = await linkedIntoRepository();
    const tracked = path.join(repoRoot, 'scripts', 'gate.ts');
    const before = await fs.readFile(tracked);
    await expect(
      mirroredPort(repoRoot, linkedMirror, 'scripts/gate.ts', always(true))
    ).rejects.toThrow(/inside the repository/);
    expect(await fs.readFile(tracked)).toEqual(before);
  });

  it('writes through a scratch parent linked into the repository into the repository itself', async () => {
    const { inside, linkedScratch } = await linkedIntoRepository();
    await fs.writeFile(path.join(linkedScratch, 'marker.txt'), 'written\n', 'utf8');
    expect(await fs.readFile(path.join(inside, 'marker.txt'), 'utf8')).toBe('written\n');
  });

  it('refuses a scratch parent that resolves inside the repository, before creating anything', async () => {
    const { repoRoot, inside, linkedScratch } = await linkedIntoRepository();
    await expect(mirrorRepository(repoRoot, ['scripts/gate.ts'], linkedScratch)).rejects.toThrow(
      /inside the repository/
    );
    expect(await fs.readdir(inside)).toEqual([]);
  });

  it('names no path in either refusal, since the path is the host layout', async () => {
    const { repoRoot, linkedMirror, linkedScratch } = await linkedIntoRepository();
    await expect(
      mirroredPort(repoRoot, linkedMirror, 'scripts/gate.ts', always(true))
    ).rejects.toThrow(/^(?:(?!mirror-link).)*$/s);
    await expect(mirrorRepository(repoRoot, ['scripts/gate.ts'], linkedScratch)).rejects.toThrow(
      /^(?:(?!scratch-link).)*$/s
    );
  });
});
