import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { envRegistryContentIn } from '@hushbox/shared/env-registry-content';
import { buildPythonBundle, writePythonBundle, PYTHON_BUNDLE_PATH } from './build-python-bundle.js';

describe('Python runtime bundle', () => {
  it('produces a classic-script IIFE (not an ES module)', async () => {
    const bundle = await buildPythonBundle();
    expect(bundle.startsWith('"use strict";(()=>')).toBe(true);
    expect(bundle.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps the committed public/python.js in sync with the source', async () => {
    const fresh = await buildPythonBundle();
    const committed = readFileSync(PYTHON_BUNDLE_PATH, 'utf8');
    expect(committed).toBe(fresh);
  }, 30_000);

  it('writePythonBundle rewrites the committed bundle from source', async () => {
    await writePythonBundle();
    expect(readFileSync(PYTHON_BUNDLE_PATH, 'utf8')).toBe(await buildPythonBundle());
  }, 30_000);

  // The sandbox origin is credential-free by design. The bundle must never embed
  // the backend env-config registry: its production var names and dev-mode
  // secret-shaped values would then be served in the clear from a public origin.
  // This guards against the whole-barrel import that inlines it.
  it('embeds no backend env-config registry names, values, or markers', async () => {
    expect(envRegistryContentIn(await buildPythonBundle())).toEqual([]);
  }, 30_000);

  // The bundle is what is scanned, so a guard that stopped reading it would report
  // green forever. Planting a registry declaration in the built text is what proves
  // the assertion above is over the bundle rather than over nothing.
  it('reports registry content planted in the built bundle', async () => {
    const leaked = `${await buildPythonBundle()};var r={OPAQUE_KEK:{to:["backend"]}};`;
    expect(envRegistryContentIn(leaked)).toContain('OPAQUE_KEK');
  }, 30_000);

  // A `to` array is the shape the registry's own declarations survive a build in, and
  // the two plants below are the two the marker pattern must read: the destination
  // string folded into the array, and a property read off the destination table that
  // the minifier declined to fold. The table's identifier is minifier-chosen, so the
  // plant reads a renamed one. Both are positive controls — the emptiness asserted
  // above is satisfied just as well by a detector that matches nothing.
  it('reports a destination marker inlined into the built bundle', async () => {
    const leaked = `${await buildPythonBundle()};var d={to:[\`backend\`]};`;
    expect(envRegistryContentIn(leaked)).toContain('backend destination marker');
  }, 30_000);

  it('reports a destination marker read off the destination table in the built bundle', async () => {
    const leaked = `${await buildPythonBundle()};var d={to:[$.Backend]};`;
    expect(envRegistryContentIn(leaked)).toContain('backend destination marker');
  }, 30_000);
});
