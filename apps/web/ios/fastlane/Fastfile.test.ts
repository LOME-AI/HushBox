import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const FASTFILE_PATH = path.join(import.meta.dirname, 'Fastfile');
const MATCHFILE_PATH = path.join(import.meta.dirname, 'Matchfile');
const APPFILE_PATH = path.join(import.meta.dirname, 'Appfile');
const GEMFILE_PATH = path.join(import.meta.dirname, '..', 'Gemfile');

function readFastfile(): string {
  return readFileSync(FASTFILE_PATH, 'utf8');
}

describe('iOS Fastfile', () => {
  it('sets default platform to ios', () => {
    const content = readFastfile();
    expect(content).toContain('default_platform(:ios)');
  });

  it('defines a release lane', () => {
    const content = readFastfile();
    expect(content).toContain('lane :release do');
  });

  it('calls setup_ci for CI keychain', () => {
    const content = readFastfile();
    expect(content).toContain('setup_ci');
  });

  it('calls match with readonly true', () => {
    const content = readFastfile();
    expect(content).toContain('match(');
    expect(content).toContain('readonly: true');
  });

  it('calls build_app with app-store export method', () => {
    const content = readFastfile();
    expect(content).toContain('build_app(');
    expect(content).toContain('export_method: "app-store"');
  });

  it('calls upload_to_app_store', () => {
    const content = readFastfile();
    expect(content).toContain('upload_to_app_store(');
  });

  it('uses App Store Connect API key from environment', () => {
    const content = readFastfile();
    expect(content).toContain('app_store_connect_api_key(');
    expect(content).toContain('ENV["ASC_KEY_ID"]');
    expect(content).toContain('ENV["ASC_ISSUER_ID"]');
    expect(content).toContain('ENV["ASC_KEY_CONTENT"]');
  });
});

describe('iOS Matchfile', () => {
  it('uses git storage mode', () => {
    const content = readFileSync(MATCHFILE_PATH, 'utf8');
    expect(content).toContain('storage_mode("git")');
  });

  it('reads git URL from environment', () => {
    const content = readFileSync(MATCHFILE_PATH, 'utf8');
    expect(content).toContain('ENV["MATCH_GIT_URL"]');
  });

  it('targets appstore type', () => {
    const content = readFileSync(MATCHFILE_PATH, 'utf8');
    expect(content).toContain('type("appstore")');
  });

  it('uses correct bundle ID', () => {
    const content = readFileSync(MATCHFILE_PATH, 'utf8');
    expect(content).toContain('ai.hushbox.app');
  });
});

describe('iOS Appfile', () => {
  it('declares correct bundle ID', () => {
    const content = readFileSync(APPFILE_PATH, 'utf8');
    expect(content).toContain('ai.hushbox.app');
  });
});

describe('iOS Gemfile', () => {
  it('includes fastlane gem', () => {
    const content = readFileSync(GEMFILE_PATH, 'utf8');
    expect(content).toContain('fastlane');
  });
});
