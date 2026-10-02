import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PRIVACY_MANIFEST_PATH = path.join(import.meta.dirname, 'PrivacyInfo.xcprivacy');

function readPrivacyManifest(): string {
  return readFileSync(PRIVACY_MANIFEST_PATH, 'utf8');
}

const COLLECTED_DATA_TYPES_KEY = '<key>NSPrivacyCollectedDataTypes</key>';

function readCollectedDataTypesArray(): string {
  const content = readPrivacyManifest();
  const keyIndex = content.indexOf(COLLECTED_DATA_TYPES_KEY);
  if (keyIndex === -1) throw new Error('NSPrivacyCollectedDataTypes key is missing');
  const valueStart = keyIndex + COLLECTED_DATA_TYPES_KEY.length;
  const opening = /^\s*<array(\/?)>/.exec(content.slice(valueStart));
  if (opening === null) throw new Error('NSPrivacyCollectedDataTypes value is not an array');
  if (opening[1] === '/') return opening[0].trim();
  const tagPattern = /<array>|<\/array>/g;
  tagPattern.lastIndex = valueStart;
  let depth = 0;
  for (let match = tagPattern.exec(content); match !== null; match = tagPattern.exec(content)) {
    depth += match[0] === '<array>' ? 1 : -1;
    if (depth === 0) return content.slice(valueStart, tagPattern.lastIndex).trim();
  }
  throw new Error('NSPrivacyCollectedDataTypes array is never closed');
}

function readCollectedDataTypeEntries(): string[] {
  const entries = readCollectedDataTypesArray().match(/<dict>[\s\S]*?<\/dict>/g) ?? [];
  if (entries.length === 0) throw new Error('NSPrivacyCollectedDataTypes holds no entries');
  return entries;
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

  it('declares the five collected data types', () => {
    const collected = readCollectedDataTypesArray();

    const expectedTypes = [
      'NSPrivacyCollectedDataTypeEmailAddress',
      'NSPrivacyCollectedDataTypeUserID',
      'NSPrivacyCollectedDataTypePurchaseHistory',
      'NSPrivacyCollectedDataTypeEmailsOrTextMessages',
      'NSPrivacyCollectedDataTypeCustomerSupport',
    ];

    for (const dataType of expectedTypes) {
      expect(collected).toMatch(
        new RegExp(String.raw`<key>NSPrivacyCollectedDataType</key>\s*<string>${dataType}</string>`)
      );
    }
  });

  it('has exactly 5 collected data type entries', () => {
    const collected = readCollectedDataTypesArray();
    expect(collected.match(/<dict>/g)).toHaveLength(5);
    expect(collected.match(/<key>NSPrivacyCollectedDataType<\/key>/g)).toHaveLength(5);
  });

  it('marks every collected data type as linked to the user', () => {
    for (const entry of readCollectedDataTypeEntries()) {
      expect(entry).toMatch(/<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/);
    }
  });

  it('marks every collected data type as not used for tracking', () => {
    for (const entry of readCollectedDataTypeEntries()) {
      expect(entry).toMatch(/<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<false\/>/);
    }
  });

  it('gives every collected data type app functionality as its only purpose', () => {
    for (const entry of readCollectedDataTypeEntries()) {
      expect(entry).toMatch(
        /<key>NSPrivacyCollectedDataTypePurposes<\/key>\s*<array>\s*<string>NSPrivacyCollectedDataTypePurposeAppFunctionality<\/string>\s*<\/array>/
      );
    }
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
