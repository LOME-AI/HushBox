import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { envConfig, Mode, resolveRaw } from '@hushbox/shared/env.config';
import { resolveSandboxOrigin } from '@hushbox/shared/sandbox-origin';
import {
  PYTHON_PAGE_PATH,
  SANDBOX_SCRIPT_SOURCES,
  cspDirectiveTokens,
  sandboxCspFor,
} from './csp.js';

/**
 * The sandbox origin's `public/_headers` carries the Content-Security-Policy
 * that IS the containment model for untrusted document code: document code can
 * load ES modules and Python wheels, and reach nothing else on the network.
 * These tests pin that posture against the committed static file, so a future
 * edit that widens the allowlist fails loudly.
 *
 * The policy is split per entry point — the wheel hosts only the Python runtime
 * installs from are on the Python page's block alone — so every shared directive
 * is asserted against both blocks and the two connect-src lists are asserted
 * apart.
 */

const HEADERS_FILE = path.join(import.meta.dirname, '..', 'public', '_headers');

/** The path pattern of the block every request falls back to. */
const DEFAULT_BLOCK = '/*';

/** A path that falls under {@link DEFAULT_BLOCK} — the document renderer's own. */
const RENDERER_PAGE_PATH = '/render.html';

/**
 * The origin production serves these pages from, read from the env registry
 * rather than restated here: the shipped `_headers` names that host inside
 * `script-src` and the web app points its renderer iframe at the same entry, so
 * a second spelling in this package would let the shipped policy and the
 * deployed origin drift apart with nothing to catch them. The read lives in this
 * test file because the registry door is node-only — a module under `src/` that
 * named it would put every backend variable name and dev-mode placeholder value
 * one import away from the bundle this credential-free origin serves.
 */
function productionSandboxOrigin(): string {
  const raw = resolveRaw(envConfig.SANDBOX_ORIGIN_URL, Mode.Production);
  if (typeof raw !== 'string') {
    throw new TypeError(
      'SANDBOX_ORIGIN_URL resolves to no production host, so the shipped policy can name no origin.'
    );
  }
  return resolveSandboxOrigin(raw);
}

/** Every block's header lines, keyed by the path pattern that opens the block. */
function readBlocks(): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const raw of readFileSync(HEADERS_FILE, 'utf8').split('\n')) {
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      if (current === undefined) throw new Error(`header line before any block: ${raw}`);
      current.push(raw.trim());
      continue;
    }
    current = [];
    blocks.set(raw.trim(), current);
  }
  return blocks;
}

/** The `Content-Security-Policy` value the named block sets. */
function readCsp(pattern: string): string {
  const block = readBlocks().get(pattern);
  if (block === undefined) throw new Error(`no ${pattern} block in _headers`);
  const line = block.find((l) => l.startsWith('Content-Security-Policy:'));
  if (line === undefined) throw new Error(`no Content-Security-Policy in the ${pattern} block`);
  return line.slice('Content-Security-Policy:'.length).trim();
}

describe('cspDirectiveTokens', () => {
  it('reads a directive down to its sources', () => {
    expect(
      cspDirectiveTokens("default-src 'none'; connect-src 'self' https://x", 'connect-src')
    ).toEqual(["'self'", 'https://x']);
  });

  it('refuses a directive the policy does not carry', () => {
    // Every assertion below reads a directive out of a policy string. A reader
    // that answered "absent" with an empty list would turn a dropped directive
    // into a passing `not.toContain`, which is the failure this corpus exists to
    // catch.
    expect(() => cspDirectiveTokens("default-src 'none'", 'connect-src')).toThrow(
      /no connect-src directive/
    );
  });
});

describe('sandbox _headers blocks', () => {
  it('serves exactly two policies — the default one and the Python runtime one', () => {
    expect([...readBlocks().keys()]).toEqual([DEFAULT_BLOCK, PYTHON_PAGE_PATH]);
  });

  it('gives the two entry points genuinely different policies', () => {
    // Guards the reader itself: a first-match extractor would return the same
    // string twice here and every per-block assertion below would be vacuous.
    expect(readCsp(DEFAULT_BLOCK)).not.toBe(readCsp(PYTHON_PAGE_PATH));
  });

  it('detaches the inherited policy on the Python block so the two are not intersected', () => {
    // Cloudflare's assets runtime applies the headers of EVERY matching rule and
    // joins two same-named headers with a comma, which the CSP parser reads as
    // two policies enforced together — a request is allowed only if both allow
    // it. Without this detach the Python page would carry the default block's
    // wheel-host-free connect-src alongside its own, and micropip's installs
    // would be refused in production while every test here still passed.
    const block = readBlocks().get(PYTHON_PAGE_PATH);
    expect(block).toContain('! Content-Security-Policy');
  });
});

