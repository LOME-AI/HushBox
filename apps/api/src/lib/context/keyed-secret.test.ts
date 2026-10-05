import { describe, expect, it } from 'vitest';
import { createKeyedSecret } from './keyed-secret.js';

const KEY = `key-${crypto.randomUUID()}`;

function freshSecret(): ReturnType<typeof createKeyedSecret<'PROBE_KEY_SECRET'>> {
  return createKeyedSecret({ entry: 'PROBE_KEY_SECRET', configurer: 'configureProbeKeySecret' });
}

describe('a write-once keyed secret', () => {
  it('reads the key the configure put in force', () => {
    const secret = freshSecret();
    secret.configure({ PROBE_KEY_SECRET: KEY });
    expect(secret.read()).toBe(KEY);
  });

  it('refuses a read before anything has configured it', () => {
    const secret = freshSecret();
    expect(() => secret.read()).toThrow(/not configured/);
  });

  it('names the configurer when a read finds no key', () => {
    const secret = freshSecret();
    expect(() => secret.read()).toThrow(
      new Error(
        'PROBE_KEY_SECRET is not configured: it reaches its module through ' +
          'configureProbeKeySecret, which must run before the key is used.'
      )
    );
  });

  it('accepts a repeat of the key already in force', () => {
    const secret = freshSecret();
    secret.configure({ PROBE_KEY_SECRET: KEY });
    secret.configure({ PROBE_KEY_SECRET: KEY });
    expect(secret.read()).toBe(KEY);
  });

  it('refuses a second key that disagrees with the one in force', () => {
    const secret = freshSecret();
    secret.configure({ PROBE_KEY_SECRET: KEY });
    expect(() => {
      secret.configure({ PROBE_KEY_SECRET: `${KEY}-other` });
    }).toThrow(/PROBE_KEY_SECRET disagrees/);
  });

  it('names neither key when two disagree', () => {
    const secret = freshSecret();
    secret.configure({ PROBE_KEY_SECRET: KEY });
    expect(() => {
      secret.configure({ PROBE_KEY_SECRET: `${KEY}-other` });
    }).toThrow(expect.objectContaining({ message: expect.not.stringContaining(KEY) }));
  });

  it('takes no key from an env that carries no entry', () => {
    const secret = freshSecret();
    secret.configure({ PROBE_KEY_SECRET: KEY });
    secret.configure({});
    expect(secret.read()).toBe(KEY);
  });

  it('takes no key from an env whose entry is empty', () => {
    const secret = freshSecret();
    secret.configure({ PROBE_KEY_SECRET: KEY });
    secret.configure({ PROBE_KEY_SECRET: '' });
    expect(secret.read()).toBe(KEY);
  });

  it('fails fast naming the entry when it is absent', () => {
    const secret = freshSecret();
    expect(() => {
      secret.configure({});
    }).toThrow(/PROBE_KEY_SECRET is missing/);
  });

  it('fails fast naming the entry when it is empty', () => {
    const secret = freshSecret();
    expect(() => {
      secret.configure({ PROBE_KEY_SECRET: '' });
    }).toThrow(/PROBE_KEY_SECRET is missing/);
  });

  it('keeps each secret apart from every other', () => {
    const first = freshSecret();
    const second = freshSecret();
    first.configure({ PROBE_KEY_SECRET: KEY });
    expect(() => second.read()).toThrow(/not configured/);
  });
});
