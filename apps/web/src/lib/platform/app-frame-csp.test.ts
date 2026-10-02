import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { frameSourceList } from '@hushbox/shared/documents';

// The app-origin frame-src policy that must reach the bundled Capacitor WebView,
// where the generated `_headers` CSP does not apply. Pinned here so a future edit
// that drops or widens it fails before review. Runtime enforcement (a sandboxed
// document being unable to navigate its own frame to an off-allowlist host) is a
// browser behavior verified on the web via the security suite and on-device via
// the Android Maestro flow — jsdom does not enforce CSP, so this suite pins the
// policy's presence and exact shape, which is what mobile containment rests on.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(path.resolve(HERE, '../../../index.html'), 'utf8');

describe('app-origin frame-src (mobile CSP)', () => {
  it('ships a Content-Security-Policy meta tag in the app HTML', () => {
    expect(INDEX_HTML).toMatch(/<meta\s+http-equiv="Content-Security-Policy"/i);
  });

  it('constrains child frames to self and the sandbox origin, and nothing else', () => {
    // The whole source list, not a containment check: a policy that also named a
    // hostile origin would still carry both of these, so only an exact list
    // rejects the widening. The per-mode sandbox origin is substituted by Vite at
    // build time — never a hard-coded domain, so dev/preview/prod each get the
    // correct allowlist.
    //
    // This is also the assertion that forbids an arbitrary child-frame host, in
    // every form one takes: a bare `*`, a bare scheme (`https:`), and a named
    // hostile origin each show up here as an extra source. A check that only
    // rejects `*` admits the other two, and admits a policy deleted outright.
    expect(frameSourceList(INDEX_HTML)).toEqual(["'self'", '%VITE_SANDBOX_ORIGIN_URL%']);
  });

  it('sets no default-src, so only framing is narrowed', () => {
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(
      INDEX_HTML
    );
    expect(meta?.[1]).not.toMatch(/default-src/i);
  });
});
