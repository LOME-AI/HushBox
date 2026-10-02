import { describe, expect, it } from 'vitest';
import { visibleNavItems } from './nav-visibility';

const ITEMS = [
  { to: '/sql', roles: ['operator'] as const },
  { to: '/growth', roles: ['operator', 'growth-viewer'] as const },
];

describe('visibleNavItems', () => {
  it('keeps the screens the role is listed on', () => {
    expect(visibleNavItems(ITEMS, 'growth-viewer')).toEqual([ITEMS[1]]);
  });

  it('keeps every screen an operator is listed on', () => {
    expect(visibleNavItems(ITEMS, 'operator')).toEqual(ITEMS);
  });

  it('draws nothing while the role is unknown', () => {
    expect(visibleNavItems(ITEMS, null)).toEqual([]);
  });
});
