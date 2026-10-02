import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { envRegistryContentIn } from '@hushbox/shared/env-registry-content';
import { buildRenderBundle, writeRenderBundle, RENDER_BUNDLE_PATH } from './build-bundle.js';

/**
 * The backend env registry, built the way the sandbox's shipped scripts are — a
 * minified browser IIFE — so the haystack is a bundler's own output rather than
 * an authored stand-in for it. Resolved through the package's export map, so
 * moving the registry inside `@hushbox/shared` fails here instead of quietly
 * building something else.
 */
async function buildEnvRegistryBundle(): Promise<string> {
  const result = await build({
    entryPoints: [createRequire(import.meta.url).resolve('@hushbox/shared/env.config')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    write: false,
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error('esbuild produced no output for the env registry');
  return output.text;
}

describe('renderer bundle', () => {
  it('produces a classic-script IIFE (not an ES module)', async () => {
    const bundle = await buildRenderBundle();
    // The page loads the renderer as a classic script, which runs immediately
    // and pulls nothing over the network; esbuild's iife format wraps everything
    // in a self-invoking function with no top-level import/export.
    expect(bundle.startsWith('"use strict";(()=>')).toBe(true);
    expect(bundle.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps the committed public/render.js in sync with the source', async () => {
    const fresh = await buildRenderBundle();
    const committed = readFileSync(RENDER_BUNDLE_PATH, 'utf8');
    expect(committed).toBe(fresh);
  }, 30_000);

  it('writeRenderBundle rewrites the committed bundle from source', async () => {
    await writeRenderBundle();
    expect(readFileSync(RENDER_BUNDLE_PATH, 'utf8')).toBe(await buildRenderBundle());
  }, 30_000);

  // The sandbox origin is credential-free by design — nothing to steal. The bundle
  // must never embed the backend env-config registry: its production var names and
  // its dev-mode secret-shaped values would then be served in the clear from a
  // public origin. This is the guard against the whole-barrel import that inlines it.
  it('embeds no backend env-config registry names, values, or markers', async () => {
    expect(envRegistryContentIn(await buildRenderBundle())).toEqual([]);
  }, 30_000);

  // The bundle is what is scanned, so a guard that stopped reading it would report
  // green forever. Planting a registry declaration in the built text is what proves
  // the assertion above is over the bundle rather than over nothing.
  it('reports registry content planted in the built bundle', async () => {
    const leaked = `${await buildRenderBundle()};var r={OPAQUE_KEK:{to:["backend"]}};`;
    expect(envRegistryContentIn(leaked)).toContain('OPAQUE_KEK');
  }, 30_000);

  // A `to` array is the shape the registry's own declarations survive a build in, and
  // each plant carries one form a destination survives in, which is one form the marker
  // pattern must read — the destination string folded into the array, a property read
  // off the destination table left standing as a property read. `Destination` is an
  // `as const` object rather than an enum, so nothing inlines its members and the read
  // survives the build. The table's identifier is minifier-chosen, so a plant reading
  // one reads a renamed one. Each plant is a positive control — the emptiness the
  // registry guard asserts is satisfied just as well by a detector that matches
  // nothing.
  it('reports a destination marker inlined into the built bundle', async () => {
    const leaked = `${await buildRenderBundle()};var d={to:[\`backend\`]};`;
    expect(envRegistryContentIn(leaked)).toContain('backend destination marker');
  }, 30_000);

  it('reports a destination marker read off the destination table in the built bundle', async () => {
    const leaked = `${await buildRenderBundle()};var d={to:[$.Backend]};`;
    expect(envRegistryContentIn(leaked)).toContain('backend destination marker');
  }, 30_000);

  // A planted shape pins the marker pattern against what a build was expected to
  // emit; this pins it against what a build does emit — the registry itself, put
  // through a build of the same shape. A pattern that stops reading the emitted
  // form fails here without anyone having predicted that form. The finding is
  // what is asserted, never the bundle text: the identifier the destination table
  // binds to is minifier-chosen.
  it('reports a destination marker emitted by a real bundle of the env registry', async () => {
    expect(envRegistryContentIn(await buildEnvRegistryBundle())).toContain(
      'backend destination marker'
    );
  }, 30_000);
});
