import { rmSync } from 'node:fs';
import { mkdtemp, statfs } from 'node:fs/promises';
import path from 'node:path';

import { bundle } from '@remotion/bundler';
import { openBrowser } from '@remotion/renderer';

import { browserTemporaryParent, browserTemporaryRefusal } from './browser-temporary-files.js';
import { thenCleanUp } from './cleanup.js';
import { FilmRenderError } from './film-error.js';
import { FILMS_ROOT, PUBLIC_DIR } from './films.driver.js';
import { pieceWebpackOverride } from './webpack-override.js';

import type { HeadlessBrowser, OpenGlRenderer } from '@remotion/renderer';
import type { DiscoveredFilm } from '../film/discover.js';

/** The variable `os.tmpdir()` and a spawned Chrome read their temporary directory from. */
const TEMP_VARIABLE = 'TMPDIR';

/** How long closing a render's pages may take in all before the browser is closed regardless. */
const PAGE_CLOSE_SECONDS = 10;

/** What a browser emits once it has closed: Remotion closes one silently when it replaces it. */
const BROWSER_CLOSED_EVENTS = ['closed', 'closed-silent'] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bundles the engine and the one film or take `film` names, so a piece
 * mid-edit elsewhere under the package never fails its render; runs `use` on
 * the bundle, and removes the bundle once `use` settles, whether it resolved
 * or threw, and also when bundling itself fails: every bundle is written to
 * the OS temporary directory, and nothing else reclaims it.
 */
export async function withFilmBundle<T>(
  film: DiscoveredFilm,
  use: (serveUrl: string) => Promise<T>
): Promise<T> {
  const filmId = film.id;
  const created: string[] = [];
  return thenCleanUp(
    async () => {
      let serveUrl: string;
      try {
        const pieceDir = path.relative(FILMS_ROOT, film.dir).split(path.sep).join('/');
        serveUrl = await bundle({
          entryPoint: path.join(FILMS_ROOT, 'src', 'index.ts'),
          rootDir: FILMS_ROOT,
          publicDir: PUBLIC_DIR,
          webpackOverride: pieceWebpackOverride(pieceDir),
          symlinkPublicDir: true,
          onDirectoryCreated: (directory) => {
            created.push(directory);
          },
        });
      } catch (error) {
        throw new FilmRenderError(
          { filmId, rule: 'bundle', detail: `the package did not bundle: ${messageOf(error)}` },
          { cause: error }
        );
      }
      return use(serveUrl);
    },
    async () => {
      // The public directory is linked into the bundle, never copied: removing
      // the bundle unlinks it and leaves its files in place.
      await cleanedUp(filmId, 'the bundle was not removed', () => {
        for (const directory of created) {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  );
}

/** Runs one cleanup step, failing as a `FilmRenderError` naming the film and the step. */
async function cleanedUp(
  filmId: string,
  what: string,
  step: () => Promise<void> | void
): Promise<void> {
  try {
    await step();
  } catch (error) {
    throw new FilmRenderError(
      { filmId, rule: 'cleanup', detail: `${what}: ${messageOf(error)}` },
      { cause: error }
    );
  }
}

/**
 * Closes one page. A page already gone is the state wanted: a render the stall
 * watchdog cancelled has asked Remotion to close its page, and that request can
 * land first.
 */
async function closePage(
  page: Awaited<ReturnType<HeadlessBrowser['pages']>>[number]
): Promise<void> {
  try {
    await page.close();
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('No target found'))) throw error;
  }
}

/** Resolves, never rejects, once `seconds` have passed. */
async function deadline(seconds: number): Promise<'deadline'> {
  return new Promise((resolve) => {
    AbortSignal.timeout(seconds * 1000).addEventListener(
      'abort',
      () => {
        resolve('deadline');
      },
      { once: true }
    );
  });
}

/**
 * Closes every page, then the browser. Remotion closes a page it cancelled
 * without awaiting the close; closing the browser under that request would
 * reject it with nothing to catch it, so the pages close first and the request
 * settles. A stopped browser answers nothing, so the pages get
 * `PAGE_CLOSE_SECONDS` in all, and the browser, whose close kills its process
 * group, closes whatever they did. Page closes still pending past the deadline
 * end when the browser dies, and their failure then says nothing more.
 */
async function closeBrowser(browser: HeadlessBrowser): Promise<void> {
  const pagesClosed = (async (): Promise<void> => {
    const pages = await browser.pages();
    await Promise.all(pages.map(async (page) => closePage(page)));
  })();
  const closing = await Promise.race([
    pagesClosed.then(
      () => 'closed' as const,
      (error: unknown) => ({ error })
    ),
    deadline(PAGE_CLOSE_SECONDS),
  ]);
  await browser.close({ silent: true });
  if (typeof closing === 'object') throw closing.error;
}

/**
 * A private directory for one browser's temporary files, on the RAM filesystem
 * on Linux, refused by name when that filesystem is not tmpfs or too small;
 * nothing elsewhere, where the browser keeps the OS temporary directory.
 */
async function browserTemporaryDir(filmId: string): Promise<string | undefined> {
  const parent = browserTemporaryParent(process.platform);
  if (parent === undefined) return undefined;
  try {
    const refusal = browserTemporaryRefusal(filmId, parent, await statfs(parent));
    if (refusal !== undefined) throw refusal;
    return await mkdtemp(path.join(parent, 'hushbox-films-browser-'));
  } catch (error) {
    if (error instanceof FilmRenderError) throw error;
    throw new FilmRenderError(
      { filmId, rule: 'browser-temporary-files', detail: `${parent}: ${messageOf(error)}` },
      { cause: error }
    );
  }
}

/**
 * Points `TMPDIR` at `directory` until the returned function restores it. A
 * browser reads it when it spawns: Remotion makes its profile there, and
 * Chrome, launched with `--disable-dev-shm-usage`, backs its shared memory
 * there. It holds for a whole render, because Remotion replaces a browser that
 * crashes mid-render with one it spawns itself.
 */
function pointTemporaryDirectory(directory: string | undefined): () => void {
  if (directory === undefined) return () => undefined;
  const previous = process.env[TEMP_VARIABLE];
  process.env[TEMP_VARIABLE] = directory;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, TEMP_VARIABLE);
    else process.env[TEMP_VARIABLE] = previous;
  };
}

