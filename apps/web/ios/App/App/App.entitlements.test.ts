import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ENTITLEMENTS_PATH = path.join(import.meta.dirname, 'App.entitlements');

function readEntitlements(): string {
  return readFileSync(ENTITLEMENTS_PATH, 'utf8');
}

describe('App.entitlements', () => {
  it('is valid XML with plist root element', () => {
    const content = readEntitlements();
    expect(content).toContain('<?xml');
    expect(content).toContain('<plist');
    expect(content).toContain('</plist>');
  });

  it('declares associated domains capability', () => {
    const content = readEntitlements();
    expect(content).toContain('<key>com.apple.developer.associated-domains</key>');
  });

  it('includes applinks for hushbox.ai', () => {
    const content = readEntitlements();
    expect(content).toContain('applinks:hushbox.ai');
  });
});
