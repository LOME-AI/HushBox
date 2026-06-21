export const PRIVILEGE_ORDER = ['owner', 'admin', 'write', 'read'] as const;

export const LINK_PRIVILEGE_OPTIONS = ['read', 'write'] as const;

export function groupByPrivilege<T extends { privilege: string }>(items: T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const privilege of PRIVILEGE_ORDER) {
    const matching = items.filter((item) => item.privilege === privilege);
    if (matching.length > 0) {
      grouped[privilege] = matching;
    }
  }
  return grouped;
}
