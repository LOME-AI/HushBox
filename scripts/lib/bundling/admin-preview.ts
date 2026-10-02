/**
 * The marketing site's second build, copied into the admin origin's static
 * assets so the click overlay can frame it.
 *
 * Every block of the public site's own header file denies cross-origin
 * framing, and the admin interface is a different origin, so the overlay
 * cannot reach into a frame of the real site at all. A copy served by the
 * admin origin can be framed and read, and the public site's headers are left
 * exactly as they are.
 *
 * The copy is the site minus the on-device speech engine. That engine is the
 * large majority of the built bytes, only a visitor's own click starts it, and
 * the admin origin declares itself free of it — so a read-aloud control used
 * inside the frame fails to load its engine there. Every file the rule below
 * does not name comes across, because the overlay reads the page the way a
 * visitor's browser lays it out.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ADMIN_PREVIEW_PREFIX } from '../../../packages/shared/src/growth/admin-preview.js';
import { ORT_DIR, TTS_WORKER_SCAN_ENTRY } from './seam.js';

/** Where the preview build writes, relative to the marketing package. */
export const MARKETING_PREVIEW_OUT_DIR = 'dist-preview';

/** The preview build's output, relative to the repository root. */
export const MARKETING_PREVIEW_DIST = `apps/marketing/${MARKETING_PREVIEW_OUT_DIR}`;

/**
 * Where the copy lands, relative to the repository root: the admin app's
 * static-asset directory, which its bundler copies into the dist the assets
 * Worker serves. The copy goes there rather than into the dist itself because
 * the bundler empties the dist on its way in, so anything written there first
 * is gone before the build finishes.
 */
export const ADMIN_PREVIEW_ASSETS_DIR = `apps/admin/public/${ADMIN_PREVIEW_PREFIX}`;

/**
 * The stem the bundler names the speech worker's emitted chunk after, taken
 * from the worker's own source file so a rename of that file carries here
 * rather than leaving this filtering nothing.
 */
const SPEECH_WORKER_STEM = path.basename(
  TTS_WORKER_SCAN_ENTRY,
  path.extname(TTS_WORKER_SCAN_ENTRY)
);

/**
 * Whether a built file belongs to the on-device speech engine: the self-hosted
 * runtime, which the build emits into its own directory, or the worker chunk,
 * which the bundler emits under the worker source's stem with a content hash
 * appended.
 */
export function isSpeechEngineArtifact(relativePath: string): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return relativePath.startsWith(`${ORT_DIR}/`) || name.startsWith(`${SPEECH_WORKER_STEM}-`);
}

/** Every regular file under `directory`, as paths relative to it, in a stable order. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .map((relative) => relative.split(path.sep).join('/'))
    .toSorted((left, right) => left.localeCompare(right));
}

interface AdminPreviewCopyResult {
  /** Files placed under the admin origin's preview prefix. */
  readonly copied: number;
  /** Files the speech-engine rule left behind. */
  readonly omitted: number;
}

/**
 * Replace the admin origin's copy of the site with the one the preview build
 * just emitted, answering what it moved and what it left.
 *
 * The destination is replaced rather than merged: a page deleted from the site
 * would otherwise stay reachable under the preview prefix forever, and an
 * overlay reading a page the site no longer has is worse than no preview.
 *
 * A build carrying no speech-engine artifact is refused instead of copied
 * whole. The filter exists to keep that engine off an origin that declares
 * itself free of it and to keep the copy small, and a filter that matches
 * nothing looks identical to a filter that had nothing to match — the bundle
 * guard would catch it on the admin origin, with none of this context to
 * explain it.
 */
export async function copyAdminPreviewAssets(repoRoot: string): Promise<AdminPreviewCopyResult> {
  const source = path.join(repoRoot, MARKETING_PREVIEW_DIST);
  let built: string[];
  try {
    built = await filesUnder(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `no preview build at ${MARKETING_PREVIEW_DIST} — build the marketing site's preview ` +
        `configuration before copying it into the admin origin`
    );
  }
  const omitted = built.filter((relative) => isSpeechEngineArtifact(relative));
  if (omitted.length === 0) {
    throw new Error(
      `the preview build at ${MARKETING_PREVIEW_DIST} carries no speech engine, so the rule ` +
        `that keeps it off the admin origin matched nothing — the engine moved, or the site ` +
        `stopped shipping it and this filter is now dead`
    );
  }
  const destination = path.join(repoRoot, ADMIN_PREVIEW_ASSETS_DIR);
  await fs.rm(destination, { recursive: true, force: true });
  const carried = built.filter((relative) => !isSpeechEngineArtifact(relative));
  for (const relative of carried) {
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, relative), target);
  }
  return { copied: carried.length, omitted: omitted.length };
}
