import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GROWTH_SCROLL_EVENTS } from '@hushbox/shared';
import { GROWTH_INIT_SCRIPT } from '@hushbox/ui/growth/init-script';
import { builtMarketingSite, writeGrowthEventIndex } from './growth-index';
import type { GrowthEventIndex } from '@hushbox/shared';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'growth-index-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const distributionDir = (): string => path.join(root, 'dist');
const indexFile = (): string => path.join(root, 'generated', 'growth-index.json');

/**
 * The client module a built page names, holding the environment context the
 * bundler inlined from the build's mode — the shape the real build emits, with
 * the mode as a template-literal argument to the shared environment reader.
 *
 * `null` stands for a build that named no such module, which is how a page
 * whose mode cannot be read arrives.
 */
function writeModeModule(mode: string | null): string {
  const relative = `_astro/env-${mode ?? 'silent'}.js`;
  const file = path.join(distributionDir(), relative);
  const context = mode === null ? '' : `var z=c({NODE_ENV:\`${mode}\`});`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `import{c}from"./x.js";${context}export{c};`);
  return relative;
}

/** Write a built page carrying the beacon, exactly as the marketing build emits one. */
function writePage(relative: string, body: string, mode: string | null = 'production'): void {
  writeCounted(relative, body, true, mode);
}

/** Write a built page, with or without the inline beacon the layouts render. */
function writeCounted(
  relative: string,
  body: string,
  counted: boolean,
  mode: string | null = 'production'
): void {
  const beacon = counted ? `<script>${GROWTH_INIT_SCRIPT}</script>` : '';
  const client = `<script type="module" src="/${writeModeModule(mode)}"></script>`;
  const file = path.join(distributionDir(), relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `<!DOCTYPE html><html><head><title>t</title></head><body>${body}${beacon}${client}</body></html>`
  );
}

/** Run the extractor over the fixture build and read back what it wrote. */
function extract(): GrowthEventIndex {
  writeGrowthEventIndex(distributionDir(), indexFile());
  return JSON.parse(readFileSync(indexFile(), 'utf8')) as GrowthEventIndex;
}

