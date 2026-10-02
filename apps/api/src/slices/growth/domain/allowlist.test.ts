import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARKETING_ROUTES, ROUTES, isKnownEvent, isKnownMarketingPage } from '@hushbox/shared';
import { bundledGrowthEventIndex, parseGrowthEventIndex } from './allowlist.js';

describe('parseGrowthEventIndex', () => {
  it('accepts a page mapped to its derived event names', () => {
    expect(parseGrowthEventIndex({ '/welcome': ['link:/signup', 'scroll-25'] })).toEqual({
      '/welcome': ['link:/signup', 'scroll-25'],
    });
  });

  it('accepts a page that produces no events', () => {
    expect(parseGrowthEventIndex({ '/terms': [] })).toEqual({ '/terms': [] });
  });

  // The index decides what a permanently-retained row may say. A shape this
  // cannot read is a build that went wrong, and starting the Worker with an
  // index nobody validated would count against names nothing derived.
  const refused: readonly (readonly [string, unknown])[] = [
    ['a value that is not an object', ['/welcome']],
    ['a page mapped to something other than a list', { '/welcome': 'link:/signup' }],
    ['a name that is not a string', { '/welcome': [7] }],
    ['nothing at all', null],
  ];
  it.each(refused)('refuses %s', (_label, raw) => {
    expect(() => parseGrowthEventIndex(raw)).toThrow(/index/u);
  });

  // An index carrying no page at all is the worst shape available: it parses,
  // the Worker starts, and every click the site sends is rejected against an
  // allowlist that names nothing, with no error anywhere. Refusing it here
  // rather than only where it is produced means the guarantee holds for every
  // path that reaches an index, whichever producer wrote it.
  it('refuses an index carrying no page', () => {
    expect(() => parseGrowthEventIndex({})).toThrow(/index/u);
  });
});

describe('bundledGrowthEventIndex', () => {
  it('answers an index the page validator accepts', () => {
    const index = bundledGrowthEventIndex();
    expect(isKnownMarketingPage(MARKETING_ROUTES[0], Object.keys(index))).toBe(true);
  });

  // The static routes come from the one list the headers generator already
  // fails the build over, so they are known pages whatever the build emitted.
  it.each(MARKETING_ROUTES)('accepts the built static route %s', (route) => {
    expect(isKnownMarketingPage(route, Object.keys(bundledGrowthEventIndex()))).toBe(true);
  });

  it('accepts no event name for a page the index does not carry', () => {
    expect(isKnownEvent('/not-a-page', 'scroll-25', bundledGrowthEventIndex())).toBe(false);
  });

  // The index reaches the Worker as a module the marketing build wrote. An empty
  // one is not a quiet degradation: every named event on the site would be
  // dropped, and nothing would say so.
  it('carries the pages the marketing build emitted', () => {
    expect(Object.keys(bundledGrowthEventIndex()).length).toBeGreaterThan(0);
  });

  it('accepts a scroll threshold on the landing page the build indexed', () => {
    expect(isKnownEvent(ROUTES.MARKETING, 'scroll-25', bundledGrowthEventIndex())).toBe(true);
  });

  it('answers the same index on every call', () => {
    expect(bundledGrowthEventIndex()).toEqual(bundledGrowthEventIndex());
  });
});

describe('the index file the Worker bundles', () => {
  // The checkout carries this file and the continuous-integration build job
  // gates it by regenerating and diffing. An ignore rule reaching it would
  // blind both at once: git reports no difference for a path it ignores, so the
  // gate would read clean while the committed index drifted, and a checkout
  // would carry no index at all — which is the empty allowlist that rejects
  // every click and counts every event as zero.
  //
  // `--no-index` puts the question to the ignore rules rather than to the
  // index, the way the workflow's own skill-drift step does: without it a rule
  // over a tracked file reads clean until the file stops being tracked, which
  // is exactly when the answer would matter.
  it('is not ignored by git', () => {
    const asked = spawnSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
      'git',
      ['check-ignore', '--no-index', '--', 'growth-index.json'],
      { cwd: import.meta.dirname, encoding: 'utf8' }
    );
    expect(asked.stdout).toBe('');
    expect(asked.status).toBe(1);
  });
});

describe('the index under a loader that does not bundle', () => {
  // The Worker bundles this module, but the development seeding door re-exports
  // the slice and Node loads that chain itself — from the end-to-end fixtures,
  // which transpile TypeScript and hand the result straight to Node's module
  // loader. That loader refuses a JSON module imported without an attribute
  // saying so, and it refuses it at link time, before any test body runs: one
  // such import collapses a whole suite into zero tests in zero files. Running
  // the module under Node itself is the only way to ask that question, because
  // every bundler in this repository answers it for us.
  it("loads under Node's own module loader", () => {
    const loaded = spawnSync(
      process.execPath,
      [
        '-e',
        'import(process.argv[1])',
        pathToFileURL(path.join(import.meta.dirname, 'allowlist.ts')).href,
      ],
      { encoding: 'utf8' }
    );
    expect(loaded.stderr).not.toMatch(/import attribute/u);
    expect(loaded.status).toBe(0);
  });
});
