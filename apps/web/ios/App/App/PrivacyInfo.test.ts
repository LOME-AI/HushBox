import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PRIVACY_MANIFEST_PATH = path.join(import.meta.dirname, 'PrivacyInfo.xcprivacy');

function readPrivacyManifest(): string {
  return readFileSync(PRIVACY_MANIFEST_PATH, 'utf8');
}

describe('PrivacyInfo.xcprivacy', () => {
  it('is valid XML with plist root element', () => {
    const content = readPrivacyManifest();
    expect(content).toContain('<?xml');
    expect(content).toContain('<plist');
    expect(content).toContain('</plist>');
  });

  it('declares NSPrivacyTracking as false', () => {
    const content = readPrivacyManifest();
    expect(content).toContain('<key>NSPrivacyTracking</key>');
    expect(content).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  });

  it('declares empty NSPrivacyTrackingDomains', () => {
    const content = readPrivacyManifest();
    expect(content).toContain('<key>NSPrivacyTrackingDomains</key>');
    expect(content).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
  });

  it('declares empty NSPrivacyCollectedDataTypes', () => {
    const content = readPrivacyManifest();
    expect(content).toContain('<key>NSPrivacyCollectedDataTypes</key>');
    expect(content).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
  });

  it('declares NSPrivacyAccessedAPITypes with 4 categories', () => {
    const content = readPrivacyManifest();
    expect(content).toContain('<key>NSPrivacyAccessedAPITypes</key>');

    const requiredCategories = [
      'NSPrivacyAccessedAPICategoryFileTimestamp',
      'NSPrivacyAccessedAPICategoryDiskSpace',
      'NSPrivacyAccessedAPICategoryUserDefaults',
      'NSPrivacyAccessedAPICategorySystemBootTime',
    ];

    for (const category of requiredCategories) {
      expect(content).toContain(category);
    }
  });

  it('declares correct reason codes for each API category', () => {
    const content = readPrivacyManifest();

    const expectedReasons: Record<string, string> = {
      NSPrivacyAccessedAPICategoryFileTimestamp: 'C617.1',
      NSPrivacyAccessedAPICategoryDiskSpace: 'E174.1',
      NSPrivacyAccessedAPICategoryUserDefaults: 'CA92.1',
      NSPrivacyAccessedAPICategorySystemBootTime: '35F9.1',
    };

    for (const [, reason] of Object.entries(expectedReasons)) {
      expect(content).toContain(reason);
    }
  });

  it('has exactly 4 API type entries', () => {
    const content = readPrivacyManifest();
    const categoryMatches = content.match(/NSPrivacyAccessedAPICategoryType/g);
    expect(categoryMatches).toHaveLength(4);
  });
});
