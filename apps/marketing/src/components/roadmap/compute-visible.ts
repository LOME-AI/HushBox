import type { RoadmapResponse } from '@hushbox/shared';
import type { FilterStatus, FilterType } from './use-filter-state';

/**
 * Compute the set of node ids that should be visible given the active
 * filters. A project is visible if any of its descendant tasks/subtasks
 * survives the type+status filter — keeping the constellation grouping
 * intact even when individual nodes get filtered out.
 */
export function computeVisible(
  data: RoadmapResponse,
  statuses: ReadonlySet<FilterStatus>,
  types: ReadonlySet<FilterType>
): ReadonlySet<string> {
  const visible = new Set<string>();
  for (const node of data.graph.nodes) {
    if (node.kind === 'project') continue;
    if (!statuses.has(node.status)) continue;
    if (node.type !== null && !types.has(node.type)) continue;
    visible.add(node.id);
  }

  // Promote any project whose subtree has at least one surviving node.
  const parentToChildren = new Map<string, string[]>();
  for (const node of data.graph.nodes) {
    if (node.parentId === null) continue;
    const list = parentToChildren.get(node.parentId) ?? [];
    list.push(node.id);
    parentToChildren.set(node.parentId, list);
  }

  const isLive = (id: string): boolean => {
    if (visible.has(id)) return true;
    const children = parentToChildren.get(id);
    if (children === undefined) return false;
    return children.some((childId) => isLive(childId));
  };

  for (const node of data.graph.nodes) {
    if (node.kind !== 'project') continue;
    if (isLive(node.id)) visible.add(node.id);
  }

  return visible;
}
