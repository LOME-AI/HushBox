import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const MANIFEST_PATH = path.join(import.meta.dirname, 'AndroidManifest.xml');

function readManifest(): string {
  return readFileSync(MANIFEST_PATH, 'utf8');
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

  it('includes /billing, /settings, /login, /signup paths', () => {
    const content = readManifest();
    expect(content).toContain('android:path="/billing"');
    expect(content).toContain('android:path="/settings"');
    expect(content).toContain('android:path="/login"');
    expect(content).toContain('android:path="/signup"');
  });
});
