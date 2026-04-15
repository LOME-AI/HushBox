import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashInputs, isUpToDate, withCache, writeHash } from './cache.js';

const FORCE_ENV = 'HB_FORCE_REGENERATE';

function withEnv(key: string, value: string | undefined, function_: () => void): void {
  const original = process.env[key];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
  try {
    function_();
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = original;
  }
}

describe('hashInputs', () => {
  let temporary: string;
  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
  });
  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  it('is deterministic for identical inputs', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'content A');
    writeFileSync(path.join(temporary, 'b.txt'), 'content B');
    const inputs = [path.join(temporary, 'a.txt'), path.join(temporary, 'b.txt')];
    expect(hashInputs(inputs)).toBe(hashInputs(inputs));
  });

  it('changes when content changes', () => {
    const file = path.join(temporary, 'a.txt');
    writeFileSync(file, 'v1');
    const before = hashInputs([file]);
    writeFileSync(file, 'v2');
    expect(hashInputs([file])).not.toBe(before);
  });

  it('changes when order changes', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    writeFileSync(path.join(temporary, 'b.txt'), 'b');
    const a = path.join(temporary, 'a.txt');
    const b = path.join(temporary, 'b.txt');
    expect(hashInputs([a, b])).not.toBe(hashInputs([b, a]));
  });

  it('changes when a file is added', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    writeFileSync(path.join(temporary, 'b.txt'), 'b');
    const one = hashInputs([path.join(temporary, 'a.txt')]);
    const two = hashInputs([path.join(temporary, 'a.txt'), path.join(temporary, 'b.txt')]);
    expect(one).not.toBe(two);
  });

  it('throws when an input file is missing', () => {
    expect(() => hashInputs([path.join(temporary, 'missing.txt')])).toThrow();
  });
});

describe('isUpToDate and writeHash', () => {
  let temporary: string;
  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
  });
  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  it('returns false when the hash file is missing', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    expect(isUpToDate(path.join(temporary, 'h'), [path.join(temporary, 'a.txt')])).toBe(false);
  });

  it('returns true after writeHash with unchanged inputs', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const hash = path.join(temporary, 'h');
    const inputs = [path.join(temporary, 'a.txt')];
    writeHash(hash, inputs);
    expect(isUpToDate(hash, inputs)).toBe(true);
  });

  it('returns false after an input is modified', () => {
    const file = path.join(temporary, 'a.txt');
    writeFileSync(file, 'v1');
    const hash = path.join(temporary, 'h');
    writeHash(hash, [file]);
    writeFileSync(file, 'v2');
    expect(isUpToDate(hash, [file])).toBe(false);
  });

  it('creates parent directories when the hash path is nested', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const hash = path.join(temporary, 'nested', 'deep', 'h');
    writeHash(hash, [path.join(temporary, 'a.txt')]);
    expect(existsSync(hash)).toBe(true);
    expect(isUpToDate(hash, [path.join(temporary, 'a.txt')])).toBe(true);
  });

  it('returns false when an expected output is missing', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const hash = path.join(temporary, 'h');
    const inputs = [path.join(temporary, 'a.txt')];
    const output = path.join(temporary, 'out.txt');
    writeFileSync(output, 'x');
    writeHash(hash, inputs);
    rmSync(output);
    expect(isUpToDate(hash, inputs, [output])).toBe(false);
  });

  it('returns true when all expected outputs exist', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const output = path.join(temporary, 'out.txt');
    writeFileSync(output, 'x');
    const hash = path.join(temporary, 'h');
    const inputs = [path.join(temporary, 'a.txt')];
    writeHash(hash, inputs);
    expect(isUpToDate(hash, inputs, [output])).toBe(true);
  });

  it('returns false when HB_FORCE_REGENERATE is set', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const hash = path.join(temporary, 'h');
    const inputs = [path.join(temporary, 'a.txt')];
    writeHash(hash, inputs);
    withEnv(FORCE_ENV, '1', () => {
      expect(isUpToDate(hash, inputs)).toBe(false);
    });
  });
});

describe('withCache', () => {
  let temporary: string;
  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
  });
  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  it('runs fn on first call and skips on second call with same inputs', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const function_ = vi.fn();
    const options = {
      label: 'test',
      hashPath: path.join(temporary, 'h'),
      inputs: [path.join(temporary, 'a.txt')],
    };
    withCache(options, function_);
    withCache(options, function_);
    expect(function_).toHaveBeenCalledTimes(1);
  });

  it('re-runs fn after an input changes', () => {
    const file = path.join(temporary, 'a.txt');
    writeFileSync(file, 'v1');
    const function_ = vi.fn();
    const options = {
      label: 'test',
      hashPath: path.join(temporary, 'h'),
      inputs: [file],
    };
    withCache(options, function_);
    writeFileSync(file, 'v2');
    withCache(options, function_);
    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('re-runs fn when an expected output is deleted', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const output = path.join(temporary, 'out.txt');
    const function_ = vi.fn(() => {
      writeFileSync(output, 'x');
    });
    const options = {
      label: 'test',
      hashPath: path.join(temporary, 'h'),
      inputs: [path.join(temporary, 'a.txt')],
      outputs: [output],
    };
    withCache(options, function_);
    rmSync(output);
    withCache(options, function_);
    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('writes hash after successful fn', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const hash = path.join(temporary, 'h');
    withCache({ label: 'test', hashPath: hash, inputs: [path.join(temporary, 'a.txt')] }, () => {});
    expect(existsSync(hash)).toBe(true);
  });

  it('honors HB_FORCE_REGENERATE to always run fn', () => {
    writeFileSync(path.join(temporary, 'a.txt'), 'a');
    const function_ = vi.fn();
    const options = {
      label: 'test',
      hashPath: path.join(temporary, 'h'),
      inputs: [path.join(temporary, 'a.txt')],
    };
    withCache(options, function_);
    withEnv(FORCE_ENV, '1', () => {
      withCache(options, function_);
    });
    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('runs fn without caching when an input file is missing', () => {
    const function_ = vi.fn();
    withCache(
      {
        label: 'test',
        hashPath: path.join(temporary, 'h'),
        inputs: [path.join(temporary, 'does-not-exist')],
      },
      function_
    );
    expect(function_).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(temporary, 'h'))).toBe(false);
  });
});