describe('writeGrowthEventIndex', () => {
  it('indexes a built page under the path it is served at', () => {
    writePage('welcome/index.html', '');
    expect(Object.keys(extract())).toEqual(['/welcome']);
  });

  it('indexes a blog post under its slug', () => {
    writePage('blog/why-we-published/index.html', '');
    expect(Object.keys(extract())).toEqual(['/blog/why-we-published']);
  });

  it('indexes a page built as a flat file under its bare path', () => {
    writePage('offline.html', '');
    expect(Object.keys(extract())).toEqual(['/offline']);
  });

  it('carries the name of every link and button on the page', () => {
    writePage(
      'welcome/index.html',
      '<a href="/signup">Start</a><button data-track="Hero CTA">Go</button>'
    );
    expect(extract()['/welcome']).toEqual(expect.arrayContaining(['link:/signup', 'hero-cta']));
  });

  it('carries the scroll thresholds on every indexed page', () => {
    writePage('welcome/index.html', '');
    expect(extract()['/welcome']).toEqual([...GROWTH_SCROLL_EVENTS]);
  });

  it('names an element once however many times the page repeats it', () => {
    writePage('welcome/index.html', '<a href="/signup">Start</a><a href="/signup">Start</a>');
    expect(extract()['/welcome']?.filter((name) => name === 'link:/signup')).toHaveLength(1);
  });

  // The index decides what a permanently-retained row may say, and a form
  // control is the one element whose name could carry something a person
  // typed. Nothing on this page is a link or a button, so nothing is named.
  it('derives no name from a form control', () => {
    writePage(
      'newsletter/index.html',
      '<form><input id="email" /><textarea id="note"></textarea><select id="pick"></select></form>'
    );
    expect(extract()['/newsletter']).toEqual([...GROWTH_SCROLL_EVENTS]);
  });

  // A page that renders no beacon can send none, so indexing it would admit a
  // path only a forged body could ever claim.
  it('leaves out a built page that renders no beacon', () => {
    writePage('welcome/index.html', '');
    writeCounted('404.html', '<a href="/welcome">Home</a>', false);
    expect(Object.keys(extract())).toEqual(['/welcome']);
  });

  it('refuses a build in which no page renders the beacon', () => {
    writeCounted('welcome/index.html', '', false);
    expect(() => writeGrowthEventIndex(distributionDir(), indexFile())).toThrow(/beacon/u);
  });

  it('leaves an index it would not change untouched', () => {
    writePage('welcome/index.html', '');
    extract();
    const unchangedSince = new Date(0);
    utimesSync(indexFile(), unchangedSince, unchangedSince);

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(statSync(indexFile()).mtimeMs).toBe(0);
  });

  // The deploy job holds no marketing build, only the merged bundle the
  // marketing build was copied into, so the index extracted from that bundle
  // has to be the one the marketing build would have produced.
  it('derives the same index from the merged bundle as from the marketing build', () => {
    writePage('welcome/index.html', '<a href="/signup">Start</a>');
    const fromMarketingBuild = extract();

    const merged = path.join(root, 'merged');
    cpSync(distributionDir(), merged, { recursive: true });
    writeFileSync(
      path.join(merged, 'index.html'),
      '<!DOCTYPE html><html><body>the app shell</body></html>'
    );
    const mergedIndexFile = path.join(root, 'generated', 'merged.json');
    writeGrowthEventIndex(merged, mergedIndexFile);

    expect(JSON.parse(readFileSync(mergedIndexFile, 'utf8'))).toEqual(fromMarketingBuild);
  });

  // The committed index describes the production site: a build under another
  // mode mounts components production does not, so a name derived from one
  // would name a click no visitor can make.
  it('refuses to write the index from a development-mode build', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writePage('welcome/index.html', '<a href="/signup">Start</a>', 'development');
    mkdirSync(path.dirname(indexFile()), { recursive: true });
    writeFileSync(indexFile(), 'the index that stands');

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(readFileSync(indexFile(), 'utf8')).toBe('the index that stands');
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('left as it stands'));
    warned.mockRestore();
  });

  // The merged bundle is assembled by a copy that removes nothing, so one
  // directory can hold the pages of several builds; a page is what says which
  // build it came from.
  it('refuses to write when one page of an otherwise production build reports another mode', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writePage('welcome/index.html', '<a href="/signup">Start</a>');
    writePage('privacy/index.html', '<a href="/terms">Terms</a>', 'e2e');
    mkdirSync(path.dirname(indexFile()), { recursive: true });
    writeFileSync(indexFile(), 'the index that stands');

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(readFileSync(indexFile(), 'utf8')).toBe('the index that stands');
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('/privacy was built under e2e'));
    warned.mockRestore();
  });

  // A build this cannot read is a build this cannot vouch for, and a mode it
  // finds nowhere has to read as a refusal rather than as production.
  it('refuses to write when a built page names no client module reporting its mode', () => {
    writePage('welcome/index.html', '<a href="/signup">Start</a>', null);
    mkdirSync(path.dirname(indexFile()), { recursive: true });
    writeFileSync(indexFile(), 'the index that stands');

    expect(() => writeGrowthEventIndex(distributionDir(), indexFile())).toThrow(
      /\/welcome names no client module/u
    );

    expect(readFileSync(indexFile(), 'utf8')).toBe('the index that stands');
  });

  // A build under a non-production mode is the ordinary state of a local or
  // end-to-end stack, so an unreadable page has to be found by a walk of the
  // whole build rather than by whichever page the walk reaches first.
  it('raises for a page it cannot read though an earlier page reports a legible mode', () => {
    writePage('blog/first/index.html', '<a href="/signup">Start</a>', 'e2e');
    writePage('welcome/index.html', '<a href="/signup">Start</a>', null);

    expect(() => writeGrowthEventIndex(distributionDir(), indexFile())).toThrow(
      /\/welcome names no client module/u
    );
  });

  // A page outlives the chunk it names when a later build lands beside an
  // earlier one's output, and a reference that resolves to nothing says nothing
  // about the build either way.
  it('reads the modules the build emitted, not the ones a page only names', () => {
    writePage('welcome/index.html', '<a href="/signup">Start</a>');
    const page = path.join(distributionDir(), 'welcome/index.html');
    writeFileSync(
      page,
      readFileSync(page, 'utf8').replace(
        '</body>',
        '<script type="module" src="/_astro/gone.js"></script></body>'
      )
    );

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(Object.keys(JSON.parse(readFileSync(indexFile(), 'utf8')))).toEqual(['/welcome']);
  });

  it('names the page and the mode it refused', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writePage('welcome/index.html', '<a href="/signup">Start</a>', 'development');

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(warned).toHaveBeenCalledWith(expect.stringContaining('/welcome'));
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('development'));
    warned.mockRestore();
  });

  // A local build under a non-production mode is the ordinary case, and a
  // refusal reported for one whose index matches the committed copy would be
  // noise about nothing.
  it('says nothing when the build it refuses yields the index that already stands', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writePage('welcome/index.html', '<a href="/signup">Start</a>');
    const production = writeGrowthEventIndex(distributionDir(), indexFile());
    rmSync(distributionDir(), { recursive: true });
    writePage('welcome/index.html', '<a href="/signup">Start</a>', 'e2e');

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(warned).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(indexFile(), 'utf8'))).toEqual(production);
    warned.mockRestore();
  });

  it('writes the index from a production build', () => {
    writePage('welcome/index.html', '<a href="/signup">Start</a>');
    mkdirSync(path.dirname(indexFile()), { recursive: true });
    writeFileSync(indexFile(), 'the index that stands');

    writeGrowthEventIndex(distributionDir(), indexFile());

    expect(Object.keys(JSON.parse(readFileSync(indexFile(), 'utf8')))).toEqual(['/welcome']);
  });

  it('answers the pages it wrote', () => {
    writePage('welcome/index.html', '<a href="/privacy">Privacy</a>');
    writePage('privacy/index.html', '');
    expect(Object.keys(writeGrowthEventIndex(distributionDir(), indexFile()))).toEqual([
      '/privacy',
      '/welcome',
    ]);
  });
});

