import { describe, expect, it } from 'vitest';
import {
  adminAdmittedActors,
  adminOperatorEmails,
  parseAdminActorAllowlist,
  parseAdminRoleMap,
} from './admin-allowlist.js';

describe('parseAdminActorAllowlist', () => {
  it('splits on commas, trims, and lowercases every entry', () => {
    expect(parseAdminActorAllowlist(' Admin@hushbox.test , OPS@hushbox.test ')).toEqual(
      new Set(['admin@hushbox.test', 'ops@hushbox.test'])
    );
  });

  it('drops empty entries left by stray separators', () => {
    expect(parseAdminActorAllowlist('admin@hushbox.test,, ,')).toEqual(
      new Set(['admin@hushbox.test'])
    );
  });

  it('collapses entries differing only by case or padding into one actor', () => {
    expect(parseAdminActorAllowlist('admin@hushbox.test, ADMIN@hushbox.test').size).toBe(1);
  });

  it('yields an empty set for an unset value, leaving the refusal to the caller', () => {
    expect(parseAdminActorAllowlist()).toEqual(new Set());
  });

  it('yields an empty set for a value that is only separators and blanks', () => {
    expect(parseAdminActorAllowlist(' , ')).toEqual(new Set());
  });
});

describe('parseAdminRoleMap', () => {
  it('reads email=role pairs, trimming and lowercasing the email', () => {
    expect(
      parseAdminRoleMap(' Admin@hushbox.test = operator , viewer@hushbox.test=growth-viewer ')
    ).toEqual(
      new Map([
        ['admin@hushbox.test', 'operator'],
        ['viewer@hushbox.test', 'growth-viewer'],
      ])
    );
  });

  it('drops an entry naming a role the closed set does not carry', () => {
    expect(parseAdminRoleMap('admin@hushbox.test=auditor')).toEqual(new Map());
  });

  it('drops an entry that names no role at all', () => {
    expect(parseAdminRoleMap('admin@hushbox.test')).toEqual(new Map());
  });

  it('drops empty entries left by stray separators', () => {
    expect(parseAdminRoleMap('admin@hushbox.test=operator,, ,')).toEqual(
      new Map([['admin@hushbox.test', 'operator']])
    );
  });

  it('yields an empty map for an unset value, leaving the refusal to the caller', () => {
    expect(parseAdminRoleMap()).toEqual(new Map());
  });
});

describe('adminOperatorEmails', () => {
  it('keeps only the operators, so a viewer receives no operational mail', () => {
    expect(
      adminOperatorEmails(
        parseAdminRoleMap('admin@hushbox.test=operator,viewer@hushbox.test=growth-viewer')
      )
    ).toEqual(['admin@hushbox.test']);
  });

  it('yields an empty list when the map holds no operator', () => {
    expect(adminOperatorEmails(parseAdminRoleMap('viewer@hushbox.test=growth-viewer'))).toEqual([]);
  });
});

describe('adminAdmittedActors', () => {
  it('keeps an address the allowlist carries and the role map gives a role', () => {
    expect(
      adminAdmittedActors(
        parseAdminActorAllowlist('admin@hushbox.test,viewer@hushbox.test'),
        parseAdminRoleMap('admin@hushbox.test=operator,viewer@hushbox.test=growth-viewer')
      )
    ).toEqual(new Set(['admin@hushbox.test', 'viewer@hushbox.test']));
  });

  it('drops an address the role map has no entry for, which the wall refuses as roleless', () => {
    expect(
      adminAdmittedActors(
        parseAdminActorAllowlist('admin@hushbox.test,unmapped@hushbox.test'),
        parseAdminRoleMap('admin@hushbox.test=operator')
      )
    ).toEqual(new Set(['admin@hushbox.test']));
  });

  it('drops an address the allowlist omits, which the wall refuses before reading a role', () => {
    expect(
      adminAdmittedActors(
        parseAdminActorAllowlist('admin@hushbox.test'),
        parseAdminRoleMap('admin@hushbox.test=operator,viewer@hushbox.test=growth-viewer')
      )
    ).toEqual(new Set(['admin@hushbox.test']));
  });

  it('yields an empty set when either binding is unset, so nobody is expected', () => {
    expect(adminAdmittedActors(parseAdminActorAllowlist(), parseAdminRoleMap())).toEqual(new Set());
  });
});
