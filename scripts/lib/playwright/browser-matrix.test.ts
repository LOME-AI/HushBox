import { describe, it, expect } from 'vitest';

import {
  assertPinnedWorkRunnable,
  computeProjectGrepInvert,
  formatRunProjects,
  matrix,
  resolveCarriers,
  resolveRunProjects,
  resolveSelectedProjects,
} from './browser-matrix.js';
import {
  ALL_PROJECT_NAMES,
  BROWSER_MATRIX_PROJECTS,
  DESKTOP_PROJECTS,
  E2E_PROJECTS,
  MOBILE_PROJECTS,
  PLANE_PROJECTS,
} from './projects.js';

/**
 * The names an invocation may pass. The config owns this list and hands it in;
 * the module classifies only the browser-matrix projects, so the planes stand in
 * for every name it does not route across (they and the setup projects).
 */
const KNOWN = [...BROWSER_MATRIX_PROJECTS, ...PLANE_PROJECTS];

/** Titles as Playwright composes them: the test title followed by its tags. */
function titleWith(tags: readonly string[]): string {
  return `some behaviour ${tags.join(' ')}`;
}

/** True when the project would RUN a spec carrying these tags. */
function runs(project: string, selected: readonly string[], tags: readonly string[]): boolean {
  const title = titleWith(tags);
  return !computeProjectGrepInvert(project, selected).some((pattern) => pattern.test(title));
}

describe('matrix declaration', () => {
  it('emits the engine-matrix tag and the form-factor tag', () => {
    expect(matrix({ engine: 'engine-matrix', formFactor: 'desktop' }).tag).toEqual([
      '@engine-matrix',
      '@desktop',
    ]);
  });

  it('encodes the form factor into the engine-any routing tag', () => {
    expect(
      matrix({ engine: 'engine-any', formFactor: 'mobile', reason: 'no engine dependency' }).tag
    ).toEqual(['@engine-any-mobile', '@mobile']);
  });

  it('surfaces the engine-any reason as an annotation so the claim is visible in reports', () => {
    const declared = matrix({
      engine: 'engine-any',
      formFactor: 'desktop',
      reason: 'pure arithmetic',
    });
    expect(declared.annotation).toEqual([{ type: 'engine-any', description: 'pure arithmetic' }]);
  });

  it('carries no annotation for an engine-matrix declaration', () => {
    expect(matrix({ engine: 'engine-matrix', formFactor: 'either' }).annotation).toBeUndefined();
  });

  it('emits the engine-fixed tag and the form-factor tag', () => {
    expect(matrix({ engine: 'engine-fixed', formFactor: 'desktop' }).tag).toEqual([
      '@engine-fixed',
      '@desktop',
    ]);
  });

  it('carries no annotation for an engine-fixed declaration', () => {
    expect(matrix({ engine: 'engine-fixed', formFactor: 'desktop' }).annotation).toBeUndefined();
  });

  it('names the engine in the engine-pinned routing tag', () => {
    expect(
      matrix({
        engine: 'engine-pinned',
        pinnedEngine: 'chromium',
        formFactor: 'desktop',
        reason: 'the harness capability this file needs exists on one engine',
      }).tag
    ).toEqual(['@engine-pinned-chromium', '@desktop']);
  });

  it('surfaces the engine-pinned reason as an annotation so the constraint is visible in reports', () => {
    const declared = matrix({
      engine: 'engine-pinned',
      pinnedEngine: 'chromium',
      formFactor: 'desktop',
      reason: 'staged over a protocol no other engine speaks',
    });
    expect(declared.annotation).toEqual([
      { type: 'engine-pinned', description: 'staged over a protocol no other engine speaks' },
    ]);
  });
});

