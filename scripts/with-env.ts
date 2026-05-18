import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export const ENV_FILES = ['apps/api/.dev.vars', '.env.development', '.env.scripts'] as const;

export const NODE_OPTION_FLAG = '--no-experimental-webstorage';

export function loadEnvironment(rootDir: string): void {
  for (const file of ENV_FILES) {
    dotenvConfig({ path: path.join(rootDir, file), override: true, quiet: true });
  }
}

export function appendNodeOption(existing: string | undefined, flag: string): string {
  return existing && existing.length > 0 ? `${existing} ${flag}` : flag;
}

export async function runCommand(
  command: string | undefined,
  args: readonly string[]
): Promise<number> {
  if (!command) {
    throw new Error(
      'with-env: missing command. Usage: tsx scripts/with-env.ts <command> [...args]'
    );
  }
  const result = await execa(command, [...args], { stdio: 'inherit', reject: false });
  return typeof result.exitCode === 'number' ? result.exitCode : 1;
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDir, '..');
    loadEnvironment(rootDir);
    process.env['NODE_OPTIONS'] = appendNodeOption(process.env['NODE_OPTIONS'], NODE_OPTION_FLAG);

    const [command, ...args] = process.argv.slice(2);
    return runCommand(command, args);
  });
}
/* v8 ignore stop */
