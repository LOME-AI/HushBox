import { describe, it, expect, vi } from 'vitest';
import { CHECKOUT_DIRECTORY } from '../../compose.js';
import { createDockerBucketReadyDeps, type DockerRunner } from './minio-bucket-ready-docker.js';

const BUCKET = 'hushbox-media-e2e';
const BUCKETS = [BUCKET, 'hushbox-backup-dev'];

describe('createDockerBucketReadyDeps', () => {
  it('probeBucket reports the bucket present when the probe command exits 0', async () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    const deps = createDockerBucketReadyDeps(run, BUCKETS);

    await expect(deps.probeBucket(BUCKET)).resolves.toBe(true);
  });

  it('probeBucket reports the bucket absent when the probe command exits non-zero', async () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 1 }));
    const deps = createDockerBucketReadyDeps(run, BUCKETS);

    await expect(deps.probeBucket(BUCKET)).resolves.toBe(false);
  });

  it('probeBucket checks the directory of the bucket it was given, without inheriting stdio', async () => {
    const run = vi.fn<DockerRunner>(() => Promise.resolve({ exitCode: 0 }));
    const deps = createDockerBucketReadyDeps(run, BUCKETS);

    await deps.probeBucket(BUCKET);

    expect(run).toHaveBeenCalledTimes(1);
    const [args, options] = run.mock.calls[0]!;
    expect(args).toEqual([
      'compose',
      '--project-directory',
      CHECKOUT_DIRECTORY,
      'exec',
      '-T',
      'minio',
      'sh',
      '-c',
      `test -d /data/${BUCKET}`,
    ]);
    expect(options.inheritStdio).toBe(false);
  });

  it('carries every bucket it was given through to the readiness gate', () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 0 }));

    expect(createDockerBucketReadyDeps(run, BUCKETS).buckets).toEqual(BUCKETS);
  });

  it('runBucketSetup runs the minio-setup service to completion with inherited stdio', async () => {
    const run = vi.fn<DockerRunner>(() => Promise.resolve({ exitCode: 0 }));
    const deps = createDockerBucketReadyDeps(run, BUCKETS);

    await deps.runBucketSetup();

    expect(run).toHaveBeenCalledTimes(1);
    const [args, options] = run.mock.calls[0]!;
    expect(args).toEqual([
      'compose',
      '--project-directory',
      CHECKOUT_DIRECTORY,
      'run',
      '--rm',
      'minio-setup',
    ]);
    expect(options.inheritStdio).toBe(true);
  });

  it('runBucketSetup fails loud when the setup command exits non-zero', async () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 2 }));
    const deps = createDockerBucketReadyDeps(run, BUCKETS);

    await expect(deps.runBucketSetup()).rejects.toThrow(
      '"docker compose run --rm minio-setup" exited 2 — bucket setup failed'
    );
  });
});
