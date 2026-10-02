import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '@/components/shell/admin-nav';
import { visibleNavItems } from '@/lib/nav-visibility';

/**
 * The Growth screen's own entry in the interface's navigation list. Asserted
 * from the growth feature's side because the entry exists for this screen:
 * without it the route is reachable only by typing the path, and the read-only
 * role signs in to a shell with nothing in it.
 */
describe('the Growth navigation entry', () => {
  it('names the Growth screen', () => {
    expect(NAV_ITEMS.filter((item) => item.to === '/growth')).toHaveLength(1);
  });

  it('is labelled Growth', () => {
    expect(NAV_ITEMS.find((item) => item.to === '/growth')?.label).toBe('Growth');
  });

  it('is drawn for the read-only role', () => {
    const visible = visibleNavItems(NAV_ITEMS, 'growth-viewer');
    expect(visible.map((item) => item.to)).toEqual(['/growth']);
  });

  it('is drawn for the operator alongside the other screens', () => {
    const visible = visibleNavItems(NAV_ITEMS, 'operator');
    expect(visible.map((item) => item.to)).toContain('/growth');
    expect(visible.length).toBeGreaterThan(1);
  });
});
