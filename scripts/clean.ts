import { rm } from 'node:fs/promises';
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export async function removeDirectory(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

export async function runTurboClean(): Promise<void> {
  await execa('turbo', ['clean'], { stdio: 'inherit' });
}

export async function runClean(): Promise<void> {
  await runTurboClean();
  await removeDirectory('node_modules');
}

/* v8 ignore start -- CLI entry point exercised via root clean script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runClean());
}
/* v8 ignore stop */
