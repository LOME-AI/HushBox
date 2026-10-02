import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { growthBeaconReferencesIn } from '@hushbox/shared';

// Growth measurement counts anonymous marketing visitors and never the people
// signed into the product: the two halves are unjoinable only while the beacon
// exists on one side of the boundary. A single `fetch` to the beacon path from
// this app would carry a signed-in session's timing and page into the anonymous
// aggregates, and nothing downstream could separate it out again — the counts
// are set cardinalities kept forever, with no per-row identity to filter on.
// So the property is not "the app sends nothing sensitive"; it is that the app
// names the beacon at all, which is what this file refuses.
//
// Reading the campaign tag out of `?c=` on the signup route is the one permitted
// touch, because that tag is a label shared by everyone who followed the same
// link and the registration write needs it. Reading the referrer or the page's
// own path is not permitted even on that route: both describe where this
// particular person came from, which is the visitor-level fact the boundary
// exists to keep out of the account.
//
// The sweep reads the app's own sources rather than a built bundle. `dist/` is
// git-ignored and the `test` turbo task does not depend on `build`, so a guard
// over built output would pass or fail on whether someone happened to have built
// the app. Walking the import graph into the workspace packages is not the
// substitute either: `@hushbox/shared`'s barrel re-exports the growth enums, so
// every module importing anything from that barrel reaches them in the graph
// while the bundler drops them from the bundle — reachability over-approximates
// the bundle by exactly the amount that would make this guard permanently red.
// What survives both is the app's own text: an author adding beacon code, or
// importing a beacon symbol from a package, writes one of these tokens here.
// The artifact itself is read by `scripts/verify-bundle.ts`, which runs as its
// own gate after a build; that layer is what catches a package module naming
// the beacon without any module here naming it.

/** `apps/web/src` — every module this app contributes to its bundle. */
const WEB_SRC = path.resolve(import.meta.dirname, '..');
const ROUTES_DIR = path.join(WEB_SRC, 'routes');
const AUTH_ROUTES_DIR = path.join(ROUTES_DIR, '_auth');

const documentReferrerRead = /\bdocument\s*\.\s*referrer\b/;
const ownPathRead = /\blocation\s*\.\s*pathname\b/;

function readsDocumentReferrer(source: string): boolean {
  return documentReferrerRead.test(source);
}

function readsOwnPath(source: string): boolean {
  return ownPathRead.test(source);
}

/** Every non-test TypeScript module under `directory`, as forward-slash paths relative to it. */
function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => entry.split(path.sep).join('/'))
    .toSorted((left, right) => left.localeCompare(right));
}

function read(directory: string, file: string): string {
  return readFileSync(path.join(directory, file), 'utf8');
}

const REFERRER_READ = `const from = document.referrer;`;
const OWN_PATH_READ = `const here = globalThis.location.pathname;`;
const CAMPAIGN_TAG_READ = `validateSearch: (search) => ({ c: campaignTagSchema.catch(undefined).parse(search['c']) }),`;

// The beacon detector is shared with the artifact layer and tested where it
// lives. What is app-specific is here: the two page-level reads that are
// forbidden even on the one route allowed to touch growth at all, and the read
// that route is allowed.
describe('the growth detectors', () => {
  it('reports a read of the document referrer', () => {
    expect(readsDocumentReferrer(REFERRER_READ)).toBe(true);
  });

  it('reports a read of the page path', () => {
    expect(readsOwnPath(OWN_PATH_READ)).toBe(true);
  });

  it('permits the signup route to read the campaign tag from the query string', () => {
    expect(growthBeaconReferencesIn(CAMPAIGN_TAG_READ)).toEqual([]);
    expect(readsDocumentReferrer(CAMPAIGN_TAG_READ)).toBe(false);
    expect(readsOwnPath(CAMPAIGN_TAG_READ)).toBe(false);
  });
});

describe('the signed-in app', () => {
  it('names the beacon in no source module', () => {
    const offenders = sourceFilesUnder(WEB_SRC)
      .map((file) => ({ file, references: growthBeaconReferencesIn(read(WEB_SRC, file)) }))
      .filter((entry) => entry.references.length > 0);
    expect(offenders).toEqual([]);
  });

  it('sweeps every route module', () => {
    const routeModules = sourceFilesUnder(ROUTES_DIR).map((file) => `routes/${file}`);
    expect(routeModules.length).toBeGreaterThan(0);
    expect(sourceFilesUnder(WEB_SRC)).toEqual(expect.arrayContaining(routeModules));
  });
});

describe('the auth routes', () => {
  it('read the document referrer nowhere', () => {
    const offenders = sourceFilesUnder(AUTH_ROUTES_DIR).filter((file) =>
      readsDocumentReferrer(read(AUTH_ROUTES_DIR, file))
    );
    expect(offenders).toEqual([]);
  });

  it('read their own path nowhere', () => {
    const offenders = sourceFilesUnder(AUTH_ROUTES_DIR).filter((file) =>
      readsOwnPath(read(AUTH_ROUTES_DIR, file))
    );
    expect(offenders).toEqual([]);
  });
});
