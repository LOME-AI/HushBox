import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchBrowser,
  openEmbeddedFrame,
  startSandboxOrigin,
  SANDBOX_ENGINES,
  type BridgeLike,
  type EmbeddedFrame,
  type SandboxOrigin,
} from './embed-harness.js';
import { openPythonPage } from './python/browser-harness.js';
import type { Browser } from '@playwright/test';

/**
 * Whether the policy this origin serves lets its own pages run, and contains
 * them, in every engine the renderer is delivered to.
 *
 * Measured against this harness's origin, inside the frame carrying document
 * code — sandboxed without `allow-same-origin`, so its document has an opaque
 * origin — with `'self'` naming the page's own scripts: Chromium and Firefox
 * loaded them; WebKit refused them ("Refused to load .../render.js because it
 * does not appear in the script-src directive"), so the frame never reached its
 * handshake and nothing on the page ran. Safari and iOS WKWebView are WebKit,
 * so that is a whole delivery target, not an engine curiosity.
 * `apps/sandbox/src/csp.ts` records what was measured on WebKit under that
 * token, and the rule it produced: every fetch directive names the origin these
 * pages are served from.
 *
 * Loading a page's scripts is not the whole delivery question. The Python
 * runtime fetches its interpreter, its lock file and its stdlib from this same
 * origin through `connect-src`, so a `python` document only runs where that
 * directive reaches them too — which is why one case here runs a document
 * rather than watching a page boot.
 *
 * Both questions are therefore answered by execution, not by reading the policy
 * string, whose text is the same wherever it is served. Each case embeds the
 * real page under the real served policy and reads the outcome out of the
 * frame's own realm.
 */

/** The pages that carry a bootstrap, and so can announce themselves. */
const FRAME_PATHS = ['/render.html', '/python.html'] as const;

const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';

/**
 * The renderer's env-derived `/config.js`, which the committed `public/` tree
 * does not carry. Its body decides nothing here — the page has to load it before
 * it will finish booting, and that load is exactly what is under test.
 */
function configRoute(
  pathname: string,
  origin: string
): { contentType: string; body: string } | undefined {
  if (pathname !== '/config.js') return undefined;
  const config = JSON.stringify({ esmCdnUrl: `${origin}/esm-stub` });
  return { contentType: JS_CONTENT_TYPE, body: `globalThis['__SANDBOX_CONFIG__'] = ${config};` };
}

/** What the Python document under test prints, so the assertion cannot be vacuous. */
const PYTHON_DOCUMENT_OUTPUT = 'the interpreter reached this origin';

/** Everything the frame reported on stdout, in order. */
function stdoutOf(messages: readonly BridgeLike[]): string {
  return messages
    .filter((message) => message.type === 'console' && message.stream === 'stdout')
    .map((message) => message.text ?? '')
    .join('');
}

let sandbox: SandboxOrigin;

beforeAll(async () => {
  sandbox = await startSandboxOrigin(configRoute);
});

afterAll(async () => {
  await sandbox.close();
});

describe.each(SANDBOX_ENGINES)('the sandbox origin under %s', (engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser(engine);
  }, 120_000);

  afterAll(async () => {
    await browser.close();
  });

  /** Embed one page and hand it to `body`, closing the frame afterwards. */
  async function withFrame(
    framePath: string,
    body: (frame: EmbeddedFrame) => Promise<void>
  ): Promise<void> {
    const frame = await openEmbeddedFrame(browser, sandbox.origin, {
      framePath,
      readyTimeoutMs: 30_000,
    });
    try {
      await body(frame);
    } finally {
      await frame.close();
    }
  }

  it.each(FRAME_PATHS)(
    'lets %s load its own scripts inside a frame with an opaque origin',
    async (framePath) => {
      await withFrame(framePath, async (frame) => {
        // The precondition the whole case rests on: the frame must carry an
        // opaque origin. A harness change that gave it a real one would leave
        // this case asserting nothing.
        expect(await frame.probeFrame(() => globalThis.origin)).toBe('null');
        // The handshake is the proof. The frame mints its channel and transfers
        // a port from its bootstrap, so a port on the embedder means the page's
        // own scripts were fetched, parsed and executed.
        expect(await frame.hasPort()).toBe(true);
      });
    },
    120_000
  );

  it('runs a python document, whose runtime fetches its assets from this origin', async () => {
    // Loading `/python.html`'s own scripts is not enough to run Python: the
    // interpreter, its lock file and its stdlib are fetched from this origin,
    // and a fetch is governed by `connect-src` rather than `script-src`. Only a
    // document that reaches a result proves that directive reaches them.
    const python = await openPythonPage(browser, sandbox.origin);
    try {
      // The precondition the case rests on, as in the script-load cases: the
      // frame must carry an opaque origin, or this case asserts nothing.
      expect(await python.probe(() => globalThis.origin)).toBe('null');
      const collected = await python.run(`print("${PYTHON_DOCUMENT_OUTPUT}")`, 'csp-python');
      expect(collected.filter((message) => message.type === 'error')).toEqual([]);
      expect(stdoutOf(collected)).toContain(PYTHON_DOCUMENT_OUTPUT);
    } finally {
      await python.close();
    }
  }, 240_000);

  it('still refuses an egress the policy does not name', async () => {
    await withFrame('/render.html', async (frame) => {
      // The one server answers on two origins — it binds loopback while the
      // pages are served over `localhost` — so the twin address is a host that
      // is provably up, CORS-permissive, and absent from `connect-src`. A
      // widening that reached it would be a live fetch, not a DNS failure
      // dressed as a block.
      //
      // The served origin is fetched alongside it as the control. Without one
      // this case is vacuous wherever a fetch is refused for any reason other
      // than the policy: the block it observes would not be the policy's, and a
      // `connect-src` widened to a wildcard would still pass.
      const reached = await frame.probeFrame(async () => {
        const tryFetch = async (url: string): Promise<boolean> => {
          try {
            await fetch(url);
            return true;
          } catch {
            return false;
          }
        };
        const own = globalThis.location.origin;
        return {
          own: await tryFetch(`${own}/render.html`),
          twin: await tryFetch(`${own.replace('localhost', '127.0.0.1')}/render.html`),
        };
      });
      expect(reached).toEqual({ own: true, twin: false });
    });
  }, 120_000);

  it('still hands the document a realm with no WebRTC constructors', async () => {
    await withFrame('/render.html', async (frame) => {
      // The egress channel `connect-src` cannot govern. The bootstrap deletes
      // these before document code runs, and `frame-src`/`worker-src`/
      // `object-src 'none'` deny the fresh realm that would restore them.
      const present = await frame.probeFrame(() =>
        ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'].filter(
          (name) => (globalThis as unknown as Record<string, unknown>)[name] !== undefined
        )
      );
      expect(present).toEqual([]);
    });
  }, 120_000);
});