/**
 * Removes the browser's private directory. While a browser Remotion spawned to
 * replace a crashed one may still run in it, removal waits for the process to
 * exit, after Remotion's own exit hook has killed that browser.
 */
function removeTemporaryDirectory(directory: string | undefined, replaced: boolean): void {
  if (directory === undefined) return;
  const remove = (): void => {
    rmSync(directory, { recursive: true, force: true });
  };
  if (replaced) process.once('exit', remove);
  else remove();
}

/**
 * Opens the one kind of browser every film render uses, runs `use` on it, and
 * closes it once `use` settles, whether it resolved or threw, removing its
 * private temporary directory. A failure to close never replaces a failure of
 * `use`; it rides on it as its cause.
 */
export async function withFilmBrowser<T>(
  filmId: string,
  gl: OpenGlRenderer,
  use: (browser: HeadlessBrowser) => Promise<T>
): Promise<T> {
  const directory = await browserTemporaryDir(filmId);
  const restore = pointTemporaryDirectory(directory);
  let browser: HeadlessBrowser;
  try {
    browser = await openBrowser('chrome', { chromiumOptions: { gl }, logLevel: 'warn' });
  } catch (error) {
    restore();
    removeTemporaryDirectory(directory, false);
    throw new FilmRenderError(
      { filmId, rule: 'browser', detail: `the browser did not open: ${messageOf(error)}` },
      { cause: error }
    );
  }
  const state = { closedDuringUse: false };
  const onClosed = (): void => {
    state.closedDuringUse = true;
  };
  for (const event of BROWSER_CLOSED_EVENTS) browser.on(event, onClosed);
  return thenCleanUp(
    async () => use(browser),
    async () => {
      for (const event of BROWSER_CLOSED_EVENTS) browser.off(event, onClosed);
      try {
        if (!state.closedDuringUse) {
          await cleanedUp(filmId, 'the browser did not close', async () => closeBrowser(browser));
        }
      } finally {
        restore();
        removeTemporaryDirectory(directory, state.closedDuringUse);
      }
    }
  );
}
