import { describe, expect, it } from 'vitest';

import { DemoVisibilityMessage } from './demo-bridge.ts';

describe('DemoVisibilityMessage', () => {
  it('accepts the on-screen message the embedding page sends', () => {
    expect(DemoVisibilityMessage.parse({ type: 'hb-demo-visibility', visible: true })).toEqual({
      type: 'hb-demo-visibility',
      visible: true,
    });
  });

  it('accepts the off-screen message the embedding page sends', () => {
    expect(DemoVisibilityMessage.parse({ type: 'hb-demo-visibility', visible: false })).toEqual({
      type: 'hb-demo-visibility',
      visible: false,
    });
  });

  it('rejects a message of another type', () => {
    expect(DemoVisibilityMessage.safeParse({ type: 'hb-demo-ready' }).success).toBe(false);
  });

  it('rejects a visibility message carrying no visible field', () => {
    expect(DemoVisibilityMessage.safeParse({ type: 'hb-demo-visibility' }).success).toBe(false);
  });

  it('rejects a non-boolean visible rather than coercing it', () => {
    expect(
      DemoVisibilityMessage.safeParse({ type: 'hb-demo-visibility', visible: 'yes' }).success
    ).toBe(false);
  });

  it('rejects a payload that is not an object', () => {
    expect(DemoVisibilityMessage.safeParse(null).success).toBe(false);
    expect(DemoVisibilityMessage.safeParse('hb-demo-visibility').success).toBe(false);
  });
});
