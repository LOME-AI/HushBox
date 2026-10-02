/**
 * Stamps a built dist with the release it carries, and checks that stamp.
 *
 * `stamp` writes `build.json` into each named dist; the build job runs it
 * outside the turbo task, so a cache replay cannot carry a stale stamp. `check`
 * refuses a dist whose stamp names another version; the deploy job runs it on
 * the downloaded artifacts before anything publishes. The post-deploy probe
 * reads the same file back off each public origin through
 * {@link readBuildIdentity}, so the format has one reader and one writer.
 *
 *   pnpm tsx scripts/stamp-build-identity.ts stamp|check <dist>... (VERSION in the environment)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/** The file the stamp is written to, at the root of each dist. */
export const BUILD_IDENTITY_FILE = 'build.json';

const BuildIdentitySchema = z.strictObject({ version: z.string().min(1) });

/** Writes the stamp for `version` into the dist at `directory`. */
export function stampBuildIdentity(directory: string, version: string): void {
  if (version === '') throw new Error(`Refusing to stamp ${directory} with an empty version`);
  writeFileSync(path.join(directory, BUILD_IDENTITY_FILE), JSON.stringify({ version }));
}

/** The version a stamp's text names, or a refusal saying why it names none. */
export function readBuildIdentity(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`The build identity is not JSON: ${String(error)}`, { cause: error });
  }
  const identity = BuildIdentitySchema.safeParse(parsed);
  if (!identity.success) throw new Error('The build identity has an unexpected shape');
  return identity.data.version;
}

/** Refuses the dist at `directory` unless its stamp names `version`. */
export function checkBuildIdentity(directory: string, version: string): void {
  const stamped = readBuildIdentity(
    readFileSync(path.join(directory, BUILD_IDENTITY_FILE), 'utf8')
  );
  if (stamped !== version) {
    throw new Error(`${directory} is stamped ${stamped}, but this deploy is ${version}`);
  }
}

const MODES = {
  stamp: stampBuildIdentity,
  check: checkBuildIdentity,
} as const;

const isMode = (word: string | undefined): word is keyof typeof MODES =>
  word !== undefined && Object.hasOwn(MODES, word);

export function main(args: readonly string[], env: NodeJS.ProcessEnv): void {
  const [mode, ...directories] = args;
  if (!isMode(mode)) {
    throw new Error(`Usage: stamp-build-identity.ts stamp|check <dist>... (got "${String(mode)}")`);
  }
  if (directories.length === 0) throw new Error(`${mode} needs at least one dist`);
  const flag = directories.find((directory) => directory.startsWith('-'));
  if (flag !== undefined) throw new Error(`${flag} is not a dist; this command takes no flags`);
  const version = env['VERSION'];
  if (version === undefined || version === '') throw new Error('VERSION is required');
  for (const directory of directories) MODES[mode](directory, version);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const scriptPath = process.argv[1] ?? '';
const isDirectExecution =
  scriptPath.endsWith('stamp-build-identity.ts') || scriptPath.endsWith('stamp-build-identity.js');
if (isDirectExecution) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
/* v8 ignore stop */
