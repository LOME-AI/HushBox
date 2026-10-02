import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { collectSourceFiles, runDesignTokenScan } from './verify-design-tokens.js';

const FIXTURE_PREFIX = 'hushbox-design-tokens-';

/**
 * Runs one case against a fresh fixture tree staged outside the repository. A
 * fixture inside a source tree is a directory every repository-wide scan
 * enumerates, so a concurrent one dies naming a path that is nobody's source.
 */
function withFixtureTree(body: (fixtureRoot: string) => void): () => Promise<void> {
  return () =>
    withScratchDirectory(FIXTURE_PREFIX, (fixtureRoot) => {
      body(fixtureRoot);
      return Promise.resolve();
    });
}

function write(fixtureRoot: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

/**
 * The smallest tree the scan accepts: every root it walks holds a file, because
 * a root collecting nothing is a scan that passes vacuously and is refused.
 */
const CLEAN_TREE: Readonly<Record<string, string>> = {
  'apps/web/src/app.tsx': 'export const app = <p className="text-foreground" />;\n',
  'apps/web/src/notes.md': 'Prose the scan does not read.\n',
  'apps/admin/src/app.tsx': 'export const admin = <p className="text-destructive" />;\n',
  'apps/marketing/src/index.astro': '---\n---\n<p class="text-muted-foreground"></p>\n',
  'packages/ui/src/button.tsx': 'export const button = <button className="bg-primary" />;\n',
};

function scan(
  fixtureRoot: string,
  files: Readonly<Record<string, string>> = {}
): ReturnType<typeof runDesignTokenScan> {
  write(fixtureRoot, { ...CLEAN_TREE, ...files });
  return runDesignTokenScan(fixtureRoot);
}

describe('collectSourceFiles', () => {
  function collect(fixtureRoot: string): string[] {
    const files: string[] = [];
    collectSourceFiles(fixtureRoot, files);
    return files;
  }

  it(
    'collects authored source files',
    withFixtureTree((fixtureRoot) => {
      mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(path.join(fixtureRoot, 'src/app.css'), 'body {}\n');
      expect(collect(fixtureRoot)).toEqual([path.join(fixtureRoot, 'src/app.css')]);
    })
  );

  it(
    'excludes files under dist-ota build output',
    withFixtureTree((fixtureRoot) => {
      mkdirSync(path.join(fixtureRoot, 'dist-ota/assets'), { recursive: true });
      writeFileSync(path.join(fixtureRoot, 'dist-ota/assets/index.css'), 'body {}\n');
      expect(collect(fixtureRoot)).toEqual([]);
    })
  );

  it(
    'excludes the Capacitor android synced web assets',
    withFixtureTree((fixtureRoot) => {
      const synced = path.join(fixtureRoot, 'android/app/src/main/assets/public/assets');
      mkdirSync(synced, { recursive: true });
      writeFileSync(path.join(synced, 'index.css'), 'body {}\n');
      expect(collect(fixtureRoot)).toEqual([]);
    })
  );

  it(
    'excludes the Capacitor ios synced web assets',
    withFixtureTree((fixtureRoot) => {
      const synced = path.join(fixtureRoot, 'ios/App/App/public/assets');
      mkdirSync(synced, { recursive: true });
      writeFileSync(path.join(synced, 'index.css'), 'body {}\n');
      expect(collect(fixtureRoot)).toEqual([]);
    })
  );
});

describe('runDesignTokenScan', () => {
  it(
    'passes over a tree that writes every colour as a token',
    withFixtureTree((fixtureRoot) => {
      const outcome = scan(fixtureRoot);
      expect(outcome.code).toBe(0);
      expect(outcome.report).toContain('no findings');
    })
  );

  it(
    'counts the files it read',
    withFixtureTree((fixtureRoot) => {
      expect(scan(fixtureRoot).report).toContain('4 file(s) scanned');
    })
  );

  it(
    'refuses a scan whose root holds no source file',
    withFixtureTree((fixtureRoot) => {
      write(fixtureRoot, {
        'apps/web/src/app.tsx': 'export const app = 1;\n',
        'apps/admin/src/app.tsx': 'export const admin = 1;\n',
        'apps/marketing/src/index.astro': '---\n---\n',
        'packages/ui/src/notes.md': 'Prose no scan reads.\n',
      });
      expect(() => runDesignTokenScan(fixtureRoot)).toThrow(/collected no source files/u);
    })
  );

  it(
    'fails on a source file using the non-canonical muted-foreground utility',
    withFixtureTree((fixtureRoot) => {
      const outcome = scan(fixtureRoot, {
        'apps/web/src/label.tsx': 'export const label = <p className="text-foreground-muted" />;\n',
      });
      expect(outcome.code).toBe(1);
      expect(outcome.report).toContain('apps/web/src/label.tsx');
    })
  );

  it(
    'allows the Tailwind configuration to define the retired alias',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, {
          'packages/config/tailwind/index.css': '@utility text-foreground-muted {}\n',
        }).code
      ).toBe(0);
    })
  );

  it(
    'allows a test file to name the retired utility',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, {
          'apps/web/src/label.test.tsx': "expect('text-foreground-muted').toBeTruthy();\n",
        }).code
      ).toBe(0);
    })
  );

  it(
    'fails on a source file hardcoding the brand hex',
    withFixtureTree((fixtureRoot) => {
      const outcome = scan(fixtureRoot, {
        'packages/ui/src/mark.tsx': 'export const mark = <p className="text-[#ec4755]" />;\n',
      });
      expect(outcome.code).toBe(1);
      expect(outcome.report).toContain('packages/ui/src/mark.tsx');
    })
  );

  it(
    'allows a test file to name the brand hex',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, {
          'packages/ui/src/mark.test.tsx': "expect('text-[#ec4755]').toBeTruthy();\n",
        }).code
      ).toBe(0);
    })
  );

  it(
    'fails on a raw palette class under a guarded tree, naming the line',
    withFixtureTree((fixtureRoot) => {
      const outcome = scan(fixtureRoot, {
        'apps/admin/src/panel.tsx':
          'export const panel = (\n  <p className="text-red-500" />\n);\n',
      });
      expect(outcome.code).toBe(1);
      expect(outcome.report).toContain('apps/admin/src/panel.tsx:2');
    })
  );

  it(
    'fails on a raw palette class written as a directional border',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, {
          'apps/marketing/src/card.astro': '<p class="border-l-amber-200"></p>\n',
        }).code
      ).toBe(1);
    })
  );

  it(
    'allows a palette class on a development-only surface',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, {
          'apps/web/src/components/shared/dev-only.tsx':
            'export const dev = <p className="bg-lime-300" />;\n',
        }).code
      ).toBe(0);
    })
  );

  it(
    'leaves a palette class outside the guarded trees alone',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, {
          'packages/shared/src/swatch.ts': "export const swatch = 'bg-lime-300';\n",
        }).code
      ).toBe(0);
    })
  );

  it(
    'ignores a class whose utility is not a palette utility',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, { 'apps/web/src/moved.tsx': 'export const moved = "translate-x-100";\n' })
          .code
      ).toBe(0);
    })
  );

  it(
    'ignores a class whose colour is not a palette colour',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, { 'apps/web/src/brand.tsx': 'export const brand = "text-brand-500";\n' })
          .code
      ).toBe(0);
    })
  );

  it(
    'ignores a class whose shade is not a palette shade',
    withFixtureTree((fixtureRoot) => {
      expect(
        scan(fixtureRoot, { 'apps/web/src/shade.tsx': 'export const shade = "text-red-999";\n' })
          .code
      ).toBe(0);
    })
  );
});
