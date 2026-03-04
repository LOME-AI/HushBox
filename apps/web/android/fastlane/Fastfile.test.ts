import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const FASTFILE_PATH = path.join(import.meta.dirname, 'Fastfile');
const APPFILE_PATH = path.join(import.meta.dirname, 'Appfile');
const GEMFILE_PATH = path.join(import.meta.dirname, '..', 'Gemfile');

function readFastfile(): string {
  return readFileSync(FASTFILE_PATH, 'utf8');
}

describe('Android Fastfile', () => {
  it('sets default platform to android', () => {
    const content = readFastfile();
    expect(content).toContain('default_platform(:android)');
  });

  it('defines a play_store lane', () => {
    const content = readFastfile();
    expect(content).toContain('lane :play_store do');
  });

  it('defines a github_release lane', () => {
    const content = readFastfile();
    expect(content).toContain('lane :github_release do');
  });

  it('builds AAB with bundle task for Play Store', () => {
    const content = readFastfile();
    expect(content).toContain('task: "bundle"');
    expect(content).toContain('build_type: "Release"');
  });

  it('uploads to Play Store production track', () => {
    const content = readFastfile();
    expect(content).toContain('upload_to_play_store(');
    expect(content).toContain('track: "production"');
  });

  it('reads Play Store JSON key from environment', () => {
    const content = readFastfile();
    expect(content).toContain('ENV["PLAY_STORE_JSON_KEY"]');
  });

  it('builds APK with assemble task for GitHub Release', () => {
    const content = readFastfile();
    expect(content).toContain('task: "assemble"');
  });

  it('skips metadata and screenshot uploads', () => {
    const content = readFastfile();
    expect(content).toContain('skip_upload_metadata: true');
    expect(content).toContain('skip_upload_images: true');
    expect(content).toContain('skip_upload_screenshots: true');
  });
});

describe('Android Appfile', () => {
  it('declares correct package name', () => {
    const content = readFileSync(APPFILE_PATH, 'utf8');
    expect(content).toContain('ai.hushbox.app');
  });
});

describe('Android Gemfile', () => {
  it('includes fastlane gem', () => {
    const content = readFileSync(GEMFILE_PATH, 'utf8');
    expect(content).toContain('fastlane');
  });
});

describe('Android build.gradle', () => {
  const BUILD_GRADLE_PATH = path.join(import.meta.dirname, '..', 'app', 'build.gradle');

  function readBuildGradle(): string {
    return readFileSync(BUILD_GRADLE_PATH, 'utf8');
  }

  it('defines a release signing config', () => {
    const content = readBuildGradle();
    expect(content).toContain('signingConfigs');
    expect(content).toContain('release {');
  });

  it('reads keystore path from environment', () => {
    const content = readBuildGradle();
    expect(content).toContain('ANDROID_KEYSTORE_PATH');
  });

  it('reads keystore password from environment', () => {
    const content = readBuildGradle();
    expect(content).toContain('ANDROID_KEYSTORE_PASSWORD');
  });

  it('reads key alias from environment', () => {
    const content = readBuildGradle();
    expect(content).toContain('ANDROID_KEY_ALIAS');
  });

  it('reads key password from environment', () => {
    const content = readBuildGradle();
    expect(content).toContain('ANDROID_KEY_PASSWORD');
  });

  it('injects versionCode from environment', () => {
    const content = readBuildGradle();
    expect(content).toContain('VERSION_CODE');
  });

  it('injects versionName from environment', () => {
    const content = readBuildGradle();
    expect(content).toContain('VERSION_NAME');
  });

  it('applies signing config to release build type', () => {
    const content = readBuildGradle();
    expect(content).toContain('signingConfig signingConfigs.release');
  });

  it('fails fast when VERSION_CODE is missing', () => {
    const content = readBuildGradle();
    expect(content).toContain('GradleException');
    expect(content).toContain('VERSION_CODE environment variable is required');
  });

  it('fails fast when VERSION_NAME is missing', () => {
    const content = readBuildGradle();
    expect(content).toContain('VERSION_NAME environment variable is required');
  });
});
