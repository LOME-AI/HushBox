import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { ADMIN_PREVIEW_PREFIX, MARKETING_BASE_URL } from '@hushbox/shared';
import { GROWTH_INIT_SCRIPT } from '@hushbox/ui/growth/init-script';
import { envConfig, Mode, resolveRaw } from '@hushbox/shared/env.config';
import { MARKETING_PREVIEW_OUT_DIR } from '../../../../scripts/lib/bundling/admin-preview.js';
import siteConfig from '../../astro.config.mjs';
import previewConfig from '../../astro.config.preview.mjs';

/**
 * The site is built a second time for the admin origin to frame. Both halves
 * of that are established over the sources rather than over a build
 * directory: the output is git-ignored and this package's test task does not
 * build, so a guard reading a dist would pass or fail on whether someone had
 * happened to build.
 *
 * Lives outside `apps/marketing/src/pages/` for the same reason as the other page tests:
 * Astro routes every file under that directory.
 */

/** The two keys the preview build is allowed to differ in. */
const PREVIEW_ONLY_KEYS = ['base', 'outDir'] as const;

const MARKETING_MANIFEST = path.resolve(import.meta.dirname, '..', '..', 'package.json');

/** The preview build's own command, as the package declares it. */
function previewBuildCommand(): string {
  return z
    .object({ scripts: z.object({ 'admin-preview:build': z.string() }) })
    .parse(JSON.parse(readFileSync(MARKETING_MANIFEST, 'utf8'))).scripts['admin-preview:build'];
}

/**
 * The mode a build command names, or `undefined` where it names none. Both
 * spellings of the flag set the mode, so both are read here.
 */
function modeNamedBy(command: string): string | undefined {
  const argv = command.split(/\s+/u);
  const attached = argv.find((argument) => argument.startsWith('--mode='));
  if (attached !== undefined) return attached.slice('--mode='.length);
  const flag = argv.indexOf('--mode');
  return flag === -1 ? undefined : argv[flag + 1];
}

type AstroConfig = Record<string, unknown>;

function differingKeys(left: AstroConfig, right: AstroConfig): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => left[key] !== right[key])
    .toSorted((a, b) => a.localeCompare(b));
}

describe('the preview build', () => {
  it('serves the site under the prefix the admin origin frames it at', () => {
    expect((previewConfig as AstroConfig)['base']).toBe(`/${ADMIN_PREVIEW_PREFIX}`);
  });

  it('writes to the directory the copy step reads', () => {
    expect((previewConfig as AstroConfig)['outDir']).toBe(MARKETING_PREVIEW_OUT_DIR);
  });

  // Every marketing page existing under the preview prefix is this property
  // rather than a walk of a build: the pages and the content collections are
  // files on disk that both builds read, and the integrations are the array
  // the site config holds, spread into this one — so two builds differing only
  // in where output lands and what prefix their URLs carry read the same site,
  // whatever it grows next. The build mode decides publication as well and is
  // in neither configuration: a draft post is published by a non-production
  // build and hidden by a production one.
  it('differs from the site build in nothing but the prefix and the output directory', () => {
    expect(differingKeys(siteConfig as AstroConfig, previewConfig as AstroConfig)).toEqual([
      ...PREVIEW_ONLY_KEYS,
    ]);
  });

  // This test pins the derivation and nothing else: the command names no mode,
  // so this build resolves one from the stack selector like every other build.
  // Nothing in this file establishes that the framed copy stays silent under a
  // local stack. The two tests below run the production script, one string and
  // one mode, at the origins `ADMIN_URL` is spelled with, and a local stack
  // serves the framed copy at neither: it serves it at the hostname
  // `localhost`, which the script of every build but a production one counts
  // on, per `growthInitScript` and the per-mode cases in its own test. Whether
  // that copy must be silent there is an open question for the founder, not one
  // this file may answer by assertion.
  it('derives its mode from the stack selector, like every other build', () => {
    expect(modeNamedBy(previewBuildCommand())).toBeUndefined();
  });
});

/**
 * Run the beacon's inline script against a page loaded at `url`, answering
 * every request it made. The script is what every counted marketing page
 * carries inline, so running it is running the page's counting behaviour.
 */
function beaconRequestsFrom(url: string): string[] {
  const window = new Window({ url });
  const requested: string[] = [];
  const fetchStub = (path: string): Promise<Response> => {
    requested.push(path);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- intentional: the subject is the inline script's own behaviour, and naming the page globals as parameters is the only way to hand them to it
  const run = new Function(
    'window',
    'document',
    'location',
    'fetch',
    'URL',
    'URLSearchParams',
    GROWTH_INIT_SCRIPT
  ) as (...globals: unknown[]) => void;
  run(window, window.document, window.location, fetchStub, URL, URLSearchParams);
  return requested;
}

/** The origins `ADMIN_URL` is spelled with, across the modes that name one. */
const ADMIN_ORIGINS = Object.values(Mode)
  .map((mode) => resolveRaw(envConfig.ADMIN_URL, mode))
  .filter((value): value is string => typeof value === 'string')
  .map((value) => new URL(value).origin);

describe('a preview page loaded on the admin origin', () => {
  for (const origin of new Set(ADMIN_ORIGINS)) {
    it(`counts nothing at ${origin}`, () => {
      expect(beaconRequestsFrom(`${origin}/${ADMIN_PREVIEW_PREFIX}/welcome`)).toEqual([]);
    });
  }

  // The control on the assertions above: they are assertions that nothing
  // happened, and a harness that could never make a request would satisfy
  // every one of them while proving nothing. The same harness on the public
  // host has to count, or the silence above is silence about the harness.
  it('counts on the public host, so the silence above is about the hostname', () => {
    expect(beaconRequestsFrom(`${MARKETING_BASE_URL}/welcome`)).not.toEqual([]);
  });
});
