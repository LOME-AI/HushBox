import { describe, expect, it } from 'vitest';

import * as content from './index.js';
import * as root from '../index.js';

/**
 * The two names a browser consumer reaches through `@hushbox/crypto/content`.
 * The door exists so a bundle can hold them without the root barrel's OPAQUE
 * modules, whose vendored dependency has top-level statements no tree-shaker
 * removes; a third name here would be an export nothing imports.
 */
const PUBLISHED = ['encryptTextForEpoch', 'generateKeyPair'] as const;

describe('the content door', () => {
  it('publishes exactly the names a consumer reaches through it', () => {
    expect(new Set(Object.keys(content))).toStrictEqual(new Set(PUBLISHED));
  });

  /**
   * Same binding, not an equivalent copy: this is what makes the door a
   * narrower view of the root barrel rather than a second publication of the
   * same logic.
   */
  it.each(PUBLISHED)('hands back the same binding as the root barrel for %s', (name) => {
    expect((content as Record<string, unknown>)[name]).toBe(
      (root as Record<string, unknown>)[name]
    );
  });
});
