import { describe, it, expect } from 'vitest';
import {
  generateVersionString,
  getDistributionZipPath,
  getApiBaseUrl,
  getSetVersionUrl,
  getUpdatesCurrentUrl,
  getR2ObjectKey,
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
  it('returns the R2 key for a given version', () => {
    expect(getR2ObjectKey('abc123')).toBe('hushbox-app-builds/builds/abc123.zip');
  });

  it('handles dev-update style versions', () => {
    expect(getR2ObjectKey('dev-update-1234567890')).toBe(
      'hushbox-app-builds/builds/dev-update-1234567890.zip'
    );
  });
});
