import {
  MODEL_WEIGHTS_VERSION,
  TTS_MODEL_ID,
  modelWeightsRoutePath,
} from '@hushbox/shared/model-weights';

import { test } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import { TIMEOUTS } from './config/timeouts.js';
import { requireEnv } from './helpers/env.js';
import { expect } from './helpers/expect.js';
import { openMobileLandingMenuIfNeeded } from './helpers/marketing-nav.js';
import {
  waitForRoadmapReady,
  roadmapSections,
  roadmapSectionsByStatus,
  waitForBlogSpeaking,
} from './helpers/page-signals.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The defect class this run exists to guard against — a bundler miscompiling
 * the on-device TTS runtime — is identical on every engine: it lives in the
 * worker bundle's compiled output, not in engine-specific rendering. Running
 * it once, rather than per engine, is what keeps the ~92 MB model fetch to
 * one download per run instead of one per project.
 */
const SPEAKING_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'The defect class is bundler-compiled worker output, identical on every engine, and the ~92 MB model fetch is the cost driver — narrowing to one project keeps that cost to once per run.',
});

/**
 * End-to-end coverage of the public /roadmap page. The page is built by
 * Astro, merged on top of the web app's dist by
 * `scripts/merge-marketing-into-web.ts`, then served by `vite preview` —
 * the same merged layout Cloudflare Pages serves in production. The
 * roadmap's React island fetches `/api/public/roadmap`, which in E2E mode
 * uses the Linear mock client, so the response is deterministic.
 */

