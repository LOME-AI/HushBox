import open from 'open';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export function buildUrl(prefix: string, envName: string): string {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`open-url: env var ${envName} is not set`);
  }
  return prefix + value;
}

export async function openUrl(prefix: string, envName: string): Promise<void> {
  await open(buildUrl(prefix, envName));
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const [prefix, envName] = process.argv.slice(2);
    if (!prefix || !envName) {
      throw new Error('Usage: tsx scripts/open-url.ts <url-prefix> <env-var-name>');
    }
    await openUrl(prefix, envName);
  });
}
/* v8 ignore stop */
