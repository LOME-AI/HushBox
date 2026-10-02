/**
 * Radius token names, and the one reader that decides how a quoted key spells.
 *
 * A radius name reaches the detector from the DESIGN.md YAML frontmatter and
 * from the JSON sidecar, and the frontmatter reader in
 * `lib/yaml-frontmatter.mjs` has already unquoted the frontmatter keys. So the
 * detector's own unquoting is what decides whether those sources agree, and the
 * only spelling where a second implementation could disagree with that reader
 * is a key whose quote is unpaired: the reader leaves it verbatim, a looser
 * rule strips it, and the same token then names a different radius depending on
 * which file declared it.
 *
 * Run these on their own with `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDesignSystem } from './design-system.mjs';

/** The radius names a sidecar's `roundedMeta` keys produce, in declaration order. */
function radiusNames(/** @type {Record<string, unknown>} */ roundedMeta) {
  return normalizeDesignSystem({ sidecar: { extensions: { roundedMeta } } }).allowedRadii.map(
    (radius) => radius.name
  );
}

test('a sidecar radius key wrapped in matching quotes is named without them', () => {
  assert.deepEqual(radiusNames({ '"lg"': '8px' }), ['sidecar.lg']);
});

test('a sidecar radius key carrying one unpaired quote keeps it, as the frontmatter reader does', () => {
  assert.deepEqual(radiusNames({ "'md": '4px' }), ["sidecar.'md"]);
});
