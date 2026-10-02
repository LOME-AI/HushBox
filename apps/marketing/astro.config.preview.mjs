import { defineConfig } from 'astro/config';

import { ADMIN_PREVIEW_PREFIX } from '../../packages/shared/src/growth/admin-preview.ts';
import { MARKETING_PREVIEW_OUT_DIR } from '../../scripts/lib/bundling/admin-preview.ts';

import siteConfig from './astro.config.mjs';

/**
 * The site built a second time, for the admin origin to serve and frame.
 *
 * It is the site configuration with two keys replaced — where the output lands
 * and what prefix its URLs carry — and nothing else, so the pages, the content
 * collections and the integrations this build reads are the site's own, and a
 * page the site grows needs no change here. A value stated here instead of
 * shared would be a second site configuration to keep in step.
 *
 * Which of those pages get published is decided by the build mode, which this
 * build derives from the stack the environment names exactly as the site build
 * does — no argument decides it, and none could: a mode handed to a build as a
 * pass-through reaches the task a request names, never this one, which runs as
 * a dependency of the admin origin's assets (`scripts/build-admin-bundle.ts`
 * records that mechanism at the call it matters to). So the framed copy holds
 * the pages the site holds under that same stack, draft posts included where
 * the stack publishes them.
 *
 * The build command is the package's own site build with this file named, so
 * both load a stack's generated env files through the same wrapper and the same
 * variable, and resolve whichever stack their caller names.
 *
 * An absolute path written in the site's own source is not rewritten by the
 * prefix: a `/blog` in markup stays `/blog`, so a link followed inside the
 * frame leaves the copy, and an island fetching `/blog-index.json` asks the
 * admin origin's root for a file that lives under the prefix. The overlay
 * reads the framed page rather than browsing it, and the built click names it
 * badges come from the same markup either way.
 */
export default defineConfig({
  ...siteConfig,
  base: `/${ADMIN_PREVIEW_PREFIX}`,
  outDir: MARKETING_PREVIEW_OUT_DIR,
});
