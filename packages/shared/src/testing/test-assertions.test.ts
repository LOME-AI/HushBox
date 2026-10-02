import { describe, it, expect } from 'vitest';

import { expectCompileTimeProof, expectExposes, pluginNamed } from './test-assertions.ts';

describe('expectExposes', () => {
  // A bare helper call is the whole body here on purpose: it is what proves the helper
  // reads as an assertion to `sonarjs/assertions-in-tests`, so a helper rewritten to throw
  // fails this package's lint rather than every caller's.
  it('refuses a zero-name call', () => {
    expectCompileTimeProof(() => {
      // @ts-expect-error zero names is refused by the parameter type
      expectExposes({ encode: (): string => 'a' });
    });
  });

  it('passes when every named property is a function', () => {
    const subject = { encode: (): string => 'a', decode: (): string => 'b' };

    expect(() => {
      expectExposes(subject, 'encode', 'decode');
    }).not.toThrow();
  });

  it('names the property that is absent', () => {
    const subject = { encode: (): string => 'a' };

    expect(() => {
      expectExposes(subject, 'decode');
    }).toThrow('expectExposes: "decode" is not exposed');
  });

  it('names the property that is exposed as a non-function', () => {
    const subject = { version: 3 };

    expect(() => {
      expectExposes(subject, 'version');
    }).toThrow('expectExposes: "version" is exposed as number, not a function');
  });

  it('checks every name, not only the first', () => {
    const subject = { encode: (): string => 'a' };

    expect(() => {
      expectExposes(subject, 'encode', 'decode');
    }).toThrow('expectExposes: "decode" is not exposed');
  });
});

describe('expectCompileTimeProof', () => {
  it('passes for a callable proof thunk', () => {
    expect(() => {
      expectCompileTimeProof(() => undefined);
    }).not.toThrow();
  });

  it('never invokes the thunk', () => {
    let invoked = false;

    expectCompileTimeProof(() => {
      invoked = true;
    });

    expect(invoked).toBe(false);
  });

  it('fails when the proof is not callable', () => {
    // The parameter type forbids a non-function, so only a cast reaches the runtime
    // guard, which exists for callers whose thunk arrives through untyped code.
    const notAThunk = undefined as unknown as () => unknown;

    expect(() => {
      expectCompileTimeProof(notAThunk);
    }).toThrow('expectCompileTimeProof: the proof thunk is not callable');
  });
});

describe('pluginNamed', () => {
  it('returns the option carrying the name', () => {
    const wanted = { name: 'wanted', apply: 'serve' };

    expect(pluginNamed([{ name: 'other', apply: 'build' }, wanted], 'wanted')).toBe(wanted);
  });

  it('returns undefined when no option carries the name', () => {
    expect(pluginNamed([{ name: 'other', apply: 'build' }], 'wanted')).toBeUndefined();
  });

  it('returns undefined for an unset option list', () => {
    const resolved: { plugins?: { name: string; apply: string }[] } = {};

    expect(pluginNamed(resolved.plugins, 'wanted')).toBeUndefined();
  });

  it('passes over a falsy placeholder', () => {
    const wanted = { name: 'wanted', apply: 'serve' };

    expect(pluginNamed([false, null, undefined, wanted], 'wanted')).toBe(wanted);
  });

  it('passes over a nested option list carrying the name', () => {
    const wanted = { name: 'wanted', apply: 'serve' };

    expect(pluginNamed([[{ name: 'wanted', apply: 'build' }], wanted], 'wanted')).toBe(wanted);
  });
});
