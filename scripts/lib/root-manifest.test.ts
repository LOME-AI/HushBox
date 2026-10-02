import { describe, it, expect } from 'vitest';

import {
  bodiesReachedBy,
  manifestScripts,
  reachesThroughReferences,
  referencedScriptAt,
  referencedScripts,
  rootScripts,
  tokensOf,
  turboRunTargets,
} from './root-manifest.js';

describe('manifestScripts', () => {
  it('reads the scripts of the manifest its path names', () => {
    expect(Object.keys(manifestScripts('scripts/package.json'))).toContain('test');
  });

  it('rejects a file that declares no scripts', () => {
    expect(() => manifestScripts('.jscpd.json')).toThrow();
  });
});

describe('rootScripts', () => {
  it('reads the scripts of the repository manifest', () => {
    expect(Object.keys(rootScripts())).toContain('dev');
  });
});

describe('tokensOf', () => {
  it('splits a body on runs of whitespace', () => {
    expect(tokensOf('pnpm  run\tsomething')).toEqual(['pnpm', 'run', 'something']);
  });

  it('drops the empty words whitespace at either end would produce', () => {
    expect(tokensOf(' pnpm dev ')).toEqual(['pnpm', 'dev']);
  });
});

describe('referencedScriptAt', () => {
  it('names the script the package manager runs at that word, with its body', () => {
    expect(referencedScriptAt(['pnpm', 'dev'], 0, { dev: 'tsx scripts/dev.ts' })).toEqual({
      name: 'dev',
      body: 'tsx scripts/dev.ts',
    });
  });

  it('answers nothing where the word after it names no script', () => {
    expect(
      referencedScriptAt(['pnpm', 'install'], 0, { dev: 'tsx scripts/dev.ts' })
    ).toBeUndefined();
  });

  it('answers nothing where the word is not the package manager', () => {
    expect(referencedScriptAt(['tsx', 'dev'], 0, { dev: 'tsx scripts/dev.ts' })).toBeUndefined();
  });

  it('answers nothing at the last word, which can name no script', () => {
    expect(referencedScriptAt(['pnpm'], 0, { dev: 'tsx scripts/dev.ts' })).toBeUndefined();
  });
});

describe('referencedScripts', () => {
  it('lists the scripts a body runs, in the order it names them', () => {
    const scripts = { first: 'tsx scripts/first.ts', second: 'tsx scripts/second.ts' };

    expect(referencedScripts('pnpm first && pnpm second', scripts)).toEqual(['first', 'second']);
  });
});

describe('bodiesReachedBy', () => {
  it('answers with the body of the script it names', () => {
    expect(bodiesReachedBy('outer', { outer: 'tsx scripts/outer.ts' })).toEqual([
      'tsx scripts/outer.ts',
    ]);
  });

  it('answers with the bodies it delegates to, however many scripts deep', () => {
    const scripts = { outer: 'pnpm middle', middle: 'pnpm inner', inner: 'tsx scripts/work.ts' };

    expect(bodiesReachedBy('outer', scripts)).toEqual([
      'pnpm middle',
      'pnpm inner',
      'tsx scripts/work.ts',
    ]);
  });

  it('answers nothing for a name the manifest does not declare', () => {
    expect(bodiesReachedBy('absent', { outer: 'tsx scripts/outer.ts' })).toEqual([]);
  });

  it('answers with a body once for each script that runs it', () => {
    const scripts = {
      root: 'pnpm first && pnpm second',
      first: 'tsx scripts/work.ts',
      second: 'tsx scripts/work.ts',
    };

    expect(bodiesReachedBy('root', scripts)).toEqual([
      'pnpm first && pnpm second',
      'tsx scripts/work.ts',
      'tsx scripts/work.ts',
    ]);
  });

  it('follows a script once where scripts run each other', () => {
    const scripts = { first: 'pnpm second', second: 'pnpm first' };

    expect(bodiesReachedBy('first', scripts)).toEqual(['pnpm second', 'pnpm first']);
  });
});

describe('reachesThroughReferences', () => {
  it('finds a marker written in the body itself', () => {
    expect(
      reachesThroughReferences('tsx scripts/work.ts', {}, (body) => body.includes('work'))
    ).toBe(true);
  });

  it('finds a marker through a script the body runs', () => {
    const scripts = { inner: 'tsx scripts/work.ts' };

    expect(
      reachesThroughReferences('pnpm inner', scripts, (body) => body.includes('scripts/work.ts'))
    ).toBe(true);
  });

  it('answers false where no body it reaches carries the marker', () => {
    const scripts = { inner: 'tsx scripts/other.ts' };

    expect(
      reachesThroughReferences('pnpm inner', scripts, (body) => body.includes('scripts/work.ts'))
    ).toBe(false);
  });

  it('terminates on scripts that run each other', () => {
    const scripts = { first: 'pnpm second', second: 'pnpm first' };

    expect(
      reachesThroughReferences('pnpm first', scripts, (body) => body.includes('scripts/work.ts'))
    ).toBe(false);
  });
});

describe('turboRunTargets', () => {
  it('reads the task a body runs through the task runner', () => {
    expect(turboRunTargets('turbo run test:skills')).toEqual(['test:skills']);
  });

  it('reads the task a body runs through the cache-writer wrapper', () => {
    expect(turboRunTargets('node --import tsx scripts/turbo-run.ts run //#privacy:check')).toEqual([
      '//#privacy:check',
    ]);
  });

  it('reads every task a body runs, in the order it names them', () => {
    expect(turboRunTargets('turbo run one && scripts/turbo-run.ts run two')).toEqual([
      'one',
      'two',
    ]);
  });

  it('reads nothing out of a body that runs no task', () => {
    expect(turboRunTargets('tsx scripts/seed.ts')).toEqual([]);
  });
});
