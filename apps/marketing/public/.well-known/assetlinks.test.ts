import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ASSETLINKS_PATH = path.join(import.meta.dirname, 'assetlinks.json');

interface AssetLink {
  relation: string[];
  target: {
    namespace: string;
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

function readAssetLinks(): AssetLink[] {
  const content = readFileSync(ASSETLINKS_PATH, 'utf8');
  return JSON.parse(content) as AssetLink[];
}

describe('assetlinks.json', () => {
  it('is valid JSON array', () => {
    const links = readAssetLinks();
    expect(links).toBeInstanceOf(Array);
    expect(links).toHaveLength(1);
  });

  it('declares handle_all_urls relation', () => {
    const links = readAssetLinks();
    const link = links[0];
    expect(link.relation).toContain('delegate_permission/common.handle_all_urls');
  });

  it('targets the correct Android package', () => {
    const links = readAssetLinks();
    const link = links[0];
    expect(link.target.namespace).toBe('android_app');
    expect(link.target.package_name).toBe('ai.hushbox.app');
  });

  it('includes a SHA256 fingerprint placeholder', () => {
    const links = readAssetLinks();
    const link = links[0];
    expect(link.target.sha256_cert_fingerprints).toHaveLength(1);
    expect(link.target.sha256_cert_fingerprints[0]).toMatch(/^[A-Z0-9_]+$/);
  });
});
