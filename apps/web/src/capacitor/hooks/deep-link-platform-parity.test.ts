import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isAllowedPath } from './use-deep-links.js';

// Three declarations decide whether a tapped https link reaches the right
// in-app route: Android's intent filters, Apple's app-site-association, and the
// handler's own allowlist. Nothing in the build ties them together, so each is
// read from its real source here — restating any of them would rebuild the
// drift this exists to catch.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_MANIFEST = path.resolve(HERE, '../../../android/app/src/main/AndroidManifest.xml');
const APPLE_APP_SITE_ASSOCIATION = path.resolve(
  HERE,
  '../../../../marketing/public/.well-known/apple-app-site-association'
);

/** Reduces a platform path declaration to the in-app path prefix it routes. */
function toPathPrefix(declaration: string): string {
  return declaration.replace(/\/(?:\.\*|\*)$/, '');
}

function unique(prefixes: string[]): string[] {
  return [...new Set(prefixes)];
}

/**
 * Every `android:*` attribute in `xml`, as name/value pairs.
 *
 * Reading the whole attribute family rather than the names this test cares
 * about is what keeps a later manifest edit visible: a reader blind to real
 * manifest content compares a short list against a short list and passes.
 * Both quoting forms are accepted because XML permits either.
 */
function androidAttributes(xml: string): { name: string; value: string }[] {
  const attributes = [...xml.matchAll(/\bandroid:([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
  return attributes.map((attribute) => ({
    name: attribute[1] ?? '',
    value: attribute[2] ?? attribute[3] ?? '',
  }));
}

// Both web schemes, because the handler sets aside only the app's custom scheme
// and treats http as it treats https: an http filter puts the same tapped link in
// front of `toSafePath`, which reads pathname, search and hash only. Apple's
// universal links are https-only, so a path Android routes over http alone is a
// cross-platform divergence rather than a false alarm.
const WEB_SCHEMES = new Set(['https', 'http']);

/** Whether a filter with these attributes may hand a web link to the handler. */
function claimsWebLinks(attributes: { name: string; value: string }[]): boolean {
  return attributes.some(
    ({ name, value }) =>
      (name === 'scheme' && WEB_SCHEMES.has(value)) || (name === 'autoVerify' && value === 'true')
  );
}

function androidRoutedPrefixes(xml: string): string[] {
  // Every filter that claims web links, not just the first and not just the
  // verified ones: an activity may carry any number of them, and each one puts
  // the paths it declares in front of the in-app handler.
  const filters = [...xml.matchAll(/<intent-filter\b[\s\S]*?<\/intent-filter>/g)]
    .map((filter) => androidAttributes(filter[0]))
    .filter((attributes) => claimsWebLinks(attributes));
  if (filters.length === 0) {
    throw new Error('AndroidManifest.xml declares no intent-filter claiming web links');
  }
  const prefixes = filters.flatMap((attributes) =>
    attributes.filter(({ name }) => name.startsWith('path')).map(({ value }) => toPathPrefix(value))
  );
  if (prefixes.length === 0) {
    throw new Error('the intent-filters claiming web links declare no paths');
  }
  return unique(prefixes);
}

interface AppSiteAssociation {
  applinks: { details: { components: { '/': string }[] }[] };
}

function appleRoutedPrefixes(json: string): string[] {
  const association = JSON.parse(json) as AppSiteAssociation;
  const prefixes = association.applinks.details.flatMap((detail) =>
    detail.components.map((component) => toPathPrefix(component['/']))
  );
  if (prefixes.length === 0) {
    throw new Error('the app-site-association declares no path components');
  }
  return unique(prefixes);
}

function inOrder(prefixes: string[]): string[] {
  return prefixes.toSorted((a, b) => a.localeCompare(b));
}

describe('deep-link platform parity', () => {
  it('routes the same path set on both platforms', () => {
    const android = androidRoutedPrefixes(readFileSync(ANDROID_MANIFEST, 'utf8'));
    const apple = appleRoutedPrefixes(readFileSync(APPLE_APP_SITE_ASSOCIATION, 'utf8'));
    expect(inOrder(android)).toEqual(inOrder(apple));
  });

  it('routes nothing into the app on Android that the handler would bounce', () => {
    const android = androidRoutedPrefixes(readFileSync(ANDROID_MANIFEST, 'utf8'));
    expect(android.filter((prefix) => !isAllowedPath(prefix))).toEqual([]);
  });

  it('routes nothing into the app on iOS that the handler would bounce', () => {
    const apple = appleRoutedPrefixes(readFileSync(APPLE_APP_SITE_ASSOCIATION, 'utf8'));
    expect(apple.filter((prefix) => !isAllowedPath(prefix))).toEqual([]);
  });
});

/** Wraps intent filters in the surrounding manifest the real file has. */
function manifestWith(...filters: string[]): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <activity android:name=".MainActivity" android:exported="true">
${filters.join('\n')}
        </activity>
    </application>
</manifest>`;
}

const VERIFIED_HTTPS_CHAT = `            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="hushbox.ai" android:pathPattern="/chat/.*" />
            </intent-filter>`;

// The assertions above can only ever be as good as what these readers see, and a
// reader blind to a real declaration makes them pass while the app routes a link
// they never examined. Each case here is a shape the platform files may legally
// take, fed as text so the blindness is observable without editing the real file.
describe('the Android manifest reader', () => {
  it('reads a path declared by a second intent filter', () => {
    const xml = manifestWith(
      VERIFIED_HTTPS_CHAT,
      `            <intent-filter android:autoVerify="true">
                <data android:scheme="https" android:host="hushbox.ai" android:path="/settings" />
            </intent-filter>`
    );
    expect(inOrder(androidRoutedPrefixes(xml))).toEqual(['/chat', '/settings']);
  });

  it('reads a path declared by a filter that is not autoVerify', () => {
    const xml = manifestWith(
      VERIFIED_HTTPS_CHAT,
      `            <intent-filter>
                <data android:scheme="https" android:host="hushbox.ai" android:path="/settings" />
            </intent-filter>`
    );
    expect(inOrder(androidRoutedPrefixes(xml))).toEqual(['/chat', '/settings']);
  });

  // An http filter routes the same tapped link into the app, and the handler sets
  // aside only the app's custom scheme: toSafePath reads pathname, search and hash
  // only, so http and https reach the same path.
  it('reads a path declared by an http-only filter', () => {
    const xml = manifestWith(
      VERIFIED_HTTPS_CHAT,
      `            <intent-filter android:autoVerify="true">
                <data android:scheme="http" android:host="hushbox.ai" android:path="/settings" />
            </intent-filter>`
    );
    expect(inOrder(androidRoutedPrefixes(xml))).toEqual(['/chat', '/settings']);
  });

  it('reads attribute values written with single quotes', () => {
    const xml = manifestWith(
      VERIFIED_HTTPS_CHAT,
      `            <intent-filter>
                <data android:scheme = 'https' android:host = 'hushbox.ai' android:path = '/settings' />
            </intent-filter>`
    );
    expect(inOrder(androidRoutedPrefixes(xml))).toEqual(['/chat', '/settings']);
  });

  // Never see less than a reader keyed on Android's own verification marker
  // would: `autoVerify` is asserted over web app links, so a filter carrying it
  // claims the paths it declares whatever its scheme attribute says.
  it('reads a path declared by a filter Android is asked to verify', () => {
    const xml = manifestWith(
      VERIFIED_HTTPS_CHAT,
      `            <intent-filter android:autoVerify="true">
                <data android:scheme="hushbox" android:host="hushbox.ai" android:path="/settings" />
            </intent-filter>`
    );
    expect(inOrder(androidRoutedPrefixes(xml))).toEqual(['/chat', '/settings']);
  });

  it('reports a path two filters both declare once', () => {
    const xml = manifestWith(
      VERIFIED_HTTPS_CHAT,
      `            <intent-filter>
                <data android:scheme="https" android:host="hushbox.ai" android:pathPrefix="/chat" />
            </intent-filter>`
    );
    expect(androidRoutedPrefixes(xml)).toEqual(['/chat']);
  });
});

describe('the app-site-association reader', () => {
  it('reports a component two app IDs both declare once', () => {
    const json = JSON.stringify({
      applinks: {
        details: [
          { appID: 'TEAM.ai.hushbox.app', components: [{ '/': '/chat/*' }] },
          { appID: 'TEAM.ai.hushbox.app.dev', components: [{ '/': '/chat/*' }] },
        ],
      },
    });
    expect(appleRoutedPrefixes(json)).toEqual(['/chat']);
  });
});
