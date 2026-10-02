/**
 * CLI wrapper around {@link bakeImage}; what a run costs and what it publishes
 * are stated there. The `push-mobile-emulator-image` job in
 * `.github/workflows/ci.yml` is what runs this with --push.
 */
import { bakeImage } from './lib/mobile/mobile-image.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';

interface BakeArgs {
  push: boolean;
}

export const COMMAND_LINE = {
  command: 'pnpm mobile:bake',
  summary: 'Builds the Android emulator image the mobile flows run against.',
  flags: [
    { flag: '--no-push', kind: 'boolean', summary: 'Keep the image local; wins over --push.' },
    { flag: '--push', kind: 'boolean', summary: 'Publish the image to the registry.' },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

export function parseArgs(
  args: readonly string[],
  write?: (text: string) => void
): BakeArgs | null {
  const parsed = readCommandLine(COMMAND_LINE, args, write);
  if (parsed === null) return null;
  // --no-push wins over --push so accidental "--push --no-push" combinations
  // never publish — local invocation is safer by default.
  return { push: parsed.flags['--push'] && !parsed.flags['--no-push'] };
}

export async function main(args: string[], write?: (text: string) => void): Promise<void> {
  const options = parseArgs(args, write);
  if (options === null) return;
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
