import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { overriddenKeysFor } from './build-variants.js';

describe('the keys a web dist may bake in place of the production environment file', () => {
  it('admits none in the primary dist served over HTTP', () => {
    expect(overriddenKeysFor('dist', true)).toEqual([]);
  });

  it('admits the platform in the primary dist an application packages', () => {
    expect(overriddenKeysFor('dist', false)).toEqual(['VITE_PLATFORM']);
  });

  it.each(['dist-ios', 'dist-android', 'dist-android-direct'])(
    'admits the platform in the OTA dist %s',
    (distributionDirName) => {
      expect(overriddenKeysFor(distributionDirName, false)).toEqual(['VITE_PLATFORM']);
    }
  );

  it('refuses a directory no build variant writes', () => {
    expect(() => overriddenKeysFor('dist-watchos', false)).toThrow('dist-watchos');
  });

  // The loop sets variables in shell, outside every generated block, so the
  // declaration it must stay inside is the one each of its bundles is held to.
  it('admits every variable the OTA loop sets for each bundle it builds', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml'),
      'utf8'
    );
    const loop = /for platform in ([^;\n]+); do\n([\s\S]*?)\n\s*done/u.exec(workflow);
    const platforms = (loop?.[1] ?? '').trim().split(/\s+/u);
    const assigned = [...(loop?.[2] ?? '').matchAll(/(?<![\w$])([A-Z][A-Z0-9_]*)=/gu)].map(
      (match) => match[1] ?? ''
    );

    expect(assigned).toContain('VITE_PLATFORM');
    const undeclared = platforms.flatMap((platform) => {
      const admitted = overriddenKeysFor(`dist-${platform}`, false);
      return assigned.filter((key) => !admitted.includes(key)).map((key) => `${platform}: ${key}`);
    });
    expect(undeclared).toEqual([]);
  });
});