describe('a reason that says nothing is refused', () => {
  // The refusal is the compiler's, so each directive below IS the assertion: it
  // fails the build the moment the type stops rejecting, which TypeScript
  // reports as an unused directive. Nothing at runtime looks at the reason,
  // which is why the calls still return their tags.

  it('refuses an empty engine-any reason', () => {
    // @ts-expect-error an empty reason meets rule 4.6 in form and not at all in substance
    expect(matrix({ engine: 'engine-any', formFactor: 'desktop', reason: '' }).tag).toEqual([
      '@engine-any-desktop',
      '@desktop',
    ]);
  });

  it('refuses a whitespace-only engine-any reason', () => {
    // @ts-expect-error a blank reason is the empty one with a space in it
    expect(matrix({ engine: 'engine-any', formFactor: 'either', reason: '  ' }).tag).toEqual([
      '@engine-any-either',
      '@either',
    ]);
  });

  it('refuses a reason on an engine-fixed declaration', () => {
    expect(
      matrix({
        engine: 'engine-fixed',
        formFactor: 'desktop',
        // @ts-expect-error the plane's registry entry already states the fact, so a per-spec sentence is the paste this arm exists to delete
        reason: 'the admin plane is one project',
      }).tag
    ).toEqual(['@engine-fixed', '@desktop']);
  });

  it('refuses an empty engine-pinned reason', () => {
    expect(
      matrix({
        engine: 'engine-pinned',
        pinnedEngine: 'chromium',
        formFactor: 'desktop',
        // @ts-expect-error rule 4.7 asks for a constraint, and the empty string names none
        reason: '',
      }).tag
    ).toEqual(['@engine-pinned-chromium', '@desktop']);
  });
});

