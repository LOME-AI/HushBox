import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PBXPROJ_PATH = path.join(import.meta.dirname, 'project.pbxproj');

function readPbxproj(): string {
  return readFileSync(PBXPROJ_PATH, 'utf8');
}

describe('project.pbxproj — PrivacyInfo.xcprivacy', () => {
  it('has a PBXFileReference entry', () => {
    const content = readPbxproj();
    expect(content).toMatch(
      /\/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;.*lastKnownFileType = text\.xml;.*path = PrivacyInfo\.xcprivacy;/
    );
  });

  it('is in the App PBXGroup children', () => {
    const content = readPbxproj();
    const appGroupMatch = /\/\* App \*\/ = \{\s*isa = PBXGroup;\s*children = \(([\s\S]*?)\);/.exec(
      content
    );
    expect(appGroupMatch).not.toBeNull();
    expect(appGroupMatch![1]).toContain('/* PrivacyInfo.xcprivacy */');
  });

  it('has a PBXBuildFile entry for Resources', () => {
    const content = readPbxproj();
    expect(content).toMatch(
      /\/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile;/
    );
  });

  it('is in PBXResourcesBuildPhase', () => {
    const content = readPbxproj();
    const resourcesMatch =
      /\/\* Resources \*\/ = \{\s*isa = PBXResourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/.exec(
        content
      );
    expect(resourcesMatch).not.toBeNull();
    expect(resourcesMatch![1]).toContain('/* PrivacyInfo.xcprivacy in Resources */');
  });
});
