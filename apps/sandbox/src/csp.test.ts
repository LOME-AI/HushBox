import { describe, it, expect } from 'vitest';
import { cspDirectiveTokens, PYTHON_PAGE_PATH, sandboxCspFor } from './csp.js';

/**
 * The one thing the sandbox policy may not carry: a `'self'` token in any
 * directive.
 *
 * The measurements behind that, and the rule they produced — every fetch
 * directive names the served origin — are recorded in the module header of
 * `apps/sandbox/src/csp.ts`, the module this file tests.
 *
 * `apps/sandbox/src/headers.test.ts` pins what the policy grants — the served
 * origin, the wheel hosts, the `'none'` floors — against both entry points and
 * the committed `_headers`. This file pins the one token it must not, which is
 * why it reads every directive rather than an enumerated list: a directive added
 * later with `'self'` in it fails here without anyone remembering to extend a
 * list.
 */

/** The renderer entry point, whose policy every path but the Python one is served. */
const RENDERER_PAGE_PATH = '/render.html';

const ORIGIN = 'https://sandbox.example';

/** Every directive name the policy for `pathname` declares, in order. */
function directiveNames(csp: string): string[] {
  return csp.split(';').map((directive) => directive.trim().split(/\s+/)[0] ?? '');
}

describe.each([RENDERER_PAGE_PATH, PYTHON_PAGE_PATH])('the sandbox policy for %s', (page) => {
  it('carries the self token in no directive at all', () => {
    const csp = sandboxCspFor(page, ORIGIN, true);
    const bearing = directiveNames(csp).filter((name) =>
      cspDirectiveTokens(csp, name).includes("'self'")
    );
    expect(bearing).toEqual([]);
  });

  it('denies a form submission target outright rather than naming one', () => {
    // Read as an exact list rather than an absence: a policy that dropped the
    // directive entirely would satisfy the token sweep, and this is what
    // refuses that.
    expect(cspDirectiveTokens(sandboxCspFor(page, ORIGIN, true), 'form-action')).toEqual([
      "'none'",
    ]);
  });

  it.each(['script-src', 'connect-src', 'img-src', 'style-src', 'font-src'])(
    'still names the served origin in %s, which is what boots the frame',
    (directive) => {
      // The other half of dropping the token, and the half that fails silently:
      // the explicit origin is the only source these directives have for this
      // origin's own assets, so removing it anywhere takes reach away rather
      // than tightening anything.
      expect(cspDirectiveTokens(sandboxCspFor(page, ORIGIN, true), directive)).toContain(ORIGIN);
    }
  );

  it('forbids a base element outright rather than pointing it at an origin', () => {
    // No page this origin serves has a `<base>` to point, so the outright deny
    // costs these pages nothing.
    expect(cspDirectiveTokens(sandboxCspFor(page, ORIGIN, true), 'base-uri')).toEqual(["'none'"]);
  });
});

describe.each([RENDERER_PAGE_PATH, PYTHON_PAGE_PATH])('frame-ancestors for %s', (page) => {
  it('admits exactly the web app and the production native app origins in production output', () => {
    expect(cspDirectiveTokens(sandboxCspFor(page, ORIGIN, true), 'frame-ancestors')).toEqual([
      'https://hushbox.ai',
      'capacitor://native.hushbox.ai',
      'https://native.hushbox.ai',
    ]);
  });

  it('admits no localhost embedder in production output, whatever origin serves it', () => {
    const csp = sandboxCspFor(page, 'http://localhost:7400', true);
    for (const source of cspDirectiveTokens(csp, 'frame-ancestors')) {
      expect(source).not.toContain('localhost');
    }
  });

  it('admits the localhost embedders a local stack frames it from outside production', () => {
    expect(
      cspDirectiveTokens(sandboxCspFor(page, 'http://localhost:7400', false), 'frame-ancestors')
    ).toEqual(['https://hushbox.ai', 'capacitor://localhost', 'http://localhost:*']);
  });
});
