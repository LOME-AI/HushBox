import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { CONFIG_FILE, tasksIn } from '../../turbo-configs.js';
import { ADMIN_PREVIEW_PREFIX } from '../../../packages/shared/src/growth/admin-preview.js';
import {
  ADMIN_PREVIEW_ASSETS_DIR,
  MARKETING_PREVIEW_DIST,
  MARKETING_PREVIEW_OUT_DIR,
  copyAdminPreviewAssets,
  isSpeechEngineArtifact,
} from './admin-preview.js';
import { ORT_DIR, TTS_WORKER_SCAN_ENTRY } from './seam.js';

/** The stem the bundler names the speech worker's chunk after. */
const WORKER_STEM = path.basename(TTS_WORKER_SCAN_ENTRY, path.extname(TTS_WORKER_SCAN_ENTRY));

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-preview-'));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const absolute = path.join(repoRoot, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

/** A preview build carrying one page plus the speech engine every build emits. */
async function seedPreviewBuild(...pages: string[]): Promise<void> {
  for (const page of pages) {
    await writeFile(`${MARKETING_PREVIEW_DIST}/${page}/index.html`, `<p>${page}</p>`);
  }
  await writeFile(`${MARKETING_PREVIEW_DIST}/_astro/page.Bq1.js`, 'island()');
  await writeFile(`${MARKETING_PREVIEW_DIST}/${ORT_DIR}/ort-wasm-simd-threaded.jsep.mjs`, 'ort()');
  await writeFile(`${MARKETING_PREVIEW_DIST}/_astro/${WORKER_STEM}-B1Izhu0F.js`, 'speech()');
}

async function copiedFiles(): Promise<string[]> {
  const root = path.join(repoRoot, ADMIN_PREVIEW_ASSETS_DIR);
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .map((relative) => relative.split(path.sep).join('/'))
    .toSorted((left, right) => left.localeCompare(right));
}

describe('the framed preview copy', () => {
  it('lands under the prefix the admin origin serves it at', () => {
    expect(ADMIN_PREVIEW_ASSETS_DIR).toBe(`apps/admin/public/${ADMIN_PREVIEW_PREFIX}`);
  });

  it('reads the directory the preview build writes', () => {
    expect(MARKETING_PREVIEW_DIST).toBe(`apps/marketing/${MARKETING_PREVIEW_OUT_DIR}`);
  });

  it('copies every built page across', async () => {
    await seedPreviewBuild('welcome', 'blog/why-we-published-our-source-code');
    await copyAdminPreviewAssets(repoRoot);
    expect(await copiedFiles()).toContain('welcome/index.html');
    expect(await copiedFiles()).toContain('blog/why-we-published-our-source-code/index.html');
  });

  it('copies the page assets the pages reference', async () => {
    await seedPreviewBuild('welcome');
    await copyAdminPreviewAssets(repoRoot);
    expect(await copiedFiles()).toContain('_astro/page.Bq1.js');
  });

  it('omits the self-hosted speech runtime', async () => {
    await seedPreviewBuild('welcome');
    await copyAdminPreviewAssets(repoRoot);
    expect(await copiedFiles()).not.toContain(`${ORT_DIR}/ort-wasm-simd-threaded.jsep.mjs`);
  });

  it('omits the speech worker chunk', async () => {
    await seedPreviewBuild('welcome');
    await copyAdminPreviewAssets(repoRoot);
    expect(await copiedFiles()).not.toContain(`_astro/${WORKER_STEM}-B1Izhu0F.js`);
  });

  it('answers how many files it copied and how many it left behind', async () => {
    await seedPreviewBuild('welcome');
    const result = await copyAdminPreviewAssets(repoRoot);
    expect(result).toEqual({ copied: 2, omitted: 2 });
  });

  it('removes a file the previous copy left behind', async () => {
    await writeFile(`${ADMIN_PREVIEW_ASSETS_DIR}/retired/index.html`, '<p>gone</p>');
    await seedPreviewBuild('welcome');
    await copyAdminPreviewAssets(repoRoot);
    expect(await copiedFiles()).not.toContain('retired/index.html');
  });

  it('reports a filesystem error that is not a missing build', async () => {
    // The source path exists as a FILE, so reading it as a directory fails
    // with ENOTDIR — a real filesystem fault that must surface rather than be
    // reported as a build nobody ran.
    await writeFile(MARKETING_PREVIEW_DIST, 'not a directory');
    await expect(copyAdminPreviewAssets(repoRoot)).rejects.toThrow(/ENOTDIR/u);
  });

  it('refuses when no preview build is there to copy', async () => {
    await expect(copyAdminPreviewAssets(repoRoot)).rejects.toThrow(MARKETING_PREVIEW_DIST);
  });

  it('refuses a build carrying no speech-engine artifact, rather than filtering nothing', async () => {
    await writeFile(`${MARKETING_PREVIEW_DIST}/welcome/index.html`, '<p>welcome</p>');
    await expect(copyAdminPreviewAssets(repoRoot)).rejects.toThrow(/speech engine/u);
  });
});

