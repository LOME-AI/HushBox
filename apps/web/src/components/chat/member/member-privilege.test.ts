import { describe, it, expect } from 'vitest';
import { MEMBER_PRIVILEGES } from '@hushbox/shared';
import {
  PRIVILEGE_DISPLAY_ORDER,
  LINK_PRIVILEGE_OPTIONS,
} from '@/components/chat/member/member-privilege';

describe('privilege constants', () => {
  it('orders privileges from highest to lowest', () => {
    expect(PRIVILEGE_DISPLAY_ORDER).toEqual(['owner', 'admin', 'write', 'read']);
  });

  it('derives its order by reversing the canonical shared MEMBER_PRIVILEGES', () => {
    expect(PRIVILEGE_DISPLAY_ORDER).toEqual(MEMBER_PRIVILEGES.toReversed());
  });

  it('limits link privileges to read and write', () => {
    expect(LINK_PRIVILEGE_OPTIONS).toEqual(['read', 'write']);
  });
});
