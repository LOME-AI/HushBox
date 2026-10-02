import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FOOTER_LINKS, GROWTH_BEACON_PATH, ROUTES, deriveEventName } from '@hushbox/shared';

import type { EventNameElement, GrowthEventIndex } from '@hushbox/shared';
import type { Locator, Page, Request } from '@playwright/test';

/**
 * The marketing-page locators this specification drives, and the one place its
 * raw selectors live (E2E rule 3.3).
 */

/** The label the footer gives one destination, read from the shared list the footer renders from. */
function footerLabelFor(href: string): string {
  const link = FOOTER_LINKS.find((entry) => entry.href === href);
  if (link === undefined) {
    throw new Error(`the shared footer list names no link to ${href}`);
  }
  return link.label;
}

/**
 * The link into the product — the page's call to action.
 *
 * Matched by destination rather than by its words: the destination is the
 * shared route constant, so the name this element derives (`link:` plus the
 * path) survives every rewrite of the copy on the button. That is what makes
 * it the element to read a name off in a suite whose committed name index is
 * not refreshed under the end-to-end build.
 *
 * Both spellings of the href are matched because the beacon script rewrites
 * same-origin links to carry the campaign tag, so the attribute reads
 * `/chat?c=…` from the moment the page is ready.
 */
export function productEntryLink(page: Page): Locator {
  return page
    .locator(`a[href="${ROUTES.CHAT}"], a[href^="${ROUTES.CHAT}?"]`)
    .filter({ visible: true })
    .first();
}

/** The footer's link to the privacy page — an internal navigation, on every form factor. */
export function privacyLink(page: Page): Locator {
  return page
    .getByRole('link', { name: footerLabelFor(ROUTES.PRIVACY), exact: true })
    .filter({ visible: true })
    .first();
}

/**
 * The names the committed click-name index carries for one page.
 *
 * The index is what the beacon validates every event name against, and the
 * end-to-end build does not rewrite it — the extractor writes only from a
 * production build — so this file is the tracked one, read as the running
 * Worker reads it.
 */
export function committedEventNames(page: string): readonly string[] {
  // Joined from the directory rather than resolved as a URL against this
  // module: the test runner's transform treats `new URL('….json',
  // import.meta.url)` as a module specifier and tries to import the file,
  // which fails the whole load before any test is collected.
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'apps',
    'api',
    'src',
    'slices',
    'growth',
    'domain',
    'growth-index.json'
  );
  const index = JSON.parse(readFileSync(file, 'utf8')) as GrowthEventIndex;
  return index[page] ?? [];
}

/** Whether `request` is this page's own pageview beacon for `path`. */
function isPageViewBeacon(request: Request, path: string): boolean {
  if (new URL(request.url()).pathname !== GROWTH_BEACON_PATH) return false;
  const body = request.postData();
  if (body === null) return false;
  const beacon = JSON.parse(body) as { t?: string; p?: string };
  return beacon.t === 'v' && beacon.p === path;
}

/**
 * Starts one of the two beacon waits and answers with how it settled: its
 * failure as a value, never as a rejection.
 *
 * Called once per wait inside {@link watchPageViewBeacon}'s synchronous body,
 * so both waits are armed and both are already being awaited before control
 * leaves that body. Awaiting the two in order instead would leave the second
 * unhandled for as long as the first runs, and they expire together.
 */
