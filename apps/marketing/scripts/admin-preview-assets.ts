import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyAdminPreviewAssets } from '../../../scripts/lib/bundling/admin-preview.js';
import { isMainModule } from '../../../scripts/lib/cli/is-main.js';
import { runMain } from '../../../scripts/lib/cli/run-main.js';

/**
 * Puts the preview build this package just emitted into the admin origin's
 * static assets, so the admin bundler carries it into the dist the assets
 * Worker serves. The move itself, and why the copy exists at all, live beside
 * the copy function.
 */

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(CURRENT_DIR, '../../..');

/* v8 ignore start -- the CLI entry, run by the copy task; the test imports this module instead of executing it */
if (isMainModule(import.meta.url)) {
  await runMain(() => copyAdminPreviewAssets(REPO_ROOT));
}
/* v8 ignore stop */
