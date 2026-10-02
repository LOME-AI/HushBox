import { describe, it, expect } from 'vitest';
import { manifestScripts } from '../root-manifest.js';
import type { BuildOutput } from './lease.js';

/**
 * The writers of a built output that take its lease through the shell wrapper
 * rather than in TypeScript, each with the output it writes. `scripts/preview.ts`
 * and `scripts/mobile-test.ts` are the other two writers; they take it around
 * part of their work only, so they are pinned by their own tests instead.
 */
const WRAPPED_SCRIPTS: readonly { manifest: string; script: string; resource: BuildOutput }[] = [
  { manifest: 'package.json', script: 'build', resource: 'web-dist' },
  { manifest: 'package.json', script: 'build:e2e', resource: 'web-dist' },
  { manifest: 'package.json', script: 'build:e2e:admin', resource: 'admin-dist' },
  { manifest: 'package.json', script: 'generate:headers', resource: 'web-dist' },
  { manifest: 'package.json', script: 'cap:test-update', resource: 'web-dist' },
  { manifest: 'apps/web/package.json', script: 'cap:build:ios', resource: 'web-dist' },
  { manifest: 'apps/web/package.json', script: 'cap:build:android', resource: 'web-dist' },
];

/**
 * The body a manifest gives a script. A name it does not declare is an error
 * rather than an empty body, because the case "leaves $manifest $script on the
 * wrapper default, which is the web output" reads a script for what it must not
 * contain, and an empty body satisfies that for every name there is.
 */
function readScript(manifest: string, script: string): string {
  const body = manifestScripts(manifest)[script];

  if (body === undefined) {
    throw new Error(`${manifest} declares no "${script}" script`);
  }

  return body;
}

describe('the shared build output writers', () => {
  it.each(WRAPPED_SCRIPTS)(
    'runs $manifest $script under the build lease',
    ({ manifest, script }) => {
      expect(readScript(manifest, script)).toContain('with-build-lease.ts');
    }
  );

  it.each(WRAPPED_SCRIPTS.filter((entry) => entry.resource !== 'web-dist'))(
    'keys $manifest $script on the $resource lease',
    ({ manifest, script, resource }) => {
      expect(readScript(manifest, script)).toContain(`--resource=${resource}`);
    }
  );

  it.each(WRAPPED_SCRIPTS.filter((entry) => entry.resource === 'web-dist'))(
    'leaves $manifest $script on the wrapper default, which is the web output',
    ({ manifest, script }) => {
      expect(readScript(manifest, script)).not.toContain('--resource=');
    }
  );

  it('leaves the web package own build script unleased, so the writers above can nest it', () => {
    expect(readScript('apps/web/package.json', 'build')).toBe('vite build');
  });

  it('refuses a script its manifest does not declare, rather than reading an empty body', () => {
    expect(() => readScript('package.json', 'a-script-no-manifest-declares')).toThrow();
  });
});