describe('builtMarketingSite', () => {
  it('answers the marketing package build output when that package has been built', () => {
    mkdirSync(path.join(root, 'apps', 'marketing', 'dist'), { recursive: true });
    expect(builtMarketingSite(root)).toBe(path.join(root, 'apps', 'marketing', 'dist'));
  });

  it('answers the merged bundle when the marketing package has not been built', () => {
    mkdirSync(path.join(root, 'apps', 'web', 'dist'), { recursive: true });
    expect(builtMarketingSite(root)).toBe(path.join(root, 'apps', 'web', 'dist'));
  });

  it('prefers the marketing package build output when both exist', () => {
    mkdirSync(path.join(root, 'apps', 'marketing', 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'apps', 'web', 'dist'), { recursive: true });
    expect(builtMarketingSite(root)).toBe(path.join(root, 'apps', 'marketing', 'dist'));
  });

  it('refuses a tree in which the site has not been built at all', () => {
    expect(() => builtMarketingSite(root)).toThrow(/apps\/marketing\/dist/u);
  });
});

const MARKETING_ROOT = path.resolve(import.meta.dirname, '..');
const API_WRANGLER = path.join(MARKETING_ROOT, '..', 'api', 'wrangler.toml');
const MARKETING_MANIFEST = path.join(MARKETING_ROOT, 'package.json');
const BUILD_COMMAND = 'pnpm --filter @hushbox/marketing growth:index';

/** The `[build]` table's command, as the Worker's own build runs it. */
function wranglerBuildCommand(toml: string): string | undefined {
  const table = /^\[build\]\r?\n(?<body>(?:[^[\r\n].*\r?\n)*)/mu.exec(toml)?.groups?.['body'];
  return /^command = "(?<command>[^"]*)"$/mu.exec(table ?? '')?.groups?.['command'];
}

/** The scripts the marketing package declares. */
function marketingScripts(): Record<string, string> {
  return z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(MARKETING_MANIFEST, 'utf8'))).scripts;
}

describe("the Worker's own build", () => {
  // The Worker imports the index as a module, and a checkout carries the copy
  // the last extraction committed. The deploy job downloads the built site and
  // runs no task that re-extracts it, so without this the bundle would describe
  // whatever the committed copy last said rather than the site being deployed
  // with it.
  it('runs the index producer before the bundler resolves the import', () => {
    expect(wranglerBuildCommand(readFileSync(API_WRANGLER, 'utf8'))).toBe(BUILD_COMMAND);
  });

  it('names a script this package declares', () => {
    expect(Object.keys(marketingScripts())).toContain(BUILD_COMMAND.split(' ').at(-1));
  });
});
