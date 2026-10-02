/**
 * `pnpm db:up` storage-readiness gate. After the compose services are up,
 * block until the stack's buckets actually exist (creating them via minio-setup
 * if any is missing) before any consumer — notably `pnpm db:seed` in CI —
 * issues a `storage.put`. Reuses the single readiness mechanism
 * (`ensureStackBucketsReady`); this file is only real-IO wiring, mirroring
 * ensure-stack-cli.ts.
 */
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { ensureStackBucketsReady } from './lib/stack/minio-bucket-ready.js';
import { createDockerBucketReadyDeps } from './lib/stack/minio-bucket-ready-docker.js';
import { stackBucketsFrom } from './lib/stack/stack-bucket.js';

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */
async function main(): Promise<void> {
  const deps = createDockerBucketReadyDeps(async (args, options) => {
    const result = await execa('docker', [...args], {
      cwd: process.cwd(),
      stdio: options.inheritStdio ? 'inherit' : 'pipe',
      env: process.env,
      reject: false,
    });
    return { exitCode: result.exitCode ?? 1 };
  }, stackBucketsFrom(process.env));
  await ensureStackBucketsReady(deps);
}

if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */
