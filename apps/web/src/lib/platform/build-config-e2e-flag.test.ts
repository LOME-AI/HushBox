import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  E2E_BUILD_FLAG_NAME,
  requiredE2eBuildFlagValue,
} from '../../../../../scripts/verify-bundle.js';

// Two places decide what an end-to-end build looks like: this app's Vite config,
// which installs the localStorage device-key store when the frontend flag carries
// a particular value, and the bundle verifier, which exempts a dist carrying that
// same value from the ban on shipping that store. The flag has two halves — the
// registry entry's name and the value that switches the build — and the verifier
// owns both: it binds the name to the registry and reads the value out of it.
// This pins the build side to the same two bindings, so neither half can drift
// while both files keep passing.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VITE_CONFIG = path.resolve(HERE, '../../../vite.config.ts');

const configSource = readFileSync(VITE_CONFIG, 'utf8');

/**
 * Lines of `source` carrying a quoted copy of `literal` — the shape of a
 * hand-typed second declaration of what the verifier already declares. Every
 * quoting form a string literal can be written under is looked for, so
 * reintroducing the literal under a different quote is not a way past this.
 *
 * Deliberately unconditional, for both halves alike. Pairing the value with the
 * flag's name on the same line would have gone vacuous the moment the config
 * stopped naming the flag in source, which is exactly what deriving the name
 * achieves.
 */
function linesQuoting(source: string, literal: string): string[] {
  const quoted = [`'${literal}'`, `"${literal}"`, `\`${literal}\``];
  return source.split('\n').filter((line) => quoted.some((form) => line.includes(form)));
}

describe('the web build config and the end-to-end flag', () => {
  it.each(["'", '"', '`'])('flags a line quoting a literal with %s', (quote) => {
    expect(
      linesQuoting(`const flag = ${quote}${E2E_BUILD_FLAG_NAME}${quote};`, E2E_BUILD_FLAG_NAME)
    ).toHaveLength(1);
  });

  it('reads the flag name it gates on out of the verifier', () => {
    expect(configSource).toContain('E2E_BUILD_FLAG_NAME');
  });

  it('restates that name nowhere in its own source', () => {
    expect(linesQuoting(configSource, E2E_BUILD_FLAG_NAME)).toEqual([]);
  });

  it('reads the value it gates on out of the shared registry', () => {
    expect(configSource).toContain('requiredE2eBuildFlagValue(');
  });

  it('restates that value nowhere in its own source', () => {
    expect(linesQuoting(configSource, requiredE2eBuildFlagValue())).toEqual([]);
  });
});
