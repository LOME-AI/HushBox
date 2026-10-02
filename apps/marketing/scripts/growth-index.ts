import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import {
  canonicalMarketingPath,
  createEnvUtilities,
  deriveEventName,
  GROWTH_CLICK_SELECTOR,
  GROWTH_SCROLL_EVENTS,
} from '@hushbox/shared';
import { GROWTH_INIT_SCRIPT } from '@hushbox/ui/growth/init-script';
import { isMainModule } from '../../../scripts/lib/cli/is-main.js';
import { runMain } from '../../../scripts/lib/cli/run-main.js';
import type { GrowthEventIndex } from '@hushbox/shared';

/**
 * The page-and-event index the beacon validates every body against, extracted
 * from the site the build just emitted.
 *
 * Extracted rather than maintained: a new call to action is measured from the
 * deploy that ships it, nobody has to remember an attribute, and a name
 * nothing on the page derives cannot be minted by a sender. That last part is
 * why this exists at all — growth rows are kept forever, so an attacker-chosen
 * event name is not a bad row for an afternoon.
 *
 * Names come from the shared derivation, which is also what the inline script
 * transcribes and what the admin overlay badges with, so a name in this file
 * is the name a click actually sends.
 */

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MARKETING_ROOT = path.resolve(CURRENT_DIR, '..');
const REPO_ROOT = path.resolve(MARKETING_ROOT, '../..');

/** The committed index, relative to the repo root. */
export const INDEX_FILE = 'apps/api/src/slices/growth/domain/growth-index.json';

/**
 * Where the built marketing site sits: the marketing build output if that
 * package has been built, else the merged bundle.
 *
 * One site, two locations, because the merge that assembles the deployed
 * bundle copies the marketing build on top of the web build verbatim: the same
 * pages land at the same relative paths, and a page carrying no beacon is
 * skipped either way, so the two directories yield the same index. Which one a
 * context has differs: the deploy job downloads the built bundle and builds no
 * marketing package, so the merged bundle is the only copy it holds.
 */
export function builtMarketingSite(repoRoot: string): string {
  const candidates = ['apps/marketing/dist', 'apps/web/dist'];
  const built = candidates
    .map((relative) => path.join(repoRoot, relative))
    .find((directory) => existsSync(directory));
  if (built === undefined) {
    throw new Error(
      `no built marketing site under ${candidates.join(' or ')}; build the site before extracting its event index`
    );
  }
  return built;
}

