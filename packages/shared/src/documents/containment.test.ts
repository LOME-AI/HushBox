import { describe, expect, it } from 'vitest';
import { DOCUMENT_IFRAME_SANDBOX_ATTR, frameSourceList } from './containment.ts';

/** The app's own meta tag shape: attributes split across lines, one directive. */
const APP_META = `<meta
      http-equiv="Content-Security-Policy"
      content="frame-src 'self' https://sandbox.example"
    />`;

describe('DOCUMENT_IFRAME_SANDBOX_ATTR', () => {
  it('grants scripts', () => {
    // The value is coupled to the sandbox origin's `form-action` directive
    // (`apps/sandbox/src/csp.ts`): adding `allow-forms` would leave a
    // body-carrying POST channel guarded by that CSP directive rather than by
    // this attribute. An editor who needs the grant has to settle that channel
    // first, and updating this constant's pins is not that settlement.
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).toBe('allow-scripts');
  });

  it('grants nothing that would breach the origin boundary', () => {
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).not.toContain('allow-same-origin');
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).not.toContain('allow-popups');
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).not.toContain('allow-top-navigation');
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).not.toContain('allow-modals');
  });
});

describe('frameSourceList', () => {
  it('reads the sources from a meta tag whose attributes span lines', () => {
    expect(frameSourceList(APP_META)).toEqual(["'self'", 'https://sandbox.example']);
  });

  it('reports an extra source, so a widened policy is visible', () => {
    const widened = APP_META.replace(
      'https://sandbox.example',
      'https://sandbox.example https://evil.example.test'
    );
    expect(frameSourceList(widened)).toEqual([
      "'self'",
      'https://sandbox.example',
      'https://evil.example.test',
    ]);
  });

  it('stops at the directive that follows', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="frame-src 'self'; img-src 'self' data:" />`;
    expect(frameSourceList(html)).toEqual(["'self'"]);
  });

  it('reads a frame-src that follows another directive', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="img-src 'self'; frame-src https://sandbox.example" />`;
    expect(frameSourceList(html)).toEqual(['https://sandbox.example']);
  });

  it('does not mistake a directive merely ending in frame-src', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="x-frame-src https://evil.example.test" />`;
    expect(frameSourceList(html)).toBeNull();
  });

  it('collapses the whitespace between sources', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="frame-src   'self'    https://sandbox.example  " />`;
    expect(frameSourceList(html)).toEqual(["'self'", 'https://sandbox.example']);
  });

  it('returns null for a document carrying no policy meta tag', () => {
    expect(frameSourceList('<html lang="en"><head></head></html>')).toBeNull();
  });

  it('returns null for a policy that declares no frame-src', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'" />`;
    expect(frameSourceList(html)).toBeNull();
  });
});
