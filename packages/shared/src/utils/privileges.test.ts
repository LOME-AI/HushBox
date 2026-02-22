import { describe, it, expect } from 'vitest';
import {
  getPrivilegeLevel,
  canRemoveMember,
  canAddMembers,
  canManageLinks,
  canSendMessages,
  canChangePrivilege,
  isOwner,
} from './privileges.js';

describe('getPrivilegeLevel', () => {
  it('returns 0 for read', () => {
    expect(getPrivilegeLevel('read')).toBe(0);
  });

  it('returns 1 for write', () => {
    expect(getPrivilegeLevel('write')).toBe(1);
  });

  it('returns 2 for admin', () => {
    expect(getPrivilegeLevel('admin')).toBe(2);
  });

  it('returns 3 for owner', () => {
    expect(getPrivilegeLevel('owner')).toBe(3);
  });

  it('returns -1 for unknown string', () => {
    expect(getPrivilegeLevel('superadmin')).toBe(-1);
  });
});

describe('canRemoveMember', () => {
  it('owner can remove admin', () => {
    expect(canRemoveMember('owner', 'admin')).toBe(true);
  });

  it('owner can remove write', () => {
    expect(canRemoveMember('owner', 'write')).toBe(true);
  });

  it('owner can remove read', () => {
    expect(canRemoveMember('owner', 'read')).toBe(true);
  });

  it('admin can remove write', () => {
    expect(canRemoveMember('admin', 'write')).toBe(true);
  });

  it('admin can remove read', () => {
    expect(canRemoveMember('admin', 'read')).toBe(true);
  });

  it('admin cannot remove admin', () => {
    expect(canRemoveMember('admin', 'admin')).toBe(false);
  });

  it('admin cannot remove owner', () => {
    expect(canRemoveMember('admin', 'owner')).toBe(false);
  });

  it('write cannot remove anyone', () => {
    expect(canRemoveMember('write', 'read')).toBe(false);
    expect(canRemoveMember('write', 'write')).toBe(false);
    expect(canRemoveMember('write', 'admin')).toBe(false);
    expect(canRemoveMember('write', 'owner')).toBe(false);
  });

  it('read cannot remove anyone', () => {
    expect(canRemoveMember('read', 'read')).toBe(false);
    expect(canRemoveMember('read', 'write')).toBe(false);
    expect(canRemoveMember('read', 'admin')).toBe(false);
    expect(canRemoveMember('read', 'owner')).toBe(false);
  });
});

describe('canAddMembers', () => {
  it('owner can add', () => {
    expect(canAddMembers('owner')).toBe(true);
  });

  it('admin can add', () => {
    expect(canAddMembers('admin')).toBe(true);
  });

  it('write cannot add', () => {
    expect(canAddMembers('write')).toBe(false);
  });

  it('read cannot add', () => {
    expect(canAddMembers('read')).toBe(false);
  });
});

describe('canManageLinks', () => {
  it('owner can manage', () => {
    expect(canManageLinks('owner')).toBe(true);
  });

  it('admin can manage', () => {
    expect(canManageLinks('admin')).toBe(true);
  });

  it('write cannot manage', () => {
    expect(canManageLinks('write')).toBe(false);
  });

  it('read cannot manage', () => {
    expect(canManageLinks('read')).toBe(false);
  });
});

describe('canSendMessages', () => {
  it('owner can send', () => {
    expect(canSendMessages('owner')).toBe(true);
  });

  it('admin can send', () => {
    expect(canSendMessages('admin')).toBe(true);
  });

  it('write can send', () => {
    expect(canSendMessages('write')).toBe(true);
  });

  it('read cannot send', () => {
    expect(canSendMessages('read')).toBe(false);
  });
});

describe('canChangePrivilege', () => {
  it('owner can change admin to write', () => {
    expect(canChangePrivilege('owner', 'admin', 'write')).toBe(true);
  });

  it('owner can change admin to read', () => {
    expect(canChangePrivilege('owner', 'admin', 'read')).toBe(true);
  });

  it('owner can change write to read', () => {
    expect(canChangePrivilege('owner', 'write', 'read')).toBe(true);
  });

  it('owner can change read to write', () => {
    expect(canChangePrivilege('owner', 'read', 'write')).toBe(true);
  });

  it('owner can change write to admin', () => {
    expect(canChangePrivilege('owner', 'write', 'admin')).toBe(true);
  });

  it('admin can change write to read', () => {
    expect(canChangePrivilege('admin', 'write', 'read')).toBe(true);
  });

  it('admin can change read to write', () => {
    expect(canChangePrivilege('admin', 'read', 'write')).toBe(true);
  });

  it('admin cannot change another admin', () => {
    expect(canChangePrivilege('admin', 'admin', 'write')).toBe(false);
  });

  it('admin cannot promote to admin', () => {
    expect(canChangePrivilege('admin', 'write', 'admin')).toBe(false);
  });

  it('admin cannot change owner', () => {
    expect(canChangePrivilege('admin', 'owner', 'admin')).toBe(false);
  });

  it('write cannot change anyone', () => {
    expect(canChangePrivilege('write', 'read', 'write')).toBe(false);
    expect(canChangePrivilege('write', 'write', 'read')).toBe(false);
  });

  it('read cannot change anyone', () => {
    expect(canChangePrivilege('read', 'read', 'write')).toBe(false);
    expect(canChangePrivilege('read', 'write', 'read')).toBe(false);
  });
});

describe('isOwner', () => {
  it('returns true for owner', () => {
    expect(isOwner('owner')).toBe(true);
  });

  it('returns false for admin', () => {
    expect(isOwner('admin')).toBe(false);
  });

  it('returns false for write', () => {
    expect(isOwner('write')).toBe(false);
  });

  it('returns false for read', () => {
    expect(isOwner('read')).toBe(false);
  });
});