async function settled(start: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await start();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The sentence for a beacon that was sent and never answered, or never sent at all. */
async function beaconVerdict(
  path: string,
  budget: number,
  issued: Promise<Error | undefined>,
  answered: Promise<Error | undefined>
): Promise<Error | undefined> {
  const unanswered = await answered;
  if (unanswered === undefined) return undefined;
  const unissued = await issued;
  if (unissued === undefined) {
    return new Error(
      `the pageview beacon for ${path} was issued and nothing answered it within ${String(budget)}ms, so the count it carries cannot be shown to have landed`,
      { cause: unanswered }
    );
  }
  return new Error(
    `no pageview beacon for ${path} was issued within ${String(budget)}ms of the wait being armed, so the count it carries cannot be shown to have landed: the page sent none (its counting script absent, blocked, or not re-run by this navigation), or sent one naming a different page, or the navigation itself outlived the budget`,
    { cause: unissued }
  );
}

/**
 * Watches for this page's pageview beacon for `path` to be sent and answered
 * within `budget`, and answers with the failure to raise — or `undefined` when
 * it was both.
 *
 * IT RESOLVES, NEVER REJECTS, and that is the reason it exists as a function.
 * The watch has to be armed before the navigation that makes the page send the
 * beacon, because the answer can arrive before that navigation returns, and it
 * is read afterwards. A promise that rejected on expiry would therefore reject
 * while nothing is awaiting it whenever the navigation outlives the budget,
 * and the runner fails the test on the unhandled rejection — pointing at the
 * line the wait was created on, and losing whatever the caller meant to say.
 *
 * IT WATCHES THE REQUEST AS WELL AS THE RESPONSE because the two absences fail
 * identically and mean opposite things. A response wait that expires says only
 * that nothing matched: a page that never sent a beacon — the regression this
 * watch exists to catch — and a worker that never answered one are the same
 * silence, so a verdict naming either is a guess. The request watch tells them
 * apart, and where it cannot the sentence names the candidates instead.
 */
export function watchPageViewBeacon(
  page: Page,
  path: string,
  budget: number
): Promise<Error | undefined> {
  const issued = settled(() =>
    page.waitForRequest((request) => isPageViewBeacon(request, path), { timeout: budget })
  );
  const answered = settled(() =>
    page.waitForResponse((response) => isPageViewBeacon(response.request(), path), {
      timeout: budget,
    })
  );
  return beaconVerdict(path, budget, issued, answered);
}

/**
 * The name a click on `target` is counted under, derived by the shared
 * function from the element as the page actually renders it.
 *
 * Every attribute is read, not the four the derivation consults today: a
 * caller that pre-read a fixed set would silently answer `null` for an
 * attribute the derivation later learns to read, and a wrong name here is a
 * dropped event rather than a failure.
 *
 * An element deriving no name is raised here: a click on it could never be
 * counted, so there is no assertion to make about it further down.
 */
export async function derivedEventName(target: Locator): Promise<string> {
  const shape = await target.evaluate((element) => ({
    tagName: element.tagName,
    textContent: element.textContent,
    attributes: Object.fromEntries(
      [...element.attributes].map((attribute) => [attribute.name, attribute.value])
    ),
  }));
  const element: EventNameElement = {
    tagName: shape.tagName,
    textContent: shape.textContent,
    getAttribute: (name) => shape.attributes[name] ?? null,
  };
  const derived = deriveEventName(element);
  if (derived === null) {
    throw new Error(
      `the element <${shape.tagName.toLowerCase()}> derives no event name, so no click on it can be counted`
    );
  }
  return derived;
}

/** Everything the browser kept for an origin: entry names, and the text of what was stored. */
export interface ClientStorageFootprint {
  readonly cookies: readonly string[];
  /** Every key `localStorage` and `sessionStorage` hold, across both storages. */
  readonly storedKeys: readonly string[];
  /** Every value both storages hold, as one list of strings to search. */
  readonly storedValues: readonly string[];
  /** Absent where the engine offers no enumeration (`indexedDB.databases` is not universal). */
  readonly indexedDatabases: readonly string[] | null;
}

/** What the page has written to the device, read from the page and its context. */
export async function clientStorageFootprint(page: Page): Promise<ClientStorageFootprint> {
  const cookies = await page.context().cookies();
  const stored = await page.evaluate(async () => {
    // `indexedDB.databases` is not universal: where the engine offers no
    // enumeration the answer is "unknown", never "empty".
    const enumerable = typeof globalThis.indexedDB.databases === 'function';
    const databases = enumerable ? await globalThis.indexedDB.databases() : null;
    const storages = [globalThis.localStorage, globalThis.sessionStorage];
    return {
      keys: storages.flatMap((storage) => Object.keys(storage)),
      values: storages.flatMap((storage) =>
        Object.keys(storage).map((key) => storage.getItem(key) ?? '')
      ),
      databases: databases === null ? null : databases.map((database) => database.name ?? ''),
    };
  });
  return {
    cookies: cookies.map((cookie) => cookie.name),
    storedKeys: stored.keys,
    storedValues: stored.values,
    indexedDatabases: stored.databases,
  };
}
