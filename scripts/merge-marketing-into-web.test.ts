import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeMarketingIntoWeb } from './merge-marketing-into-web.js';

let repoRoot: string;

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'merge-marketing-'));
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

beforeEach(async () => {
  repoRoot = await makeTempRoot();
  await fs.mkdir(path.join(repoRoot, 'apps/marketing/dist'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'apps/web/dist'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe('mergeMarketingIntoWeb', () => {
  it('copies a marketing top-level file into the web dist', async () => {
    await writeFile(path.join(repoRoot, 'apps/marketing/dist/welcome.html'), '<welcome>');
    await mergeMarketingIntoWeb({ repoRoot });
    const merged = await fs.readFile(path.join(repoRoot, 'apps/web/dist/welcome.html'), 'utf8');
    expect(merged).toBe('<welcome>');
  });

  it('preserves existing web dist files that are not also in marketing', async () => {
    await writeFile(path.join(repoRoot, 'apps/web/dist/chat.html'), '<chat>');
    await writeFile(path.join(repoRoot, 'apps/marketing/dist/welcome.html'), '<welcome>');
    await mergeMarketingIntoWeb({ repoRoot });
    const chat = await fs.readFile(path.join(repoRoot, 'apps/web/dist/chat.html'), 'utf8');
    expect(chat).toBe('<chat>');
  });

  it('overwrites web dist files when marketing has the same path', async () => {
    await writeFile(path.join(repoRoot, 'apps/web/dist/index.html'), '<from-web>');
    await writeFile(path.join(repoRoot, 'apps/marketing/dist/index.html'), '<from-marketing>');
    await mergeMarketingIntoWeb({ repoRoot });
    const merged = await fs.readFile(path.join(repoRoot, 'apps/web/dist/index.html'), 'utf8');
    expect(merged).toBe('<from-marketing>');
  });

  it('copies nested marketing directories recursively', async () => {
    await writeFile(path.join(repoRoot, 'apps/marketing/dist/blog/post/index.html'), '<post>');
    await mergeMarketingIntoWeb({ repoRoot });
    const merged = await fs.readFile(
      path.join(repoRoot, 'apps/web/dist/blog/post/index.html'),
      'utf8',
    );
    expect(merged).toBe('<post>');
  });

  it('reports the number of files copied', async () => {
    await writeFile(path.join(repoRoot, 'apps/marketing/dist/welcome.html'), '<welcome>');
    await writeFile(path.join(repoRoot, 'apps/marketing/dist/blog/index.html'), '<blog>');
    const result = await mergeMarketingIntoWeb({ repoRoot });
    expect(result.filesCopied).toBe(2);
  });

  it('returns absolute source and target paths', async () => {
    const result = await mergeMarketingIntoWeb({ repoRoot });
    expect(path.isAbsolute(result.sourceDir)).toBe(true);
    expect(path.isAbsolute(result.targetDir)).toBe(true);
  });

  it('throws when the marketing dist directory is missing', async () => {
    await fs.rm(path.join(repoRoot, 'apps/marketing/dist'), { recursive: true });
    await expect(mergeMarketingIntoWeb({ repoRoot })).rejects.toThrow(/marketing dist/i);
  });

  it('throws when the web dist directory is missing', async () => {
    await fs.rm(path.join(repoRoot, 'apps/web/dist'), { recursive: true });
    await expect(mergeMarketingIntoWeb({ repoRoot })).rejects.toThrow(/web dist/i);
  });

  it('throws when the marketing path points to a file (not a directory)', async () => {
    await fs.rm(path.join(repoRoot, 'apps/marketing/dist'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'apps/marketing/dist'), 'not a directory');
    await expect(mergeMarketingIntoWeb({ repoRoot })).rejects.toThrow(/not a directory/);
  });

  it('accepts custom source and target relative paths', async () => {
    await fs.mkdir(path.join(repoRoot, 'custom-source'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'custom-target'), { recursive: true });
    await writeFile(path.join(repoRoot, 'custom-source/file.txt'), 'hello');
    await mergeMarketingIntoWeb({
      repoRoot,
      sourceRelativePath: 'custom-source',
      targetRelativePath: 'custom-target',
    });
    const merged = await fs.readFile(path.join(repoRoot, 'custom-target/file.txt'), 'utf8');
    expect(merged).toBe('hello');
  });
});
