import { describe, it, expect } from 'vitest';
import {
  generateVersionString,
  getDistributionZipPath,
  getApiBaseUrl,
  getSetVersionUrl,
  getUpdatesCurrentUrl,
  getR2ObjectKey,
  parsePlatformArgument,
} from './cap-test-update.js';

describe('generateVersionString', () => {
  it('generates a string starting with dev-update-', () => {
    const version = generateVersionString();
    expect(version).toMatch(/^dev-update-/);
  });

  it('generates unique strings on successive calls', () => {
    const v1 = generateVersionString();
    const v2 = generateVersionString();
    expect(v1).not.toBe(v2);
  });

  it('includes a timestamp and counter component', () => {
    const version = generateVersionString();
    // Format: dev-update-{timestamp}-{counter}
    const parts = version.replace('dev-update-', '').split('-');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).toBeGreaterThan(0);
    expect(Number(parts[1])).toBeGreaterThan(0);
  });
});

describe('getDistZipPath', () => {
  it('returns the dist zip path under web app', () => {
    const result = getDistributionZipPath('/root');
    expect(result).toBe('/root/apps/web/dist');
  });
});

describe('getApiBaseUrl', () => {
  it('returns the default local API URL', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:8787');
  });
});

describe('getUpdatesCurrentUrl', () => {
  it('returns the updates/current endpoint URL', () => {
    expect(getUpdatesCurrentUrl()).toBe('http://localhost:8787/api/updates/current');
  });
});

describe('getSetVersionUrl', () => {
  it('returns the dev/set-version endpoint URL', () => {
    expect(getSetVersionUrl()).toBe('http://localhost:8787/api/dev/set-version');
  });
});

describe('getR2ObjectKey', () => {
  it('returns platform-specific R2 key for ios', () => {
    expect(getR2ObjectKey('ios', 'abc123')).toBe('hushbox-app-builds/builds/ios/abc123.zip');
  });

  it('returns platform-specific R2 key for android', () => {
    expect(getR2ObjectKey('android', '1.0.0')).toBe('hushbox-app-builds/builds/android/1.0.0.zip');
  });

  it('returns platform-specific R2 key for android-direct', () => {
    expect(getR2ObjectKey('android-direct', 'dev-update-1234567890')).toBe(
      'hushbox-app-builds/builds/android-direct/dev-update-1234567890.zip'
    );
  });
});

describe('parsePlatformArgument', () => {
  it('returns undefined when --platform is not provided', () => {
    expect(parsePlatformArgument([])).toBeUndefined();
  });

  it('returns undefined when --platform has no value', () => {
    expect(parsePlatformArgument(['--platform'])).toBeUndefined();
  });

  it('returns the platform value when provided', () => {
    expect(parsePlatformArgument(['--platform', 'ios'])).toBe('ios');
  });

  it('parses android-direct platform', () => {
    expect(parsePlatformArgument(['--platform', 'android-direct'])).toBe('android-direct');
  });
});
