import { expectCompileTimeProof, expectExposes } from '@hushbox/shared/test-assertions';

it('exposes the codec', () => {
  expectExposes(barrel, 'encode', 'decode');
});

it('refuses a widened tag', () => {
  // @ts-expect-error the tag is not assignable
  expectCompileTimeProof(() => zodFor('nope'));
});
