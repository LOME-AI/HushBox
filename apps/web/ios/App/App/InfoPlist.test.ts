import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { APP_URL_SCHEME } from '@hushbox/shared/billing-portal';

const INFO_PLIST_PATH = path.join(import.meta.dirname, 'Info.plist');

function readInfoPlist(): string {
  return readFileSync(INFO_PLIST_PATH, 'utf8');
}

describe('Info.plist', () => {
  it('declares ITSAppUsesNonExemptEncryption as true', () => {
    const content = readInfoPlist();
    expect(content).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<true\/>/);
  });

  // Ruled in `docs/DECISIONS.md` §Product, "A French encryption declaration for the iOS app".
  it('declares no ITSEncryptionExportComplianceCode', () => {
    const content = readInfoPlist();
    expect(content).not.toContain('ITSEncryptionExportComplianceCode');
  });

  it("registers the app's URL scheme and no other", () => {
    const content = readInfoPlist();
    const schemes = [
      ...content.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g),
    ].flatMap((declaration) =>
      [...(declaration[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((scheme) => scheme[1])
    );
    expect(content).toMatch(
      /<key>CFBundleURLTypes<\/key>\s*<array>\s*<dict>[\s\S]*?<key>CFBundleURLSchemes<\/key>/
    );
    expect(schemes).toEqual([APP_URL_SCHEME]);
  });
});
