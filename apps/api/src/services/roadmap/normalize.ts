import type { LinearIssue, LinearProject, LinearRoadmapData } from '../linear/types.js';
import type { NormalizedEdge, NormalizedGraph, NormalizedNode } from './types.js';
import { LAYOUT_CONFIG } from './layout-config.js';

const TYPE_LABEL_FEATURE = 'type:feature';
const TYPE_LABEL_BUG = 'type:bug';

type PublicStatus = 'in_progress' | 'planned' | 'shipped';

/**
 * Compute a 12-char hex SHA-256 prefix of a Linear id. Used as the opaque
 * id on the public wire so the marketing API never exposes raw Linear ids
 * (which are workspace-scoped UUIDs that leak ticket-numbering pace).
 */
export async function hashLinearId(linearId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(linearId));
  return [...new Uint8Array(buf).slice(0, 6)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Bucket a Linear issue state type into the three customer-facing statuses
 * shown on the roadmap. Unstarted + backlog both fall under "planned" —
 * customers don't care about the internal distinction.
 */
function bucketIssueStatus(stateType: LinearIssue['stateType']): PublicStatus {
  if (stateType === 'started') return 'in_progress';
  if (stateType === 'completed') return 'shipped';
  return 'planned';
}

/**
 * Bucket a Linear project state type into the three customer-facing
 * statuses. Paused projects are surfaced as planned (we are still planning
 * to ship; they're just on hold). Backlog projects are also planned.
 */
function bucketProjectStatus(stateType: LinearProject['stateType']): PublicStatus {
  if (stateType === 'started') return 'in_progress';
  if (stateType === 'completed') return 'shipped';
  return 'planned';
}

function pickIssueType(labels: readonly string[]): 'feature' | 'bug' | null {
  if (labels.includes(TYPE_LABEL_FEATURE)) return 'feature';
  if (labels.includes(TYPE_LABEL_BUG)) return 'bug';
  return null;
}

/**
 * Walk the parent chain to find the depth-1 ancestor (the task that owns
 * this subtask). Returns null if the chain is already at depth 0 (the
 * issue is itself a top-level task).
 *
 * Linear allows arbitrary nesting; this clamps any depth ≥ 2 onto depth 1.
 */
function findDepth1Ancestor(issueId: string, issuesById: Map<string, LinearIssue>): string | null {
  const start = issuesById.get(issueId);
  if (start === undefined || start.parentId === null) return null;

  // Walk up; the depth-1 ancestor is the issue whose parent is null.
  let cursor: LinearIssue | undefined = issuesById.get(start.parentId);
  let safetyDepth = 0;
  while (cursor !== undefined && cursor.parentId !== null && safetyDepth < 64) {
    cursor = issuesById.get(cursor.parentId);
    safetyDepth += 1;
  }
  return cursor?.id ?? null;
}

/**
 * Normalize raw Linear data into the public node/edge graph. Steps:
 *
 * 1. Filter issues to features and bugs only (defensive — the GraphQL query
 *    already filters, but the mock fixture may contain other rows).
 * 2. Assign orphan issues (no Linear project) to a synthetic "Other" project.
 * 3. Build nodes for every project and issue with hashed opaque ids.
 * 4. Build hierarchy edges from issue parent ids and project containment.
 * 5. Build dependency edges from `blocks` / `blocked_by` relations. A
 *    `blocked_by` relation on issue X with related Y becomes an edge from
 *    Y → X (Y blocks X), so all dependency edges point from blocker to
 *    blocked. Duplicate edges are deduplicated.
 * 6. Flatten anything deeper than 2 levels onto its depth-1 ancestor.
 */
export async function normalizeRoadmap(data: LinearRoadmapData): Promise<NormalizedGraph> {
  const issuesById = new Map<string, LinearIssue>();
  for (const issue of data.issues) {
    issuesById.set(issue.id, issue);
  }

  const filteredIssues = data.issues.filter((issue) => pickIssueType(issue.labelNames) !== null);

  const orphanProjectId = LAYOUT_CONFIG.orphanProject.id;
  const orphanHashId = await hashLinearId(orphanProjectId);

  const usedProjectIds = new Set<string>();
  const usedOrphan = filteredIssues.some((issue) => issue.projectId === null);
  for (const issue of filteredIssues) {
    if (issue.projectId !== null) usedProjectIds.add(issue.projectId);
  }

  const projectsToRender: LinearProject[] = data.projects.filter((p) => usedProjectIds.has(p.id));
  if (usedOrphan) {
    projectsToRender.push({
      id: orphanProjectId,
      name: LAYOUT_CONFIG.orphanProject.name,
      color: LAYOUT_CONFIG.orphanProject.color,
      stateType: LAYOUT_CONFIG.orphanProject.stateType,
    });
  }

  const projectHashes = new Map<string, string>();
  for (const project of projectsToRender) {
    projectHashes.set(
      project.id,
      project.id === orphanProjectId ? orphanHashId : await hashLinearId(project.id)
    );
  }

  const issueHashes = new Map<string, string>();
  for (const issue of filteredIssues) {
    issueHashes.set(issue.id, await hashLinearId(issue.id));
  }

  const nodes: NormalizedNode[] = [];

  for (const project of projectsToRender) {
    const hashedId = projectHashes.get(project.id);
    if (hashedId === undefined) continue;
    nodes.push({
      id: hashedId,
      kind: 'project',
      parentId: null,
      title: project.name,
      status: bucketProjectStatus(project.stateType),
      type: null,
      color: project.color,
    });
  }

  for (const issue of filteredIssues) {
    const hashedId = issueHashes.get(issue.id);
    if (hashedId === undefined) continue;
    const projectId = issue.projectId ?? orphanProjectId;
    const projectHash = projectHashes.get(projectId) ?? orphanHashId;

    const ancestorId = findDepth1Ancestor(issue.id, issuesById);
    const isSubtask = ancestorId !== null;
    const parentHash = isSubtask ? (issueHashes.get(ancestorId) ?? projectHash) : projectHash;

    nodes.push({
      id: hashedId,
      kind: isSubtask ? 'subtask' : 'task',
      parentId: parentHash,
      title: issue.title,
      status: bucketIssueStatus(issue.stateType),
      type: pickIssueType(issue.labelNames),
      color: null,
    });
  }

  const edges: NormalizedEdge[] = [];
  for (const node of nodes) {
    if (node.parentId !== null) {
      edges.push({ source: node.parentId, target: node.id, kind: 'hierarchy' });
    }
  }

  // Build dependency edges, deduplicated. A `blocks` relation on X means
  // X blocks the related issue. A `blocked_by` relation on X means the
  // related issue blocks X. Both reduce to a single canonical direction:
  // edge.source blocks edge.target.
  const seenDeps = new Set<string>();
  const issueIdSet = new Set(filteredIssues.map((i) => i.id));
  for (const issue of filteredIssues) {
    for (const relation of issue.relations) {
      const otherId = relation.relatedIssueId;
      if (!issueIdSet.has(otherId)) continue;
      const otherHash = issueHashes.get(otherId);
      const selfHash = issueHashes.get(issue.id);
      if (otherHash === undefined || selfHash === undefined) continue;
      const sourceHash = relation.type === 'blocks' ? selfHash : otherHash;
      const targetHash = relation.type === 'blocks' ? otherHash : selfHash;
      if (sourceHash === targetHash) continue;
      const key = `${sourceHash}->${targetHash}`;
      if (seenDeps.has(key)) continue;
      seenDeps.add(key);
      edges.push({ source: sourceHash, target: targetHash, kind: 'dependency' });
    }
  }

  return { nodes, edges };
}
