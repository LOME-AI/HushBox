import { describe, it, expect } from 'vitest';
import { TOTAL_FEE_RATE, formatFeePercent } from '@hushbox/shared';
import { Eraser, Eye, Fingerprint, HatGlasses, KeyRound, Lock, Sparkles } from '@hushbox/ui/icons';
import { TRUST_BLOCKS, VALUE_BLOCKS } from './word-blocks';

describe('VALUE_BLOCKS', () => {
  it('names the three values in order', () => {
    expect(VALUE_BLOCKS.map((block) => block.title)).toStrictEqual([
      'Privacy',
      'Innovation',
      'Transparency',
    ]);
  });

  it('draws the lock, the sparkles and the eye', () => {
    expect(VALUE_BLOCKS.map((block) => block.icon)).toStrictEqual([Lock, Sparkles, Eye]);
  });

  it('keeps the privacy text', () => {
    expect(VALUE_BLOCKS[0]?.text).toBe(
      "Your conversations stay yours. We work exclusively with AI providers that guarantee zero data retention. Privacy isn't a feature. It's the foundation."
    );
  });

  it('keeps the innovation text', () => {
    expect(VALUE_BLOCKS[1]?.text).toBe(
      "You shouldn't have to choose between powerful and principled. We build everything you need, as fast as you need it. We ship fast and we don't stop."
    );
  });

  it('states the transparency text with the computed fee', () => {
    expect(VALUE_BLOCKS[2]?.text).toBe(
      `Every single line of code is published. Our pricing is public. A ${formatFeePercent(TOTAL_FEE_RATE)} fee. No subscriptions. You only pay for what you use. You don't have to trust our promises. You can read our code.`
    );
  });

  it('no longer calls the code open source', () => {
    expect(VALUE_BLOCKS.map((block) => block.text).join(' ')).not.toMatch(/open source/i);
  });

  it('no longer breaks the fee down to the penny', () => {
    expect(VALUE_BLOCKS.map((block) => block.text).join(' ')).not.toContain(
      'broken down to the penny'
    );
  });
});

describe('TRUST_BLOCKS', () => {
  it('names the four verifiable facts in order', () => {
    expect(TRUST_BLOCKS.map((block) => block.title)).toStrictEqual([
      'Your Messages, Your Key',
      'Zero-Knowledge Password',
      'Zero Data Retention',
      'Anonymous',
    ]);
  });

  it('draws the key, the fingerprint, the eraser and the hat with glasses', () => {
    expect(TRUST_BLOCKS.map((block) => block.icon)).toStrictEqual([
      KeyRound,
      Fingerprint,
      Eraser,
      HatGlasses,
    ]);
  });

  it('keeps each fact its text', () => {
    expect(TRUST_BLOCKS.map((block) => block.text)).toStrictEqual([
      'Only your devices can read your conversations. Without your password, your data is inaccessible. Even to us.',
      "Your password never leaves your device. We use OPAQUE, the state of the art in password security. We couldn't see it if we tried.",
      'We work exclusively with AI providers that guarantee zero data retention. Your messages are processed and forgotten. Never stored. Never trained on.',
      "AI providers see HushBox. They don't see you. Your identity is never attached to your conversations.",
    ]);
  });
});
