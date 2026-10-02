import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchBrowser,
  openEmbeddedFrame,
  startSandboxOrigin,
  SANDBOX_ENGINES,
  type EmbeddedFrame,
  type SandboxOrigin,
} from './embed-harness.js';
import type { Browser, Page } from '@playwright/test';

/**
 * Whether the bundles this origin serves boot without the policy refusing
 * anything they do.
 *
 * The bundles carry a schema library that probes for JIT availability by
 * constructing a `Function` the first time a schema is built. The policy names
 * no `'unsafe-eval'`, so the attempt is refused; the library catches the throw
 * and validates through its interpreted path, which is why the frame still
 * renders and why no test of rendering can see this. What the refusal does
 * produce is a reported violation, and a browser console guard promotes one to
 * a failure.
 *
 * Only execution answers it. The probe's text stays in the built bundle either
 * way — it sits inside the library's own guarded accessor — so what changes is
 * whether anything reaches it, and no reading of the bundle distinguishes the
 * two. Each case therefore serves the committed bundle under the real policy
 * inside a real opaque-origin frame and reads back what the frame's own realm
 * recorded.
 */

/** The pages that carry a bootstrap, and so can trip a policy on their own. */
const FRAME_PATHS = ['/render.html', '/python.html'] as const;

/**
 * The engines that dispatch a `securitypolicyviolation` event for a refused
 * `Function` construction. WebKit refuses the construction like the others —
 * the planted case below observes the throw on every engine — but dispatches no
 * event for it, so its empty recording is silence rather than evidence. The set
 * is asserted in both directions, so an engine that starts or stops reporting
 * fails here instead of quietly turning a case vacuous.
 */
const ENGINES_REPORTING_EVAL_REFUSAL = new Set<string>(['chromium', 'firefox']);

const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';

/** What one embedded frame recorded about the policy, read from its own realm. */
interface FrameRecord {
  /** Every reported violation, flattened to `<directive> <blocked>`. */
  readonly violations: string[];
  /** Whether the planted construction was refused. False where none was planted. */
  readonly plantRefused: boolean;
}

interface RecorderGlobal {
  __violations: string[];
  __plantRefused?: boolean;
}

/**
 * The renderer's env-derived `/config.js`, which the committed `public/` tree
 * does not carry. `plantConstruction` adds a construction the policy must
 * refuse, which is what proves the recorder is live and the policy is in force
 * on the engine running the case.
 */
function configRoute(
  plantConstruction: boolean
): (pathname: string, origin: string) => { contentType: string; body: string } | undefined {
  return (pathname, origin) => {
    if (pathname !== '/config.js') return;
    const config = JSON.stringify({ esmCdnUrl: `${origin}/esm-stub` });
    const plant = plantConstruction
      ? 'try { new Function(""); } catch { globalThis["__plantRefused"] = true; }'
      : '';
    return {
      contentType: JS_CONTENT_TYPE,
      body: `globalThis['__SANDBOX_CONFIG__'] = ${config};${plant}`,
    };
  };
}

/**
 * Install the recorder in every frame before any page script runs. The frame's
 * bootstrap is what is under test, so a listener attached after navigation would
 * arrive after the event it exists to catch.
 */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: string[] = [];
    (globalThis as unknown as RecorderGlobal).__violations = recorded;
    globalThis.addEventListener('securitypolicyviolation', (event) => {
      recorded.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

let clean: SandboxOrigin;
let planted: SandboxOrigin;

beforeAll(async () => {
  clean = await startSandboxOrigin(configRoute(false));
  planted = await startSandboxOrigin(configRoute(true));
});

afterAll(async () => {
  await clean.close();
  await planted.close();
});

describe.each(SANDBOX_ENGINES)('the sandbox bundles under %s', (engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser(engine);
  }, 120_000);

  afterAll(async () => {
    await browser.close();
  });

  /** Embed one page with the recorder installed and read back what it saw. */
  async function recordFor(origin: string, framePath: string): Promise<FrameRecord> {
    const frame: EmbeddedFrame = await openEmbeddedFrame(browser, origin, {
      framePath,
      beforeLoad: recordViolations,
      readyTimeoutMs: 30_000,
    });
    try {
      return await frame.probeFrame(() => {
        const recorder = globalThis as unknown as RecorderGlobal;
        return {
          violations: recorder.__violations,
          plantRefused: recorder.__plantRefused === true,
        };
      });
    } finally {
      await frame.close();
    }
  }

  it.each(FRAME_PATHS)(
    'boots %s without the policy refusing anything',
    async (framePath) => {
      const record = await recordFor(clean.origin, framePath);
      expect(record.violations).toEqual([]);
    },
    120_000
  );

  it('refuses a construction a served script attempts', async () => {
    // The precondition every empty recording above rests on: an engine that
    // permitted the construction would record nothing for the same reason.
    const record = await recordFor(planted.origin, '/render.html');
    expect(record.plantRefused).toBe(true);
  }, 120_000);

  it('reports that refusal exactly where the engine dispatches an event', async () => {
    const record = await recordFor(planted.origin, '/render.html');
    expect(record.violations.length > 0).toBe(ENGINES_REPORTING_EVAL_REFUSAL.has(engine));
  }, 120_000);
});
