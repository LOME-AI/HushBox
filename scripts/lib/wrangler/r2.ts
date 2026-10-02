import { wranglerPersistPath } from '../../wrangler-dev.js';
import type { StackMode } from '../stack/port-plan.js';

/**
 * Which R2 an object goes to: the production bucket, or the local simulator of
 * one stack.
 */
export type R2Target = 'remote' | StackMode;

/**
 * `wrangler r2 object put` addressed at one store — the single spelling of that
 * argv in this repository, because every caller of it faces the same two
 * silences. wrangler takes local mode when neither `--local` nor `--remote` is
 * given, and a local write with no `--persist-to` lands in one directory shared
 * by every process of this checkout: an object written there is readable only
 * by whichever stack took the default, and nothing reports either choice.
 */
export function r2PutArgs(objectPath: string, filePath: string, target: R2Target): string[] {
  const store =
    target === 'remote' ? ['--remote'] : ['--local', '--persist-to', wranglerPersistPath(target)];
  return ['r2', 'object', 'put', objectPath, '--file', filePath, ...store];
}