describe('the speech-engine artifact rule', () => {
  it('names the self-hosted runtime directory', () => {
    expect(isSpeechEngineArtifact(`${ORT_DIR}/ort-wasm-simd-threaded.jsep.wasm`)).toBe(true);
  });

  it('names the hashed worker chunk', () => {
    expect(isSpeechEngineArtifact(`_astro/${WORKER_STEM}-B1Izhu0F.js`)).toBe(true);
  });

  it('leaves an ordinary page chunk alone', () => {
    expect(isSpeechEngineArtifact('_astro/welcome.CjK9.js')).toBe(false);
  });

  it('leaves a page whose directory merely starts with the runtime directory alone', () => {
    expect(isSpeechEngineArtifact(`${ORT_DIR}hodox/index.html`)).toBe(false);
  });

  it('leaves a chunk whose name merely starts with the worker stem alone', () => {
    expect(isSpeechEngineArtifact(`_astro/${WORKER_STEM}s.CjK9.js`)).toBe(false);
  });
});

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** The entries of a gitignore-syntax ignore file, comments and blanks dropped. */
function ignoreEntries(file: string): string[] {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Read strictly, never as JSONC: the scanner loads its own config with a reader that rejects a comment. */
const JscpdShape = z.object({ ignore: z.array(z.string()) });

/**
 * A gate that walks the filesystem, rather than a package or git's view of it,
 * meets a build's output wherever it lands inside a tracked source tree — the
 * formatter would rewrite the emitted files, the duplication scanner counts
 * their clones against first-party code. Each names the directory itself
 * rather than leaning on the ignore file beside the copy: both read the
 * repository's root ignore file and neither reads a nested one, and an
 * exemption resting on a tool's default reaches only the tools that happen to
 * share it.
 */
describe('the gates that walk the filesystem', () => {
  it('leaves the copy to the build that emitted it, in the formatter', () => {
    expect(ignoreEntries('.prettierignore')).toContain(`${ADMIN_PREVIEW_ASSETS_DIR}/`);
  });

  it('leaves the copy to the build that emitted it, in the duplication scanner', () => {
    const config = JscpdShape.parse(
      JSON.parse(readFileSync(path.join(REPO_ROOT, '.jscpd.json'), 'utf8'))
    );
    expect(config.ignore).toContain(`${ADMIN_PREVIEW_ASSETS_DIR}/**`);
  });
});

/**
 * The copied site is deliberately not an input to the admin build, and this
 * case is what fails if the glob comes back. The reason is recorded once,
 * above that build's `inputs` in `apps/admin/turbo.json`.
 */
describe('the copy inside the admin build', () => {
  it('is named by none of the globs that build is keyed on', () => {
    const packageRelative = ADMIN_PREVIEW_ASSETS_DIR.slice('apps/admin/'.length);
    const inputs = tasksIn(`apps/admin/${CONFIG_FILE}`)['build']?.inputs ?? [];
    expect(inputs.filter((glob) => glob.startsWith(packageRelative))).toEqual([]);
  });
});
