import { MEMBER_PRIVILEGES } from '@hushbox/shared';

/**
 * Privileges ordered highest→lowest, the order members and privilege choices are listed in, derived by
 * reversing the canonical low→high `MEMBER_PRIVILEGES`. The shared constant is the
 * single source of the privilege set and its ordering.
 */
export const PRIVILEGE_DISPLAY_ORDER = MEMBER_PRIVILEGES.toReversed();

export const LINK_PRIVILEGE_OPTIONS = ['read', 'write'] as const;
