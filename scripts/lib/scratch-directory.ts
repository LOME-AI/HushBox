import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs `body` against a fresh directory under the OS temp directory and removes
 * it however `body` ends. What a script stages there is its own working
 * material — an authenticated storage state, a build archive — so leaving it
 * behind both leaks whatever it holds and accumulates until a reboot.
 */
export async function withScratchDirectory<T>(
  prefix: string,
  body: (directory: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
