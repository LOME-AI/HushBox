import { describe, expect, it } from 'vitest';
import { backupRepositoryPrefix, backupSnapshotsPrefix } from './backup-repository.js';

describe('backupRepositoryPrefix', () => {
  it('closes a root with the separator the store matches prefixes on', () => {
    expect(backupRepositoryPrefix('repository')).toBe('repository/');
  });

  it('leaves an already-closed root alone', () => {
    expect(backupRepositoryPrefix('repository/')).toBe('repository/');
  });

  it('strips a leading separator, which S3 keys never carry', () => {
    expect(backupRepositoryPrefix('/repository/')).toBe('repository/');
  });

  it('keeps a nested root whole', () => {
    expect(backupRepositoryPrefix('hushbox/repository')).toBe('hushbox/repository/');
  });

  it('maps an empty root to the whole bucket', () => {
    expect(backupRepositoryPrefix('')).toBe('');
  });

  it('maps a root that is nothing but separators to the whole bucket', () => {
    expect(backupRepositoryPrefix('//')).toBe('');
  });
});

describe('backupSnapshotsPrefix', () => {
  it('addresses the snapshot objects inside the repository', () => {
    expect(backupSnapshotsPrefix('repository')).toBe('repository/snapshots/');
  });

  it('addresses them at the bucket root when the repository has no root', () => {
    expect(backupSnapshotsPrefix('')).toBe('snapshots/');
  });
});
