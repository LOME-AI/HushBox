import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { APP_RETURN_TO_BILLING_URL, APP_URL_SCHEME } from '@hushbox/shared/billing-portal';

const MANIFEST_PATH = path.join(import.meta.dirname, 'AndroidManifest.xml');
const LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER';

/** Both spellings Android resolves to `ai.hushbox.app.MainActivity`. */
const MAIN_ACTIVITY_NAME = /android:name\s*=\s*(["'])(?:\.|ai\.hushbox\.app\.)MainActivity\1/;

function readManifest(): string {
  return readFileSync(MANIFEST_PATH, 'utf8');
}

/**
 * The `<activity>` element whose intent filter carries the LAUNCHER category —
 * the one Android starts from the home screen. Scoped to that element rather
 * than read off the whole manifest, so a second activity declared launcher
 * cannot be answered by this one's `android:name`.
 */
function readLauncherActivity(): string {
  const manifest = readManifest();
  const category = manifest.indexOf(LAUNCHER_CATEGORY);
  if (category === -1) {
    return '';
  }
  const start = manifest.lastIndexOf('<activity', category);
  const end = manifest.indexOf('</activity>', category);
  return start === -1 || end === -1 ? '' : manifest.slice(start, end);
}

describe('AndroidManifest.xml deep link intent filter', () => {
  it('has autoVerify intent filter', () => {
    const content = readManifest();
    expect(content).toContain('android:autoVerify="true"');
  });

  it('declares VIEW action', () => {
    const content = readManifest();
    expect(content).toContain('android.intent.action.VIEW');
  });

  it('declares DEFAULT and BROWSABLE categories', () => {
    const content = readManifest();
    expect(content).toContain('android.intent.category.DEFAULT');
    expect(content).toContain('android.intent.category.BROWSABLE');
  });

  it('targets https scheme on hushbox.ai host', () => {
    const content = readManifest();
    expect(content).toContain('android:scheme="https"');
    expect(content).toContain('android:host="hushbox.ai"');
  });

  it('includes /chat/* path pattern', () => {
    const content = readManifest();
    expect(content).toContain('android:pathPattern="/chat/.*"');
  });

  it('includes the exact-path deep link targets', () => {
    const content = readManifest();
    expect(content).toContain('android:path="/billing"');
    expect(content).toContain('android:path="/settings"');
  });
});

describe('AndroidManifest.xml launcher activity', () => {
  it("launches this app's MainActivity, not a stock BridgeActivity", () => {
    // Everything MainActivity.java does — renderer-death recovery and its bound —
    // hangs off this one attribute, and its guard suite reads that file rather
    // than the manifest: repoint this at `com.getcapacitor.BridgeActivity` and
    // the app still launches, the recovery is gone, and every one of those
    // assertions stays green over a file nothing launches any more.
    //
    // Accepted, because Android resolves both to the same class and a manifest
    // may legally be written either way: the relative `.MainActivity` this file
    // uses today and the fully-qualified `ai.hushbox.app.MainActivity`, under
    // either quote character and with whitespace around the `=`.
    //
    // Wrongly rejected by that same shape rule, in the other direction: an
    // `<activity-alias>` pointing at MainActivity as the launcher, and a rename
    // of the Gradle `namespace` carried through to a fully-qualified name here.
    // Both are legal and correct, and neither is what this guard is for — a
    // namespace the relative form no longer resolves against fails at launch
    // rather than silently, which is the failure this assertion cannot add to.
    expect(readLauncherActivity()).toMatch(MAIN_ACTIVITY_NAME);
  });
});

// The billing portal returns to the app through this link, so its host is read off
// the link itself rather than restated.
const RETURN_LINK_HOST = new URL(APP_RETURN_TO_BILLING_URL).host;

/** The launcher activity's intent filters that name the app's URL scheme. */
function readReturnLinkFilters(): string[] {
  return [...readLauncherActivity().matchAll(/<intent-filter\b[\s\S]*?<\/intent-filter>/g)]
    .map((filter) => filter[0])
    .filter((filter) =>
      [...filter.matchAll(/\bandroid:scheme\s*=\s*"([^"]*)"/g)].some(
        (scheme) => scheme[1] === APP_URL_SCHEME
      )
    );
}

function attributeValues(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(String.raw`\bandroid:${name}\s*=\s*"([^"]*)"`, 'g'))].map(
    (attribute) => attribute[1] ?? ''
  );
}

describe('AndroidManifest.xml billing return link', () => {
  it("declares one MainActivity intent filter on the app's URL scheme", () => {
    expect(readReturnLinkFilters()).toHaveLength(1);
  });

  it('claims only the return link host on that scheme', () => {
    const [filter = ''] = readReturnLinkFilters();
    expect(attributeValues(filter, 'host')).toEqual([RETURN_LINK_HOST]);
  });

  it('opens the return link from a browser as a VIEW intent', () => {
    const [filter = ''] = readReturnLinkFilters();
    expect(attributeValues(filter, 'name').toSorted((a, b) => a.localeCompare(b))).toEqual([
      'android.intent.action.VIEW',
      'android.intent.category.BROWSABLE',
      'android.intent.category.DEFAULT',
    ]);
  });

  it('does not ask Android to verify the return link filter', () => {
    const [filter = ''] = readReturnLinkFilters();
    expect(filter).toMatch(/^<intent-filter\b/);
    expect(filter).not.toContain('autoVerify');
  });
});

describe('AndroidManifest.xml network security', () => {
  it('references network security config instead of blanket cleartext flag', () => {
    const content = readManifest();
    expect(content).toContain('android:networkSecurityConfig="@xml/network_security_config"');
    expect(content).not.toContain('usesCleartextTraffic');
  });
});