describe('sandbox _headers connect-src', () => {
  it('lets the default policy reach nothing but this origin — the renderer installs no wheels', () => {
    // The origin is the whole source list: it is spelled out rather than left to
    // `'self'`, and the token does not stand beside it either.
    // `apps/sandbox/src/csp.ts` records the measurements behind that.
    expect(cspDirectiveTokens(readCsp(DEFAULT_BLOCK), 'connect-src')).toEqual([
      productionSandboxOrigin(),
    ]);
  });

  it('restricts the Python policy to this origin plus only the PyPI wheel hosts micropip needs', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const tokens = cspDirectiveTokens(readCsp(PYTHON_PAGE_PATH), 'connect-src');
    expect(tokens.toSorted(byName)).toEqual(
      [productionSandboxOrigin(), 'https://files.pythonhosted.org', 'https://pypi.org'].toSorted(
        byName
      )
    );
  });
});

describe.each([DEFAULT_BLOCK, PYTHON_PAGE_PATH])('sandbox _headers CSP (%s)', (pattern) => {
  it('does not allow any other fetch/XHR/WS destination (no wildcard, no module CDN)', () => {
    const tokens = cspDirectiveTokens(readCsp(pattern), 'connect-src');
    expect(tokens).not.toContain('*');
    // The module CDN is a script-src source, never a fetch target — putting it
    // in connect-src would open an exfiltration channel.
    expect(tokens).not.toContain('https://esm.sh');
  });

  it('keeps webrtc block (a hint for engines that honor it; the bootstrap is the real block)', () => {
    expect(cspDirectiveTokens(readCsp(pattern), 'webrtc')).toEqual(["'block'"]);
  });

  it("denies a fresh realm — frame-src, child-src, and object-src are all 'none'", () => {
    // A child frame/worker/object would be a new realm carrying the WebRTC
    // constructors the bootstrap deletes; 'none' here removes that recovery path.
    expect(cspDirectiveTokens(readCsp(pattern), 'frame-src')).toEqual(["'none'"]);
    expect(cspDirectiveTokens(readCsp(pattern), 'child-src')).toEqual(["'none'"]);
    expect(cspDirectiveTokens(readCsp(pattern), 'object-src')).toEqual(["'none'"]);
  });

  it('allows module loading from this origin, the module CDN, blob output, and WASM in script-src', () => {
    const tokens = cspDirectiveTokens(readCsp(pattern), 'script-src');
    expect(tokens).toContain(productionSandboxOrigin());
    expect(tokens).toContain('https://esm.sh');
    expect(tokens).toContain('blob:');
    expect(tokens).toContain("'wasm-unsafe-eval'");
  });

  it("allows the document's own inline scripts ('unsafe-inline' in script-src)", () => {
    // The sandbox runs untrusted document code, whose html kind IS inline
    // <script>, classic or module; a static CSP cannot nonce it. Containment is the network lockdown, not
    // script-src, so permitting inline execution grants no capability.
    const tokens = cspDirectiveTokens(readCsp(pattern), 'script-src');
    expect(tokens).toContain("'unsafe-inline'");
  });

  it("keeps worker-src at 'none' — the runtime spawns no worker", () => {
    expect(cspDirectiveTokens(readCsp(pattern), 'worker-src')).toEqual(["'none'"]);
  });

  it('limits frame-ancestors to the web origin and the production mobile app-shell origins', () => {
    expect(cspDirectiveTokens(readCsp(pattern), 'frame-ancestors')).toEqual([
      // Desktop web app origin.
      'https://hushbox.ai',
      // iOS Capacitor WebView shell.
      'capacitor://native.hushbox.ai',
      // Android Capacitor WebView shell.
      'https://native.hushbox.ai',
    ]);
  });

  it('does not allow arbitrary embedders (no wildcard frame-ancestors)', () => {
    const tokens = cspDirectiveTokens(readCsp(pattern), 'frame-ancestors');
    expect(tokens).not.toContain('*');
    expect(tokens).not.toContain('https:');
  });

  it("denies anything not enumerated (default-src 'none' is the floor)", () => {
    expect(cspDirectiveTokens(readCsp(pattern), 'default-src')).toEqual(["'none'"]);
  });
});

/**
 * The directives the served origin is named in: the fetch directives whose
 * reach has to include this origin's own assets. `apps/sandbox/src/csp.ts`
 * records the measurements behind naming it explicitly. Every other directive
 * denies outright or names only hosts other than this one, so none of them has
 * this origin to name.
 */
const ORIGIN_NAMING_DIRECTIVES = new Set([
  'script-src',
  'connect-src',
  'img-src',
  'style-src',
  'font-src',
]);

