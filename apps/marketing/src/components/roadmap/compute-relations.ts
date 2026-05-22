import type { RoadmapResponse } from '@hushbox/shared';

/**
 * Given a focused node id, compute the set of node ids that should
 * stay bright when Sonar Ping fires. Includes the focused node itself,
 * its ancestors (project, parent task), its descendants (sub-issues),
 * and any dependency endpoints touching it.
 */
export function computeRelatedSet(data: RoadmapResponse, focusedId: string): ReadonlySet<string> {
  const related = new Set<string>([focusedId]);
  const nodeById = new Map(data.graph.nodes.map((node) => [node.id, node]));

  // Walk up parent chain to the project.
  let cursor: string | null = focusedId;
  while (cursor !== null) {
    const node = nodeById.get(cursor);
    if (node === undefined) break;
    related.add(node.id);
    cursor = node.parentId;
  }

  // Walk down via hierarchy edges.
  const children = new Map<string, string[]>();
  for (const edge of data.graph.edges) {
    if (edge.kind !== 'hierarchy') continue;
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }
  const stack: string[] = [focusedId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const kids = children.get(id);
    if (kids === undefined) continue;
    for (const kid of kids) {
      if (related.has(kid)) continue;
      related.add(kid);
      stack.push(kid);
    }
  }

  // Dependencies (single-hop in both directions).
  for (const edge of data.graph.edges) {
    if (edge.kind !== 'dependency') continue;
    if (edge.source === focusedId) related.add(edge.target);
    if (edge.target === focusedId) related.add(edge.source);
  }

  return related;
}
