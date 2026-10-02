import { describe, expect, it } from 'vitest';

import { ADMIN_ROLES, isAdminRole } from './roles.ts';

describe('ADMIN_ROLES', () => {
  it('holds exactly the operator and the read-only growth viewer', () => {
    expect([...ADMIN_ROLES]).toEqual(['operator', 'growth-viewer']);
  });
});

describe('isAdminRole', () => {
  it.each(ADMIN_ROLES)('accepts %s', (role) => {
    expect(isAdminRole(role)).toBe(true);
  });

  it.each(['', 'Operator', 'admin', 'growth_viewer'])('rejects %s', (value) => {
    expect(isAdminRole(value)).toBe(false);
  });
});
