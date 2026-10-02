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

  it('defines a private_lane :build_ipa for shared signing and build', () => {
    const content = readFastfile();
    expect(content).toMatch(/private_lane :build_ipa do\b/);
  });

  it('defines a public lane :build that produces the IPA artifact only', () => {
    const content = readFastfile();
    expect(content).toMatch(/^\s*lane :build do\b/m);
  });

  it('defines a public lane :release that accepts options', () => {
    const content = readFastfile();
    expect(content).toMatch(/lane :release do \|\w+\|/);
  });

  it('build_ipa calls setup_ci for CI keychain', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'build_ipa', 'private_lane');
    expect(lane).toContain('setup_ci');
  });

  it('build_ipa reads App Store Connect API key from environment', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'build_ipa', 'private_lane');
    expect(lane).toContain('app_store_connect_api_key(');
    expect(lane).toContain('ENV["ASC_KEY_ID"]');
    expect(lane).toContain('ENV["ASC_ISSUER_ID"]');
    expect(lane).toContain('ENV["ASC_KEY_CONTENT"]');
  });

  it('build_ipa calls match with readonly true for appstore certs', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'build_ipa', 'private_lane');
    expect(lane).toContain('match(');
    expect(lane).toContain('readonly: true');
  });

  it('build_ipa calls build_app with app-store export method', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'build_ipa', 'private_lane');
    expect(lane).toContain('build_app(');
    expect(lane).toContain('export_method: "app-store"');
  });

  it('build lane delegates to build_ipa and does not upload', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'build', 'lane');
    expect(lane).toContain('build_ipa');
    expect(lane).not.toContain('upload_to_app_store');
  });

  it('release lane delegates to build_ipa and captures its return value', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'release', 'lane');
    expect(lane).toMatch(/=\s*build_ipa/);
  });

  it('release lane calls upload_to_app_store with parameterized submit_for_review', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'release', 'lane');
    expect(lane).toContain('upload_to_app_store(');
    expect(lane).toMatch(/submit_for_review:\s*submit_for_review/);
  });

  it('release lane reads submit_for_review from options with false default', () => {
    const content = readFastfile();
    const lane = extractLane(content, 'release', 'lane');
    expect(lane).toMatch(/\[:submit_for_review\]\s*\|\|\s*false/);
  });

  it('does not hardcode submit_for_review: true at the call site', () => {
    const content = readFastfile();
    expect(content).not.toMatch(/submit_for_review:\s*true/);
  });
});

describe('extractLane', () => {
  it('treats "do" as a block opener only at a word boundary', () => {
    const content = ['lane :sample do', '  build_app(scheme: "undo")', 'end'].join('\n');

    expect(extractLane(content, 'sample', 'lane')).toContain('undo');
  });

  it('treats "end" as a block closer only at a word boundary', () => {
    const content = ['lane :sample do', '  build_app(scheme: "bend it")', 'end'].join('\n');

    expect(extractLane(content, 'sample', 'lane')).toContain('bend it');
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

/** What Ruby lets an identifier be made of, and so what makes `undo` a word rather than a `do`. */
const WORD_CHARACTER = /\w/u;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

/**
 * Whether `keyword` sits at `index` as a whole word. Both sides are load-bearing:
 * with no boundary on the left, `undo` opens a block the scan never closes and
 * `bend` closes one early, handing the caller a silently truncated lane body.
 */
function isKeywordAt(body: string, index: number, keyword: string): boolean {
  return (
    body.startsWith(keyword, index) &&
    !isWordCharacter(body[index - 1]) &&
    !isWordCharacter(body[index + keyword.length])
  );
}

function extractLane(content: string, laneName: string, kind: 'lane' | 'private_lane'): string {
  const startPattern = new RegExp(String.raw`${kind} :${laneName} do(?:\s*\|[^|]*\|)?`);
  const startMatch = startPattern.exec(content);
  if (!startMatch) {
    throw new Error(`${kind} :${laneName} not found in Fastfile`);
  }
  const body = content.slice(startMatch.index + startMatch[0].length);
  let depth = 1;
  let index = 0;
  while (index < body.length && depth > 0) {
    if (isKeywordAt(body, index, 'do')) {
      depth += 1;
      index += 2;
      continue;
    }
    if (isKeywordAt(body, index, 'end')) {
      depth -= 1;
      if (depth === 0) {
        return body.slice(0, index);
      }
      index += 3;
      continue;
    }
    index += 1;
  }
  throw new Error(`Could not find matching end for ${kind} :${laneName}`);
}
