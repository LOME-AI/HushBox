/**
 * A group is named by its members joined with `+`, which is the only structure
 * the format gives: `group` is free text, so a name that is not a member list
 * comes back as a single entry and simply resolves to no finding.
 */
export function groupPartners(group: string | null, selfId: string): readonly string[] {
  if (group === null) return [];
  return group
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== selfId);
}