describe('sandboxCspFor', () => {
  const ORIGIN = 'https://sandbox.example';

  it('names the origin it is served from in script-src', () => {
    // `script-src` names the served origin explicitly; that is the source the
    // frame that runs document code loads this origin's own scripts from.
    // `apps/sandbox/src/csp.ts` records the measurements behind naming it.
    const tokens = cspDirectiveTokens(
      sandboxCspFor(RENDERER_PAGE_PATH, ORIGIN, true),
      'script-src'
    );
    expect(tokens).toContain(ORIGIN);
  });

  it('names the origin on the Python page too, keeping its two wheel hosts', () => {
    const csp = sandboxCspFor(PYTHON_PAGE_PATH, ORIGIN, true);
    expect(cspDirectiveTokens(csp, 'script-src')).toContain(ORIGIN);
    expect(cspDirectiveTokens(csp, 'connect-src')).toEqual([
      'https://pypi.org',
      'https://files.pythonhosted.org',
      ORIGIN,
    ]);
  });

  it('names the origin in connect-src, without which the Python runtime cannot load', () => {
    // The interpreter, its lock file and its stdlib are self-hosted here and
    // fetched, so `connect-src` decides whether a python document runs at all.
    expect(
      cspDirectiveTokens(sandboxCspFor(RENDERER_PAGE_PATH, ORIGIN, true), 'connect-src')
    ).toEqual([ORIGIN]);
  });

  it.each([RENDERER_PAGE_PATH, PYTHON_PAGE_PATH])(
    'names the origin in exactly the fetch directives that must reach it, in %s, and nowhere else',
    (page) => {
      // The whole safety claim of naming the origin: it is one token, in the
      // directives that have to reach this origin's own assets, and nowhere
      // else. Every directive is checked, so one gaining the origin without
      // needing it — or a non-fetch one gaining it — fails here rather than
      // being read past.
      const named = sandboxCspFor(page, ORIGIN, true);
      const withoutOrigin = named.replaceAll(` ${ORIGIN}`, '');
      expect(withoutOrigin).not.toContain(ORIGIN);
      expect(cspDirectiveTokens(withoutOrigin, 'script-src')).toEqual([...SANDBOX_SCRIPT_SOURCES]);
      for (const directive of withoutOrigin.split(';')) {
        const [name] = directive.trim().split(/\s+/);
        if (name === undefined) continue;
        const sources = cspDirectiveTokens(withoutOrigin, name);
        const restored = ORIGIN_NAMING_DIRECTIVES.has(name) ? [...sources, ORIGIN] : sources;
        expect(cspDirectiveTokens(named, name)).toEqual(restored);
      }
    }
  );

  it('refuses a value that is not a URL, rather than splicing it into the policy', () => {
    expect(() => sandboxCspFor(RENDERER_PAGE_PATH, 'sandbox.example', true)).toThrow(/not a URL/);
  });

  it('refuses a URL carrying more than an origin, so it cannot become a second source', () => {
    expect(() => sandboxCspFor(RENDERER_PAGE_PATH, 'https://sandbox.example/render', true)).toThrow(
      /bare origin/
    );
  });

  it('refuses an origin holding a CSP separator, so no directive can be injected', () => {
    // A space and a `;` are the parser's own separators: a value holding one
    // would not widen script-src, it would rewrite the policy.
    expect(() =>
      sandboxCspFor(RENDERER_PAGE_PATH, 'https://sandbox.example; script-src *', true)
    ).toThrow(/the sandbox CSP needs/);
    expect(() => sandboxCspFor(RENDERER_PAGE_PATH, 'https://sandbox.example *', true)).toThrow(
      /the sandbox CSP needs/
    );
  });
});

describe('sandbox _headers drift pins', () => {
  it('is byte-identical to the policy derived for the production origin (both blocks)', () => {
    // The static `_headers` file cannot import TypeScript, so this equality is
    // the single-source contract: the dev server and the browser harnesses
    // derive their policy for the origin they serve, and this pins the shipped
    // file to the derivation for the one production serves. A policy edit in one
    // place without the others fails here, on whichever block moved — and so
    // does a shipped file naming a host the env registry does not.
    const origin = productionSandboxOrigin();
    expect(readCsp(DEFAULT_BLOCK)).toBe(sandboxCspFor(RENDERER_PAGE_PATH, origin, true));
    expect(readCsp(PYTHON_PAGE_PATH)).toBe(sandboxCspFor(PYTHON_PAGE_PATH, origin, true));
  });

  it('names the production origin in script-src on both blocks', () => {
    const origin = productionSandboxOrigin();
    expect(cspDirectiveTokens(readCsp(DEFAULT_BLOCK), 'script-src')).toContain(origin);
    expect(cspDirectiveTokens(readCsp(PYTHON_PAGE_PATH), 'script-src')).toContain(origin);
  });

  it('keeps the permissive CORS + resource-policy baseline for cross-origin asset fetches', () => {
    const content = readFileSync(HEADERS_FILE, 'utf8');
    expect(content).toContain('Access-Control-Allow-Origin: *');
    expect(content).toContain('Cross-Origin-Resource-Policy: cross-origin');
  });

  it('disables DNS prefetch so hostnames cannot leak via <link rel="dns-prefetch">', () => {
    const content = readFileSync(HEADERS_FILE, 'utf8');
    expect(content).toContain('X-DNS-Prefetch-Control: off');
  });
});
