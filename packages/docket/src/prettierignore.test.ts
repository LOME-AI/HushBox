import { readFileSync } from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { parseFinding } from './parse.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const IGNORE_PATH = path.join(REPO_ROOT, '.prettierignore');

async function isIgnored(relative: string): Promise<boolean> {
  const info = await prettier.getFileInfo(path.join(REPO_ROOT, relative), {
    ignorePath: IGNORE_PATH,
  });
  return info.ignored;
}

describe('prettier would break the format', () => {
  it('rewrites the frontmatter into something the parser rejects', async () => {
    const fixturePath = path.join(REPO_ROOT, 'packages/docket/test-fixtures/open-two-options.md');
    const text = readFileSync(fixturePath, 'utf8');
    const config = await prettier.resolveConfig(path.join(REPO_ROOT, 'README.md'));
    const formatted = await prettier.format(text, {
      ...config,
      plugins: [],
      parser: 'markdown',
    });

    expect(formatted).not.toBe(text);
    expect(formatted).toContain("id: 'AI-1'");
    expect(parseFinding(formatted, fixturePath).ok).toBe(false);
  });
});

describe('.prettierignore covers every file in the format', () => {
  it.each([
    'packages/docket/test-fixtures/open-two-options.md',
    'packages/docket/test-fixtures/ruled-history.md',
    'docs/audits/2026-07-30/audit.md',
    'docs/audits/2026-07-30/findings/AI-1.md',
    '.claude/skills/improve-codebase/template/audit.md',
    '.claude/skills/improve-codebase/template/finding.md',
  ])('ignores %s', async (relative) => {
    expect(await isIgnored(relative)).toBe(true);
  });

  it('still formats the contract document itself', async () => {
    expect(await isIgnored('docs/audits/CLAUDE.md')).toBe(false);
  });
});
