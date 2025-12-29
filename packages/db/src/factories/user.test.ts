import { describe, it, expect } from 'vitest';

import { userFactory } from './index';

describe('userFactory', () => {
  it('builds a complete user object', () => {
    const user = userFactory.build();

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(user.email).toContain('@');
    expect(user.name).toBeTruthy();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const user = userFactory.build({ name: 'Custom Name' });
    expect(user.name).toBe('Custom Name');
  });

  it('builds a list with unique IDs', () => {
    const userList = userFactory.buildList(3);
    expect(userList).toHaveLength(3);
    const ids = new Set(userList.map((u) => u.id));
    expect(ids.size).toBe(3);
  });
});