/** Every built page, as a path relative to the build directory, in a stable order. */
function builtPages(distributionDir: string): string[] {
  return readdirSync(distributionDir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.html'))
    .map((entry) => entry.split(path.sep).join('/'))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * The path a built file is served at: `welcome/index.html` is served at
 * `/welcome`, because the site builds directory-style, and a page emitted as a
 * flat file at `offline.html` is served at `/offline`.
 */
function servedPath(relative: string): string {
  const bare = relative.replace(/(^|\/)index\.html$/u, '').replace(/\.html$/u, '');
  return canonicalMarketingPath(`/${bare}`);
}

/**
 * Every name this page's own markup can produce: one per link and button whose
 * markup yields a legal name, then the scroll thresholds every page reports.
 *
 * A form control derives nothing — the shared function refuses one before it
 * reads an attribute — so no page's name set can carry something a person
 * typed into it.
 */
function namesIn(window: Window, html: string): string[] {
  window.document.body.innerHTML = html;
  const derived = [...window.document.querySelectorAll(GROWTH_CLICK_SELECTOR)]
    .map((element) => deriveEventName(element))
    .filter((name): name is string => name !== null)
    .toSorted((left, right) => left.localeCompare(right));
  return [...new Set([...derived, ...GROWTH_SCROLL_EVENTS])];
}

/**
 * Every client module a built page names, as a path relative to the build
 * directory. Matched on the emitted asset path rather than on the attribute
 * carrying it, because a page names its modules from a script element, from an
 * island's component and renderer URLs, and from a preload link alike.
 */
function clientModulesIn(html: string): string[] {
  return [...new Set(html.match(/_astro\/[A-Za-z0-9._-]+\.js/gu))];
}

/**
 * The mode value of an inlined environment context, matched as the whole word
 * so that a module carrying none yields nothing rather than an absent capture.
 */
const BUILD_MODE_PATTERN = /(?<=NODE_ENV\s*:\s*["'`])[A-Za-z0-9_-]+(?=["'`])/gu;

/**
 * The environment the bundler inlined into a page's own client modules, as the
 * `NODE_ENV` values it finds there.
 *
 * The site reads its environment through one call that takes Vite's build mode
 * as `NODE_ENV` ({@link createEnvUtilities}), and the bundler folds that mode
 * into a literal, so the built page carries the mode it was emitted under. It
 * is read per page rather than per directory, because the merged bundle
 * ({@link builtMarketingSite}) is assembled by
 * `scripts/merge-marketing-into-web.ts` copying a build on top of whatever
 * stands there and removing nothing, so one directory can hold pages and
 * assets from several builds: only the modules a page itself names describe
 * that page's build.
 */
function buildModesOf(distributionDir: string, html: string): string[] {
  const modes: string[] = [];
  for (const relative of clientModulesIn(html)) {
    const file = path.join(distributionDir, relative);
    if (!existsSync(file)) continue;
    modes.push(...(readFileSync(file, 'utf8').match(BUILD_MODE_PATTERN) ?? []));
  }
  return [...new Set(modes)];
}

/**
 * The page whose build this cannot read, or `null` when every page says which
 * mode it was built under.
 *
 * A build this cannot read is a build this cannot vouch for, and it is the
 * case the drift check exists for: the check runs the extractor and compares
 * the tree, so an extractor that declines here writes nothing, leaves no
 * difference and passes — reporting success for the one condition in which
 * nothing was examined. It therefore raises, and the whole build is walked
 * before {@link nonProductionRefusal} answers, because a mode that reads as
 * non-production is the ordinary state of a local build and would otherwise
 * mask an unreadable page behind it.
 */
function unreadableBuildRefusal(builtModes: ReadonlyMap<string, readonly string[]>): string | null {
  for (const [servedAt, modes] of builtModes) {
    if (modes.length === 0) {
      return `${servedAt} names no client module reporting the mode it was built under`;
    }
  }
  return null;
}

/**
 * The page that was built under a mode other than production, or `null` when
 * every page was built under production.
 *
 * The committed index says what a click on the published site can name, and
 * only a production build publishes that page set and that element set: every
 * other mode publishes a draft post, and a development-mode build also mounts
 * the development-server badge, so names describing clicks no visitor can make
 * reach the file. The extractor builds nothing and indexes whichever output
 * directory is on disk, so when `growth:index` is run by hand over what a local
 * or end-to-end build left there, this is what stands between that build and
 * the tracked file.
 */
function nonProductionRefusal(builtModes: ReadonlyMap<string, readonly string[]>): string | null {
  for (const [servedAt, modes] of builtModes) {
    const other = modes.find((mode) => !createEnvUtilities({ NODE_ENV: mode }).isProduction);
    if (other !== undefined) return `${servedAt} was built under ${other}, not production`;
  }
  return null;
}

/**
 * Walk the build at `distributionDir` and write the index to `indexFile`,
 * answering the index that build yields.
 *
 * Only a page that renders the beacon is indexed, because only such a page can
 * send one; indexing the rest would admit a path no visitor could ever produce
 * and a forged body could. A build in which no page renders it is a build that
 * went wrong, and it raises rather than writing an index that would drop every
 * event the site sends.
 *
 * It is written only from a production build, and the two reasons it may not
 * be part company here. A build this cannot read raises
 * ({@link unreadableBuildRefusal}), because that is the condition the drift
 * check exists for and a zero exit would report success for it. A build that
 * merely was not built under production leaves the committed index standing
 * and says so ({@link nonProductionRefusal}): that is the ordinary state of a
 * development or end-to-end build, so raising there would fail every local run
 * over a build that is exactly as it should be. The deploy is unaffected,
 * because the bundle it extracts from is a production build.
 */
export function writeGrowthEventIndex(
  distributionDir: string,
  indexFile: string
): GrowthEventIndex {
  const window = new Window();
  const index: Record<string, readonly string[]> = {};
  const builtModes = new Map<string, readonly string[]>();
  for (const relative of builtPages(distributionDir)) {
    const html = readFileSync(path.join(distributionDir, relative), 'utf8');
    if (!html.includes(GROWTH_INIT_SCRIPT)) continue;
    const servedAt = servedPath(relative);
    index[servedAt] = namesIn(window, html);
    builtModes.set(servedAt, buildModesOf(distributionDir, html));
  }
  if (Object.keys(index).length === 0) {
    throw new Error(`no built page under ${distributionDir} renders the beacon script`);
  }
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  if (existsSync(indexFile) && readFileSync(indexFile, 'utf8') === serialized) return index;
  const unreadable = unreadableBuildRefusal(builtModes);
  if (unreadable !== null) {
    throw new Error(`cannot extract the growth event index: ${unreadable}`);
  }
  const nonProduction = nonProductionRefusal(builtModes);
  if (nonProduction !== null) {
    console.warn(`growth event index left as it stands: ${nonProduction}`);
    return index;
  }
  mkdirSync(path.dirname(indexFile), { recursive: true });
  writeFileSync(indexFile, serialized);
  return index;
}

/* v8 ignore start -- the CLI entry, run by the `growth:index` task; a test imports this module instead of executing it */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    writeGrowthEventIndex(builtMarketingSite(REPO_ROOT), path.join(REPO_ROOT, INDEX_FILE))
  );
}
/* v8 ignore stop */