test.describe('Public roadmap', SPEC_MATRIX, () => {
  test('renders, filters, and is reachable from landing nav', async ({ page }) => {
    await page.goto('/welcome');
    await openMobileLandingMenuIfNeeded(page);
    // `.filter({ visible: true })` picks whichever of the two nav variants
    // (desktop nav or the now-open mobile drawer) is currently rendered;
    // the other lives in DOM but with `display: none` via Tailwind.
    await page.getByRole('link', { name: 'Roadmap' }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/roadmap/);

    await expect(page.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
    await waitForRoadmapReady(page);
    const columns = roadmapSections(page);
    await expect(columns).toHaveCount(3);
    const expectedColumns: readonly (readonly [status: string, name: string])[] = [
      ['in_progress', 'Now'],
      ['planned', 'Next'],
      ['shipped', 'Shipped'],
    ];
    for (const [index, [status, name]] of expectedColumns.entries()) {
      await expect(columns.nth(index)).toHaveAttribute('data-status', status);
      await expect(
        roadmapSectionsByStatus(page, status).getByRole('heading', { level: 2, name })
      ).toBeVisible();
    }

    const typeFilter = page.getByRole('group', { name: 'Type' });
    for (const name of [/^All/, /^Features/, /^Bugs/]) {
      await expect(typeFilter.getByRole('button', { name })).toBeVisible();
    }

    await typeFilter.getByRole('button', { name: /^Bugs/ }).click();
    await expect(typeFilter.getByRole('button', { name: /^Bugs/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBe('bug');
    await expect(page.getByText(/hidden by filter/i).first()).toBeVisible();

    await page.goto('/roadmap?type=feature');
    await waitForRoadmapReady(page);
    await expect(
      page.getByRole('group', { name: 'Type' }).getByRole('button', { name: /^Features/ })
    ).toHaveAttribute('aria-pressed', 'true');

    await page.goto('/roadmap?status=shipped');
    await waitForRoadmapReady(page);
    await expect(roadmapSections(page)).toHaveCount(3);
  });
});

/**
 * Where every on-device model object is served from: the API's own
 * model-weights route, addressed through the shared artifact contract so this
 * spec cannot name an address the app does not use.
 */
const MODEL_BASE_URL = new URL(
  modelWeightsRoutePath(TTS_MODEL_ID, MODEL_WEIGHTS_VERSION, ''),
  requireEnv('VITE_API_URL')
).href;

/** Everything under that base, for intercepting the objects a real load fetches. */
const MODEL_URL_GLOB = `${MODEL_BASE_URL}**`;

/** One object address under it, used as the probe the policy must allow. */
const ALLOWED_PROBE_URL = `${MODEL_BASE_URL}probe`;

/**
 * The Hugging Face hub. kokoro-js hardcodes the hub URL of every voice file in
 * its compiled dist, and a vendored patch is what redirects it at our origin; a
 * kokoro-js version bump that stops the patch applying silently restores the
 * hub URL. The hub is therefore the one foreign host whose refusal is worth
 * asserting, and it is spelled out here because nothing in the app names it any
 * more.
 */
const HUB_ORIGIN = 'https://huggingface.co';
const BLOCKED_PROBE_URL = `${HUB_ORIGIN}/probe`;

/**
 * Guards the Content-Security-Policy the on-device TTS model download runs
 * under, in both directions. The engine (chat read-aloud and the blog "Listen"
 * control) fetches every model file from the API origin; the app's own origin
 * carries that already, so the allow half proves the objects are reachable
 * where the loader looks for them. The refuse half is the browser-level
 * detector for a lapsed kokoro-js patch: unpatched, the voice fetch reverts to
 * the hub, the policy refuses it, and read-aloud goes permanently silent with
 * no error anywhere. `vite preview` serves the real generated `_headers` CSP
 * (via `scripts/lib/bundling/headers-vite-plugin.ts`), so this asserts genuine
 * browser enforcement rather than a string in a file.
 *
 * The outcome is read only from channels identical across engines — the
 * requests Playwright sees leaving the page, and the probes' own report that
 * they ran. The engine's account of a refusal (its console prose, a violation
 * report's `blockedURI` form, the rejected promise's error class) is never
 * read: each is one engine's way of describing the block, so a case keyed to
 * one tests that engine rather than the policy.
 *
 * The request channel is the only thing that catches an escape on an
 * uninstrumented page. The suite's per-page guardrails are installed by
 * `instrumentPage` in `e2e/fixtures.ts`, which the built-in `page` fixture
 * does not run, so an uninstrumented page has its console output captured
 * nowhere and no network allowlist aborting its egress, and a console-error
 * opt-out declared on one would suppress a check that never runs.
 */
test.describe('TTS model-download CSP', SPEC_MATRIX, () => {
  test('refuses the Hugging Face hub while allowing the self-hosted model origin', async ({
    page,
  }) => {
    // Every request that leaves the page. This is the containment outcome
    // itself: a connect the CSP refuses is stopped before the network stack, so
    // it reaches this channel only if the policy stopped refusing it, on every
    // engine. Both directions are read from this one channel, so the negative
    // below cannot be vacuous for a reason the positive does not share. Full
    // URLs rather than hosts: the allowed origin is the API, which this page
    // talks to anyway, so only the probe's own path distinguishes it.
    const requestedUrls: string[] = [];
    page.on('request', (request) => {
      requestedUrls.push(request.url());
    });

    // Both probes are fulfilled locally so neither depends on a remote host
    // being reachable — including the refused one, which would otherwise leave
    // for the real hub on the day this assertion starts failing.
    await page.route(MODEL_URL_GLOB, (route) => route.fulfill({ status: 204, body: '' }));
    await page.route(`${HUB_ORIGIN}/**`, (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto('/welcome');

    // Each probe announces itself before it tries and again once it has
    // settled; without this fence the two assertions below would pass on a page
    // that issued no fetch at all. The browser context cannot close over a
    // Node-side binding, so both URLs cross into the page as arguments.
    const attempted = await page.evaluate(
      async ({ blockedUrl, allowedUrl }) => {
        const tried = ['blocked'];
        await fetch(blockedUrl, { mode: 'no-cors' }).catch(() => null);
        tried.push('allowed');
        await fetch(allowedUrl, { mode: 'no-cors' }).catch(() => null);
        tried.push('settled');
        return tried;
      },
      { blockedUrl: BLOCKED_PROBE_URL, allowedUrl: ALLOWED_PROBE_URL }
    );
    expect(attempted).toEqual(['blocked', 'allowed', 'settled']);

    // The model origin was reached — the policy's allow half, and the proof
    // that a probe this page issues is observable on this channel at all.
    await expect.poll(() => requestedUrls).toContain(ALLOWED_PROBE_URL);

    // The hub was not. Read last: the blocked probe is issued BEFORE the
    // permitted one, so an escape would already be recorded by the time the
    // poll above settles.
    expect(requestedUrls).not.toContain(BLOCKED_PROBE_URL);
  });
});

/**
 * The cheap half of blog read-aloud coverage: clicks the real "Listen"
 * control and runs the BUILT text-to-speech worker, without paying for a
 * model download. Unit tests inject a fake worker factory, so the real
 * worker bundle never executes under them — which is how
 * a bundler transform that rewrote `new.target` shipped: it killed the worker
 * the moment its module evaluated, before a single model byte arrived, and
 * surfaced only as an error line about half a second after the click. Nothing
 * caught it because nothing had ever clicked. Only the built site can catch it
 * either: the dev server hands the worker over as a native ES module and never
 * applies the transform.
 *
 * The proof is a positive signal rather than an elapsed one. The worker's first
 * model-file request can only be issued after the worker was constructed, its
 * whole module graph (kokoro-js and the ONNX runtime) evaluated, and its
 * message handler took delivery of the load — a worker that dies on load never
 * reaches it. That request is then held open, so the ~90 MB model never
 * downloads and the load stays in the one state under test: still running, not
 * failed. Playback is deliberately out of scope here — this case runs on
 * every engine and would pay for the model download on each of them — and is
 * covered instead by the case below, which runs once.
 */
test.describe('Blog Listen control', SPEC_MATRIX, () => {
  test('starts an on-device read from the built worker', async ({ page }) => {
    // Hold the model request open — never fulfilled, never aborted. Aborting
    // would fail the load and produce exactly the error this test asserts the
    // absence of; fulfilling it would need the model. A held request reaches no
    // network, so this also keeps the test offline.
    let modelRequested = false;
    await page.route(MODEL_URL_GLOB, () => {
      modelRequested = true;
    });

    await page.goto('/blog');
    // Each post card is a link wrapping the post's title heading; which post is
    // read aloud does not matter, so the first one keeps this off any slug.
    const firstPost = page
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { level: 3 }) })
      .first();
    await firstPost.click();

    // The island renders its controls disabled in the server markup and enables
    // them on hydration, so "enabled" is the readiness signal to wait on. A
    // click before that lands on markup with no handler attached and does
    // nothing, which would read here as a dead worker.
    const listen = page.getByRole('button', { name: 'Listen to this post' });
    await expect(listen).toBeEnabled();
    await listen.click();

    // Left idle: the transport is one button, relabelled per state.
    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();

    await expect.poll(() => modelRequested, { timeout: TIMEOUTS.TTS_WORKER_BOOT }).toBe(true);

    // ...and no error status arrived on the way there. The load is now parked
    // on the held request, so nothing further can fail it.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(stop).toBeVisible();

    // End the read through the UI instead of leaving it to context teardown, so
    // the control is shown to recover rather than merely to start.
    await stop.click();
    await expect(listen).toBeVisible();
  });
});

/**
 * The behavioural half: lets the download and synthesis actually run, so it
 * exercises the real weights fetch against the built bundle's own live CSP
 * rather than assuming the policy admits it, and runs the real
 * bundler-compiled worker all the way to sound. `data-blog-speaking` only
 * goes true once audio has actually been scheduled on the AudioContext — not
 * merely that the download finished or the reader entered its `speaking`
 * phase, both of which precede any audio — so a load that silently produces
 * no sound and no error cannot pass here.
 *
 * Takes the suite's guarded `unauthenticatedPage` rather than the bare `page`
 * the two tests above use: this case lets a real fetch reach a real host, so
 * the network allowlist is a genuine assertion here (a lapsed kokoro-js hub
 * patch, or any future escape, aborts and fails the test) rather than
 * overhead avoided on purpose, and console-error capture catches a silent
 * failure mode this file cannot express any other way — a worker exception
 * with no `role="alert"` render.
 */
test.describe('Blog Listen control speaks', SPEAKING_MATRIX, () => {
  test('completes a real on-device read and produces audio', async ({ unauthenticatedPage }) => {
    // The config-wide per-test timeout (`TIMEOUTS.LONG`, 60s) is shorter than
    // the download+synthesis budget this case needs. Raise it past
    // `TIMEOUTS.TTS_SPEAK` itself, not to it: that budget alone covers the
    // signal wait below, so setting the outer ceiling to the same value
    // leaves no room for the navigation and stop/verify steps around it.
    test.setTimeout(TIMEOUTS.XXLONG);

    // Every request this page makes to the model-weights route, so the real
    // fetch crossing the wire is proven rather than inferred from the signal
    // that follows it.
    const modelRequests: string[] = [];
    unauthenticatedPage.on('request', (request) => {
      if (request.url().startsWith(MODEL_BASE_URL)) modelRequests.push(request.url());
    });

    await unauthenticatedPage.goto('/blog');
    const firstPost = unauthenticatedPage
      .getByRole('link')
      .filter({ has: unauthenticatedPage.getByRole('heading', { level: 3 }) })
      .first();
    await firstPost.click();

    const listen = unauthenticatedPage.getByRole('button', { name: 'Listen to this post' });
    await expect(listen).toBeEnabled();
    await listen.click();

    const stop = unauthenticatedPage.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();

    await waitForBlogSpeaking(unauthenticatedPage, TIMEOUTS.TTS_SPEAK);

    expect(modelRequests.length).toBeGreaterThan(0);
    await expect(unauthenticatedPage.getByRole('alert')).toHaveCount(0);

    // End the read through the UI instead of leaving it to context teardown,
    // matching the control test above — but the transport button relabels per
    // state, and "Stop" is not among the labels the speaking state can show:
    // it reads "Pause" there and only reads "Stop" while loading, before any
    // audio has started. The one control this state actually offers is
    // Pause, so that is what a user (and this test) reaches for; a click on
    // it over the equivalent Escape key path keeps this in step with the
    // click-based pattern the loading-state test above already uses.
    const pause = unauthenticatedPage.getByRole('button', { name: 'Pause' });
    await expect(pause).toBeVisible();
    await pause.click();
    await expect(unauthenticatedPage.getByRole('button', { name: 'Resume' })).toBeVisible();
  });
});
