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

  it('defines a build_aab lane', () => {
    const content = readFastfile();
    expect(content).toContain('lane :build_aab do');
  });

  it('defines a build_apk lane', () => {
    const content = readFastfile();
    expect(content).toContain('lane :build_apk do');
  });

  it('defines an upload_aab lane that accepts options', () => {
    const content = readFastfile();
    expect(content).toMatch(/lane :upload_aab do \|\w+\|/);
  });

  it('build_aab uses gradle bundle task with Release build type', () => {
    const content = readFastfile();
    const buildAabLane = extractLane(content, 'build_aab');
    expect(buildAabLane).toContain('task: "bundle"');
    expect(buildAabLane).toContain('build_type: "Release"');
  });

  it('build_apk uses gradle assemble task with Release build type', () => {
    const content = readFastfile();
    const buildApkLane = extractLane(content, 'build_apk');
    expect(buildApkLane).toContain('task: "assemble"');
    expect(buildApkLane).toContain('build_type: "Release"');
  });

  it('upload_aab reads track from options with production default', () => {
    const content = readFastfile();
    const uploadLane = extractLane(content, 'upload_aab');
    expect(uploadLane).toMatch(/\[:track\]\s*\|\|\s*"production"/);
  });

  it('upload_aab passes track through to upload_to_play_store', () => {
    const content = readFastfile();
    const uploadLane = extractLane(content, 'upload_aab');
    expect(uploadLane).toContain('upload_to_play_store(');
    expect(uploadLane).toMatch(/track:\s*track/);
  });

  it('upload_aab reads Play Store JSON key from environment', () => {
    const content = readFastfile();
    const uploadLane = extractLane(content, 'upload_aab');
    expect(uploadLane).toContain('ENV["PLAY_STORE_JSON_KEY"]');
  });

  it('upload_aab points at the AAB produced by build_aab', () => {
    const content = readFastfile();
    const uploadLane = extractLane(content, 'upload_aab');
    expect(uploadLane).toContain('app/build/outputs/bundle/release/app-release.aab');
  });

  it('upload_aab skips metadata, image, and screenshot uploads', () => {
    const content = readFastfile();
    const uploadLane = extractLane(content, 'upload_aab');
    expect(uploadLane).toContain('skip_upload_metadata: true');
    expect(uploadLane).toContain('skip_upload_images: true');
    expect(uploadLane).toContain('skip_upload_screenshots: true');
  });

  it('does not reference the retired play_store lane', () => {
    const content = readFastfile();
    expect(content).not.toMatch(/lane :play_store\b/);
  });

  it('does not reference the retired github_release lane', () => {
    const content = readFastfile();
    expect(content).not.toMatch(/lane :github_release\b/);
  });

  it('does not hardcode any single track value at the call site', () => {
    const content = readFastfile();
    expect(content).not.toMatch(/track:\s*"production"/);
    expect(content).not.toMatch(/track:\s*"internal"/);
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

function extractLane(content: string, laneName: string): string {
  const startPattern = new RegExp(`lane :${laneName} do(?:\\s*\\|[^|]*\\|)?`);
  const startMatch = startPattern.exec(content);
  if (!startMatch) {
    throw new Error(`Lane :${laneName} not found in Fastfile`);
  }
  const body = content.slice(startMatch.index + startMatch[0].length);
  let depth = 1;
  let i = 0;
  while (i < body.length && depth > 0) {
    if (body.startsWith('do', i) || body.startsWith('do\n', i) || body.startsWith('do ', i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (body.startsWith('end', i) && (body[i + 3] === '\n' || body[i + 3] === ' ' || i + 3 === body.length)) {
      depth -= 1;
      if (depth === 0) {
        return body.slice(0, i);
      }
      i += 3;
      continue;
    }
    i += 1;
  }
  throw new Error(`Could not find matching end for lane :${laneName}`);
}
