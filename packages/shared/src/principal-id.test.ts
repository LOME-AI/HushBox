import { describe, expect, it } from 'vitest';
import { senderPrincipalId, senderPrincipalSchema } from './principal-id.ts';
import type { SenderPrincipal } from './principal-id.ts';
import type { PaidRunIdentity } from './workflow/flow-executor.ts';

describe('senderPrincipalSchema', () => {
  it('parses a member sender', () => {
    expect(senderPrincipalSchema.parse({ kind: 'user', userId: 'u1' })).toEqual({
      kind: 'user',
      userId: 'u1',
    });
  });

  it('parses a link-guest sender', () => {
    expect(senderPrincipalSchema.parse({ kind: 'linkGuest', linkId: 'l1' })).toEqual({
      kind: 'linkGuest',
      linkId: 'l1',
    });
  });

  it('rejects a member sender whose userId is empty', () => {
    expect(senderPrincipalSchema.safeParse({ kind: 'user', userId: '' }).success).toBe(false);
  });

  it('rejects a link-guest sender whose linkId is empty', () => {
    expect(senderPrincipalSchema.safeParse({ kind: 'linkGuest', linkId: '' }).success).toBe(false);
  });

  it('rejects an unknown principal kind', () => {
    expect(senderPrincipalSchema.safeParse({ kind: 'robot', userId: 'u1' }).success).toBe(false);
  });

  it('rejects a member sender carrying a link-guest field instead of its userId', () => {
    expect(senderPrincipalSchema.safeParse({ kind: 'user', linkId: 'l1' }).success).toBe(false);
  });

  // The parse output IS the shared sender type: a schema whose inference drifted
  // from `SenderPrincipal` would fail here at compile time, which is the whole
  // reason the wire schema lives beside the type rather than in the DO protocol.
  it('produces the shared sender type', () => {
    const parsed: SenderPrincipal = senderPrincipalSchema.parse({ kind: 'user', userId: 'u1' });
    expect(senderPrincipalId(parsed)).toBe('u1');
  });
});

describe('senderPrincipalId', () => {
  it("returns a member sender's userId", () => {
    expect(senderPrincipalId({ kind: 'user', userId: 'u1' })).toBe('u1');
  });

  it("returns a link guest's linkId", () => {
    expect(senderPrincipalId({ kind: 'linkGuest', linkId: 'l1' })).toBe('l1');
  });

  it('reads the sender a run identity carries, which is the same one shape', () => {
    const identitySender: PaidRunIdentity['sender'] = { kind: 'linkGuest', linkId: 'l1' };
    const sender: SenderPrincipal = identitySender;
    expect(senderPrincipalId(sender)).toBe('l1');
  });
});