describe('resolveSelectedProjects', () => {
  it('selects every known project when the invocation names none', () => {
    expect(resolveSelectedProjects(['node', 'cli.js', 'test'], KNOWN)).toEqual(KNOWN);
  });

  it('reads the --project=value form', () => {
    expect(
      resolveSelectedProjects(['node', 'cli.js', 'test', '--project=chromium'], KNOWN)
    ).toEqual(['chromium']);
  });

  it('reads the space-separated --project value form', () => {
    expect(
      resolveSelectedProjects(['node', 'cli.js', 'test', '--project', 'webkit'], KNOWN)
    ).toEqual(['webkit']);
  });

  it('accumulates repeated --project flags', () => {
    expect(
      resolveSelectedProjects(
        ['node', 'cli.js', 'test', '--project=chromium', '--project', 'iphone-15'],
        KNOWN
      )
    ).toEqual(['chromium', 'iphone-15']);
  });

  it('ignores unrelated flags that merely contain the word project', () => {
    expect(
      resolveSelectedProjects(
        ['node', 'cli.js', 'test', '--reporter=list', '--project=firefox'],
        KNOWN
      )
    ).toEqual(['firefox']);
  });

  // Playwright declares `--project <project-name...>` variadic, so commander
  // keeps consuming bare tokens after the space-separated form. Reading only
  // one would under-select silently — the run would hold projects this
  // derivation never saw, and specs whose carrier is among them would go
  // nowhere.
  it('consumes every project in the variadic space-separated form', () => {
    expect(
      resolveSelectedProjects(
        ['node', 'cli.js', 'test', '--project', 'iphone-15', 'chromium'],
        KNOWN
      )
    ).toEqual(['iphone-15', 'chromium']);
  });

  it('stops variadic consumption at the next flag', () => {
    expect(
      resolveSelectedProjects(
        ['node', 'cli.js', 'test', '--project', 'chromium', 'webkit', '--retries=0'],
        KNOWN
      )
    ).toEqual(['chromium', 'webkit']);
  });

  it('throws when a variadic token is not a project, rather than selecting a subset', () => {
    expect(() =>
      resolveSelectedProjects(
        ['node', 'cli.js', 'test', '--project', 'chromium', 'e2e/chat/'],
        KNOWN
      )
    ).toThrow(/e2e\/chat\//);
  });

  // The `=` form is NOT variadic in commander: it emits its value and stops, so
  // a following operand is a test-path filter, not a project name.
  it('does not consume a trailing operand after the equals form', () => {
    expect(
      resolveSelectedProjects(['node', 'cli.js', 'test', '--project=chromium', 'e2e/chat/'], KNOWN)
    ).toEqual(['chromium']);
  });

  it('throws on a project name the config does not define', () => {
    expect(() =>
      resolveSelectedProjects(['node', 'cli.js', 'test', '--project=chrome'], KNOWN)
    ).toThrow(/chrome/);
  });

  it('throws rather than guessing when the selector is a glob', () => {
    expect(() =>
      resolveSelectedProjects(['node', 'cli.js', 'test', '--project=chrom*'], KNOWN)
    ).toThrow(/glob/i);
  });

  it('throws when --project is given no value', () => {
    expect(() => resolveSelectedProjects(['node', 'cli.js', 'test', '--project'], KNOWN)).toThrow(
      /--project/
    );
  });

  it('throws when --project is followed by another flag instead of a value', () => {
    expect(() =>
      resolveSelectedProjects(['node', 'cli.js', 'test', '--project', '--retries=0'], KNOWN)
    ).toThrow(/--project/);
  });

  it('throws on an empty --project= value', () => {
    expect(() => resolveSelectedProjects(['node', 'cli.js', 'test', '--project='], KNOWN)).toThrow(
      /--project/
    );
  });
});

describe('resolveCarriers', () => {
  it('picks the first desktop and first mobile project in preference order', () => {
    expect(resolveCarriers(BROWSER_MATRIX_PROJECTS)).toEqual({
      desktop: 'chromium',
      mobile: 'iphone-15',
      either: 'chromium',
    });
  });

  it('falls to the next preferred project when the first is not selected', () => {
    expect(resolveCarriers(['firefox', 'pixel-7'])).toEqual({
      desktop: 'firefox',
      mobile: 'pixel-7',
      either: 'firefox',
    });
  });

  it('routes either-form-factor work to the mobile carrier when no desktop project is selected', () => {
    expect(resolveCarriers(['iphone-15'])).toEqual({
      desktop: undefined,
      mobile: 'iphone-15',
      either: 'iphone-15',
    });
  });

  it('yields no carriers when the run selects no browser-matrix project', () => {
    expect(resolveCarriers(['admin'])).toEqual({
      desktop: undefined,
      mobile: undefined,
      either: undefined,
    });
  });
});

describe('form-factor routing', () => {
  const all = BROWSER_MATRIX_PROJECTS;

  it('keeps desktop-declared specs off every mobile project', () => {
    for (const project of MOBILE_PROJECTS) {
      expect(runs(project, all, ['@engine-matrix', '@desktop'])).toBe(false);
    }
  });

  it('keeps mobile-declared specs off every desktop project', () => {
    for (const project of DESKTOP_PROJECTS) {
      expect(runs(project, all, ['@engine-matrix', '@mobile'])).toBe(false);
    }
  });

  it('runs either-declared engine-matrix specs on every project', () => {
    for (const project of [...DESKTOP_PROJECTS, ...MOBILE_PROJECTS]) {
      expect(runs(project, all, ['@engine-matrix', '@either'])).toBe(true);
    }
  });

  it('does not confuse the engine-any routing tag with the form-factor tag', () => {
    // `@engine-any-desktop` must not satisfy a `@desktop` match, and vice versa.
    expect(runs('chromium', all, ['@engine-any-mobile', '@mobile'])).toBe(false);
    expect(runs('iphone-15', all, ['@engine-any-desktop', '@desktop'])).toBe(false);
  });
});

describe('engine-any routing lands on exactly one selected project', () => {
  function carriersOf(selected: readonly string[], tags: readonly string[]): string[] {
    return selected.filter((project) => runs(project, selected, tags));
  }

  it('runs a desktop engine-any spec on one project under the full matrix', () => {
    expect(carriersOf(BROWSER_MATRIX_PROJECTS, ['@engine-any-desktop', '@desktop'])).toEqual([
      'chromium',
    ]);
  });

  it('runs a mobile engine-any spec on one project under the full matrix', () => {
    expect(carriersOf(BROWSER_MATRIX_PROJECTS, ['@engine-any-mobile', '@mobile'])).toEqual([
      'iphone-15',
    ]);
  });

  it('runs an either engine-any spec on exactly one project across both form factors', () => {
    expect(carriersOf(BROWSER_MATRIX_PROJECTS, ['@engine-any-either', '@either'])).toEqual([
      'chromium',
    ]);
  });

  it('carries a desktop engine-any spec on a two-project quick run', () => {
    expect(carriersOf(['chromium', 'iphone-15'], ['@engine-any-desktop', '@desktop'])).toEqual([
      'chromium',
    ]);
  });

  it('carries an either engine-any spec on a mobile-only invocation instead of skipping it', () => {
    expect(carriersOf(['iphone-15'], ['@engine-any-either', '@either'])).toEqual(['iphone-15']);
  });

  // Stated on the mobile axis because no pin constrains it. A desktop selection
  // that drops chromium is refused outright (see the engine-pinned suite), so the
  // desktop half of this property is now proved on `resolveCarriers` alone.
  it('moves the mobile carrier to the only selected mobile project', () => {
    expect(carriersOf(['chromium', 'ipad-pro'], ['@engine-any-mobile', '@mobile'])).toEqual([
      'ipad-pro',
    ]);
  });
});

describe('engine-pinned routing refuses rather than substituting', () => {
  const PINNED_DESKTOP = ['@engine-pinned-chromium', '@desktop'];

  it('runs a pinned spec only on the projects of its engine and form factor', () => {
    expect(
      BROWSER_MATRIX_PROJECTS.filter((project) =>
        runs(project, BROWSER_MATRIX_PROJECTS, PINNED_DESKTOP)
      )
    ).toEqual(['chromium']);
  });

  it('keeps a pinned spec off a project that shares its engine but not its form factor', () => {
    // pixel-7 is a chromium project; only the form-factor tag holds it back.
    expect(runs('pixel-7', BROWSER_MATRIX_PROJECTS, PINNED_DESKTOP)).toBe(false);
  });

  it('refuses a selection that hosts the pinned form factor without the pinned engine', () => {
    expect(() => computeProjectGrepInvert('webkit', ['webkit', 'pixel-7'])).toThrow(
      /engine-pinned chromium/
    );
  });

  it('names the projects that would satisfy a refused selection', () => {
    expect(() => computeProjectGrepInvert('firefox', ['firefox'])).toThrow(/chromium/);
  });

  it('accepts a selection that hosts the pinned form factor with the pinned engine', () => {
    expect(() => computeProjectGrepInvert('chromium', ['chromium', 'iphone-15'])).not.toThrow();
  });

  it('accepts a selection that hosts no project of the pinned form factor', () => {
    expect(() => computeProjectGrepInvert('iphone-15', ['iphone-15'])).not.toThrow();
  });

  it('drops pinned desktop work from a mobile-only run instead of moving it', () => {
    expect(runs('iphone-15', ['iphone-15'], PINNED_DESKTOP)).toBe(false);
  });

  it('refuses a mobile pin whose engine is absent from the selected mobile projects', () => {
    expect(() => {
      assertPinnedWorkRunnable(['pixel-7'], [{ pinnedEngine: 'webkit', formFactor: 'mobile' }]);
    }).toThrow(/engine-pinned webkit/);
  });

  it('accepts a mobile pin the selected mobile projects can host', () => {
    expect(() => {
      assertPinnedWorkRunnable(['iphone-15'], [{ pinnedEngine: 'webkit', formFactor: 'mobile' }]);
    }).not.toThrow();
  });

  it('refuses an either-form-factor pin no selected project can host', () => {
    expect(() => {
      assertPinnedWorkRunnable(
        ['chromium', 'iphone-15'],
        [{ pinnedEngine: 'firefox', formFactor: 'either' }]
      );
    }).toThrow(/engine-pinned firefox/);
  });

  it('accepts an either-form-factor pin one selected project can host', () => {
    expect(() => {
      assertPinnedWorkRunnable(
        ['firefox', 'iphone-15'],
        [{ pinnedEngine: 'firefox', formFactor: 'either' }]
      );
    }).not.toThrow();
  });

  it('ignores plane projects when deciding whether a selection hosts the pin', () => {
    // A plane's spec set is its own testDir, so it can never carry pinned work.
    expect(() => {
      assertPinnedWorkRunnable(['admin'], [{ pinnedEngine: 'chromium', formFactor: 'desktop' }]);
    }).not.toThrow();
  });
});

describe('non-matrix planes are never gated', () => {
  it('applies no exclusions to a project the two axes do not route across', () => {
    // A plane has a fixed spec set from its own testDir, so a form-factor or
    // carrier exclusion there would only remove coverage.
    for (const plane of PLANE_PROJECTS) {
      expect(computeProjectGrepInvert(plane, BROWSER_MATRIX_PROJECTS)).toEqual([]);
    }
  });
});

describe('undeclared specs keep running everywhere', () => {
  it('excludes nothing for a spec carrying no declaration tags', () => {
    for (const project of [...DESKTOP_PROJECTS, ...MOBILE_PROJECTS]) {
      expect(runs(project, BROWSER_MATRIX_PROJECTS, [])).toBe(true);
    }
  });
});

describe('run projects', () => {
  const query = (argv: readonly string[], runSet?: string, isCI = false): readonly string[] =>
    resolveRunProjects({ argv, runSet, knownProjects: KNOWN, isCI });

  it('takes the run from this process when no run set is declared', () => {
    expect(query(['--project=firefox'])).toEqual(['firefox']);
  });

  it('treats a blank run set as no run set', () => {
    expect(query(['--project=firefox'], '  ')).toEqual(['firefox']);
  });

  it('leaves an undeclared full invocation running the whole registry', () => {
    expect(query([])).toEqual(KNOWN);
  });

  it('takes the run from the declared run set, not from this process', () => {
    expect(query(['--project=firefox'], 'chromium,firefox')).toEqual(['chromium', 'firefox']);
  });

  it('throws when the declared run set omits a project this process runs', () => {
    expect(() => query(['--project=webkit'], 'chromium,firefox')).toThrow(/webkit/);
  });

  it('throws on a run set naming a project the config does not define', () => {
    expect(() => query(['--project=firefox'], 'chromium,edge')).toThrow(/edge/);
  });

  it('throws under CI on a narrowed invocation that declares no run set', () => {
    expect(() => query(['--project=firefox'], undefined, true)).toThrow(/E2E_RUN_PROJECTS/);
  });

  it('lets a whole-registry invocation under CI stand as its own run', () => {
    expect(query([], undefined, true)).toEqual(KNOWN);
  });
});

// The property the whole declared matrix exists for, at the boundary CI uses.
// Every other routing test asserts within ONE selection; CI issues one
// single-project process per job, and no such process can see the run from its
// own argv. Fold over the registry, reproduce the invocation each job gets, and
// count the jobs that would run one engine-any spec.
describe('engine-any work across the jobs CI issues', () => {
  const runSet = formatRunProjects(E2E_PROJECTS.map((project) => project.name));

  const jobsRunning = (tags: readonly string[]): string[] =>
    E2E_PROJECTS.flatMap((project) => {
      // A plane takes a fixed testDir holding no engine-declared spec, so it is
      // not a candidate carrier however its routing resolves.
      if (project.role === 'plane') return [];
      const run = resolveRunProjects({
        argv: [`--project=${project.name}`],
        runSet,
        knownProjects: ALL_PROJECT_NAMES,
        isCI: true,
      });
      return runs(project.name, run, tags) ? [project.name] : [];
    });

  it('runs a desktop engine-any spec in exactly one job', () => {
    expect(jobsRunning(['@engine-any-desktop', '@desktop'])).toEqual(['chromium']);
  });

  it('runs a mobile engine-any spec in exactly one job', () => {
    expect(jobsRunning(['@engine-any-mobile', '@mobile'])).toEqual(['iphone-15']);
  });

  it('runs an either engine-any spec in exactly one job across both form factors', () => {
    expect(jobsRunning(['@engine-any-either', '@either'])).toEqual(['chromium']);
  });

  it('runs a pinned spec in exactly the job of its engine', () => {
    expect(jobsRunning(['@engine-pinned-chromium', '@desktop'])).toEqual(['chromium']);
  });

  it('still runs an engine-matrix spec in every job of its form factor', () => {
    expect(jobsRunning(['@engine-matrix', '@desktop'])).toEqual([...DESKTOP_PROJECTS]);
    expect(jobsRunning(['@engine-matrix', '@mobile'])).toEqual([...MOBILE_PROJECTS]);
  });
});
