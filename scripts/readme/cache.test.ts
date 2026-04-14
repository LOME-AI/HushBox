import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashInputs, isUpToDate, withCache, writeHash } from './cache.js';

const FORCE_ENV = 'HB_FORCE_REGENERATE';

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

describe('hashInputs', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is deterministic for identical inputs', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'content A');
    writeFileSync(path.join(tmp, 'b.txt'), 'content B');
    const inputs = [path.join(tmp, 'a.txt'), path.join(tmp, 'b.txt')];
    expect(hashInputs(inputs)).toBe(hashInputs(inputs));
  });

  it('changes when content changes', () => {
    const file = path.join(tmp, 'a.txt');
    writeFileSync(file, 'v1');
    const before = hashInputs([file]);
    writeFileSync(file, 'v2');
    expect(hashInputs([file])).not.toBe(before);
  });

  it('changes when order changes', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    writeFileSync(path.join(tmp, 'b.txt'), 'b');
    const a = path.join(tmp, 'a.txt');
    const b = path.join(tmp, 'b.txt');
    expect(hashInputs([a, b])).not.toBe(hashInputs([b, a]));
  });

  it('changes when a file is added', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    writeFileSync(path.join(tmp, 'b.txt'), 'b');
    const one = hashInputs([path.join(tmp, 'a.txt')]);
    const two = hashInputs([path.join(tmp, 'a.txt'), path.join(tmp, 'b.txt')]);
    expect(one).not.toBe(two);
  });

  it('throws when an input file is missing', () => {
    expect(() => hashInputs([path.join(tmp, 'missing.txt')])).toThrow();
  });
});

describe('isUpToDate and writeHash', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when the hash file is missing', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    expect(isUpToDate(path.join(tmp, 'h'), [path.join(tmp, 'a.txt')])).toBe(false);
  });

  it('returns true after writeHash with unchanged inputs', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const hash = path.join(tmp, 'h');
    const inputs = [path.join(tmp, 'a.txt')];
    writeHash(hash, inputs);
    expect(isUpToDate(hash, inputs)).toBe(true);
  });

  it('returns false after an input is modified', () => {
    const file = path.join(tmp, 'a.txt');
    writeFileSync(file, 'v1');
    const hash = path.join(tmp, 'h');
    writeHash(hash, [file]);
    writeFileSync(file, 'v2');
    expect(isUpToDate(hash, [file])).toBe(false);
  });

  it('creates parent directories when the hash path is nested', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const hash = path.join(tmp, 'nested', 'deep', 'h');
    writeHash(hash, [path.join(tmp, 'a.txt')]);
    expect(existsSync(hash)).toBe(true);
    expect(isUpToDate(hash, [path.join(tmp, 'a.txt')])).toBe(true);
  });

  it('returns false when an expected output is missing', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const hash = path.join(tmp, 'h');
    const inputs = [path.join(tmp, 'a.txt')];
    const output = path.join(tmp, 'out.txt');
    writeFileSync(output, 'x');
    writeHash(hash, inputs);
    rmSync(output);
    expect(isUpToDate(hash, inputs, [output])).toBe(false);
  });

  it('returns true when all expected outputs exist', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const output = path.join(tmp, 'out.txt');
    writeFileSync(output, 'x');
    const hash = path.join(tmp, 'h');
    const inputs = [path.join(tmp, 'a.txt')];
    writeHash(hash, inputs);
    expect(isUpToDate(hash, inputs, [output])).toBe(true);
  });

  it('returns false when HB_FORCE_REGENERATE is set', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const hash = path.join(tmp, 'h');
    const inputs = [path.join(tmp, 'a.txt')];
    writeHash(hash, inputs);
    withEnv(FORCE_ENV, '1', () => {
      expect(isUpToDate(hash, inputs)).toBe(false);
    });
  });
});

describe('withCache', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs fn on first call and skips on second call with same inputs', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const fn = vi.fn();
    const options = {
      label: 'test',
      hashPath: path.join(tmp, 'h'),
      inputs: [path.join(tmp, 'a.txt')],
    };
    withCache(options, fn);
    withCache(options, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-runs fn after an input changes', () => {
    const file = path.join(tmp, 'a.txt');
    writeFileSync(file, 'v1');
    const fn = vi.fn();
    const options = {
      label: 'test',
      hashPath: path.join(tmp, 'h'),
      inputs: [file],
    };
    withCache(options, fn);
    writeFileSync(file, 'v2');
    withCache(options, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-runs fn when an expected output is deleted', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const output = path.join(tmp, 'out.txt');
    const fn = vi.fn(() => {
      writeFileSync(output, 'x');
    });
    const options = {
      label: 'test',
      hashPath: path.join(tmp, 'h'),
      inputs: [path.join(tmp, 'a.txt')],
      outputs: [output],
    };
    withCache(options, fn);
    rmSync(output);
    withCache(options, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('writes hash after successful fn', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const hash = path.join(tmp, 'h');
    withCache(
      { label: 'test', hashPath: hash, inputs: [path.join(tmp, 'a.txt')] },
      () => {},
    );
    expect(existsSync(hash)).toBe(true);
  });

  it('honors HB_FORCE_REGENERATE to always run fn', () => {
    writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const fn = vi.fn();
    const options = {
      label: 'test',
      hashPath: path.join(tmp, 'h'),
      inputs: [path.join(tmp, 'a.txt')],
    };
    withCache(options, fn);
    withEnv(FORCE_ENV, '1', () => {
      withCache(options, fn);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs fn without caching when an input file is missing', () => {
    const fn = vi.fn();
    withCache(
      {
        label: 'test',
        hashPath: path.join(tmp, 'h'),
        inputs: [path.join(tmp, 'does-not-exist')],
      },
      fn,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(tmp, 'h'))).toBe(false);
  });
});
