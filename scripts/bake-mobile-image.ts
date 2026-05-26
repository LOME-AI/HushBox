/**
 * CLI wrapper around bakeImage(). Used by the deploy workflow with --push
 * to publish a fresh content-hashed image to GHCR when the Dockerfile context
 * changes, and locally with --no-push (the default) for testing the bake flow
 * before opening a PR.
 */
import { bakeImage } from './lib/mobile-image.js';
import { isMainModule } from './lib/is-main.js';

export interface BakeArgs {
  push: boolean;
}

export function parseArgs(args: string[]): BakeArgs {
  const noPush = args.includes('--no-push');
  const push = args.includes('--push');
  // --no-push wins over --push so accidental "--push --no-push" combinations
  // never publish — local invocation is safer by default.
  return { push: push && !noPush };
}

export async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const tag = await bakeImage(options);
  console.log(`[bake-mobile-image] Done: ${tag}${options.push ? ' (pushed)' : ' (local only)'}`);
}

/* v8 ignore start */
if (isMainModule(import.meta.url)) {
  void (async () => {
    try {
      await main(process.argv.slice(2));
    } catch (error: unknown) {
      console.error('bake-mobile-image failed:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
